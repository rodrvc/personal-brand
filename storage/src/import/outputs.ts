import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { parse as parseYaml } from "yaml";

/** Where a brand's rendered outputs live, resolved the way the engine does (`profile.ts`). */
export interface OutputsRoot {
  /** Real path of `outputs.base_dir`; every read under it is confined by realpath to it. */
  real: string;
  /** True when it lies inside the brand folder (then the folder walk already reaches it). */
  inside: boolean;
  /** Subfolder for the reels (`outputs.reels`). */
  reels: string;
}

/** `outputs.<key>` from `config.local.yaml` over `config.yaml`; a missing or unreadable file counts as absent. */
function configured(dir: string, key: string): string | undefined {
  for (const file of ["config.local.yaml", "config.yaml"]) {
    try {
      const value = (parseYaml(readFileSync(join(dir, file), "utf-8")) as { outputs?: Record<string, unknown> } | null)?.outputs?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // absent or unreadable: the next source decides
    }
  }
  return undefined;
}

/** Whether `path` is `parent` or lies under it, by path arithmetic (no prefix tricks: `/a/bc` is not under `/a/b`). */
const within = (parent: string, path: string): boolean => {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * `BRAND_OUTPUTS_ROOT/<slug>` when set, else `outputs.base_dir` (default `outputs`, `~` expanded, relative to the
 * folder). `outputs` is null when there is nothing to read, with why: `notice` when a configured root does not exist yet
 * (informational), `unusable` when it cannot be read safely (`/`, an ancestor of the brand folder, which would import the
 * folder itself, or an `outputs.reels` that leaves the root). The caller reports `unusable` as left-behind data.
 */
export function resolveOutputs(dir: string, root: string, slug: string, env: NodeJS.ProcessEnv): { outputs: OutputsRoot | null; notice?: string; unusable?: string } {
  const fromEnv = env.BRAND_OUTPUTS_ROOT?.trim();
  const configuredBase = configured(dir, "base_dir");
  const expanded = (configuredBase ?? "outputs").startsWith("~") ? join(homedir(), (configuredBase ?? "outputs").slice(1).replace(/^\/+/, "")) : (configuredBase ?? "outputs");
  const base = fromEnv ? join(fromEnv, slug) : isAbsolute(expanded) ? expanded : join(dir, expanded);
  let real: string;
  try {
    real = realpathSync(base);
  } catch (error) {
    // Only a path that is not there is "missing"; any other failure (EACCES, ELOOP...) means data may be there and unreadable.
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return { outputs: null, unusable: `outputs root ${base} cannot be resolved (${(error as NodeJS.ErrnoException).code ?? "error"}): not read` };
    return { outputs: null, ...(fromEnv || configuredBase ? { notice: `outputs root ${base} does not exist` } : {}) };
  }
  if (real === sep || (real !== root && within(real, root))) return { outputs: null, unusable: `outputs root ${real} is "/" or an ancestor of the brand folder: not read` };
  const reels = configured(dir, "reels") ?? "reels";
  if (isAbsolute(reels) || reels.split(/[\\/]/).includes("..")) return { outputs: null, unusable: `outputs.reels "${reels}" leaves the outputs root: not read` };
  return { outputs: { real, inside: within(root, real), reels } };
}
