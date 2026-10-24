import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { parse as parseYaml, YAMLParseError } from "yaml";

/** Prefix of the report labels of files under the outputs root (`@outputs/<path>`); one constant, so no filter drifts from a label. */
export const OUTPUTS_LABEL = "@outputs/";

/** Where a brand's rendered outputs live, resolved the way the engine does (`profile.ts`). */
export interface OutputsRoot {
  /** Real path of `outputs.base_dir`; every read under it is confined by realpath to it. */
  real: string;
  /** True when it lies inside the brand folder (then the folder walk already reaches it). */
  inside: boolean;
  /** Subfolders for the editor's exports and the reels (`outputs.editor`, `outputs.reels`). */
  editor: string;
  reels: string;
}

/** Files that make a sibling folder a brand folder (the ones the importer reads), for the "inside another brand" rule. */
const BRAND_FILES = ["brand.json", "brand.yaml", "profile.md"];

/** `$HOME` the way `homedir()` reads it, with the environment given to the CLI taking precedence (so a test can fake it). */
const homeOf = (env: NodeJS.ProcessEnv) => env.HOME?.trim() || homedir();

/**
 * The `outputs` section of `config.local.yaml` over `config.yaml`, key by key. A file that is absent counts as absent; one that
 * exists but cannot be read or parsed leaves the outputs root unknown (`problem`): guessing the default could read the wrong folder.
 */
function readOutputsConfig(dir: string): { config: Record<string, string>; problem?: string } {
  const merged: Record<string, string> = {};
  let problem: string | undefined;
  for (const file of ["config.yaml", "config.local.yaml"]) {
    try {
      const section = (parseYaml(readFileSync(join(dir, file), "utf-8")) as { outputs?: Record<string, unknown> } | null)?.outputs;
      for (const [key, value] of Object.entries(section ?? {})) if (typeof value === "string" && value.trim()) merged[key] = value.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") problem ??= `${file} ${error instanceof YAMLParseError ? "could not be parsed" : "could not be read"}: outputs root unknown`;
    }
  }
  return { config: merged, problem };
}

/** Whether `path` is `parent` or lies under it, by path arithmetic (no prefix tricks: `/a/bc` is not under `/a/b`). */
const within = (parent: string, path: string): boolean => {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * Why an outputs root is too broad to read (null when it is fine): it is the home directory or holds it, is or holds the folder that holds the
 * brand folders (as given and as resolved: a linked brand lives elsewhere), or holds another brand's folder (an entry next to the
 * brand folder), or lies inside another brand's folder. A root that is merely the brand folder itself, or lies inside it, is fine.
 * A root shared by several brands (one folder holding each brand's outputs) cannot be told apart from any other folder and is not detected.
 */
function tooBroad(real: string, dir: string, root: string, env: NodeJS.ProcessEnv): string | null {
  const parents = new Set([dirname(dir), dirname(root)]);
  const others = [...parents].flatMap((parent) => {
    try {
      return readdirSync(parent).map((name) => realOrNull(join(parent, name)));
    } catch {
      return [];
    }
  });
  const named = [...parents, homeOf(env), realOrNull(homeOf(env))].filter((p): p is string => !!p);
  if (named.some((folder) => within(real, folder))) return "is the home directory or holds it, or is or holds the folder of the brands";
  const sibling = others.filter((folder): folder is string => !!folder && folder !== root && folder !== dir);
  if (sibling.some((folder) => folder !== real && within(real, folder))) return "holds another brand's folder";
  if (sibling.some((folder) => within(folder, real) && BRAND_FILES.some((f) => existsSync(join(folder, f))))) return "lies inside another brand's folder";
  return null;
}

/**
 * `BRAND_OUTPUTS_ROOT/<slug>` when set, else `outputs.base_dir` (default `outputs`, `~` expanded, relative to the
 * folder). `outputs` is null when there is nothing to read, with why: a `notice` when a configured root does not exist yet
 * (informational), `unusable` when it cannot be read safely (`/`, an ancestor of the brand folder, which would import the
 * folder itself, `$HOME` or a folder that holds the home, the brand folders or another brand's folder, or an `outputs.reels` that
 * leaves the root, or a config file that cannot be read). The caller reports `unusable` as left-behind data; a missing root is a `notice`.
 */
export function resolveOutputs(dir: string, root: string, slug: string, env: NodeJS.ProcessEnv, notices: string[]): { outputs: OutputsRoot | null; unusable?: string } {
  const fromEnv = env.BRAND_OUTPUTS_ROOT?.trim();
  const { config, problem } = readOutputsConfig(dir);
  if (problem) return { outputs: null, unusable: problem };
  const baseDir = config.base_dir ?? "outputs";
  const expanded = baseDir.startsWith("~") ? join(homeOf(env), baseDir.slice(1).replace(/^\/+/, "")) : baseDir;
  const base = fromEnv ? join(fromEnv, slug) : isAbsolute(expanded) ? expanded : join(dir, expanded);
  let real: string;
  try {
    real = realpathSync(base);
  } catch (error) {
    // Only a path that is not there is "missing"; any other failure (EACCES, ELOOP...) means data may be there and unreadable.
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return { outputs: null, unusable: `outputs root ${base} cannot be resolved (${(error as NodeJS.ErrnoException).code ?? "error"}): not read` };
    if (fromEnv || config.base_dir) notices.push(`outputs root ${base} does not exist`);
    return { outputs: null };
  }
  if (real === sep || (real !== root && within(real, root))) return { outputs: null, unusable: `outputs root ${real} is "/" or an ancestor of the brand folder: not read` };
  const broad = tooBroad(real, dir, root, env);
  if (broad) return { outputs: null, unusable: `outputs root ${real} ${broad}: not read` };
  const reels = config.reels ?? "reels";
  if (isAbsolute(reels) || reels.split(/[\\/]/).includes("..")) return { outputs: null, unusable: `outputs.reels "${reels}" leaves the outputs root: not read` };
  return { outputs: { real, inside: within(root, real), editor: config.editor ?? "editor", reels } };
}
