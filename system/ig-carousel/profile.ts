import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Absolute path to a profile's folder.
 *
 * The root defaults to `<repo>/profiles` but `BRAND_PROFILES_DIR` moves it
 * anywhere — the same "this lives outside the repo, configured per machine"
 * escape hatch that `outputs.base_dir` already provides for generated files.
 *
 * It exists for the same reason: a real profile is business data, and this
 * repo is public. Keeping profiles under the repo tree forces every user to
 * commit their own brand alongside a generic engine, which is the exact
 * mistake this separation is meant to prevent. Only the fictional
 * `profiles/example*` profiles belong in the tree.
 *
 * `~` is expanded as in `base_dir`; a relative value resolves against the
 * repo root so the default stays meaningful regardless of the cwd.
 */
export function resolveProfilesRoot(): string {
  const configured = process.env.BRAND_PROFILES_DIR?.trim();
  if (!configured) {
    return join(REPO_ROOT, "profiles");
  }
  const expanded = configured.startsWith("~")
    ? join(homedir(), configured.slice(1).replace(/^\/+/, ""))
    : configured;
  return isAbsolute(expanded) ? expanded : join(REPO_ROOT, expanded);
}

/** Absolute path to a profile's folder: `<profiles root>/<slug>/`. */
export function resolveProfileDir(profile: string): string {
  return join(resolveProfilesRoot(), profile);
}

/**
 * Reads `outputs.base_dir` with a plain regex instead of a full YAML parser
 * — this repo has no YAML dependency and pulling one in for a single scalar
 * field would be disproportionate. Checks `config.local.yaml` first (the
 * per-machine, gitignored file — this is machine-specific config, not project
 * config, so it belongs there per this repo's existing
 * config.yaml/config.local.yaml convention), falling back to `config.yaml` for
 * anyone not using a local override, then to "outputs" if neither sets it.
 *
 * The match is anchored to the `outputs:` block rather than matching a bare
 * `base_dir:` anywhere in the file, so an unrelated `base_dir` under some
 * other top-level key can't be picked up by accident. The value is captured to
 * end-of-line (not `\S+`) so a path containing spaces survives intact.
 */
function readOutputsKey(profileDir: string, key: string): string | undefined {
  const extract = (raw: string): string | undefined => {
    // `outputs:` on its own line, then the first `<key>:` indented beneath
    // it. Comment lines in between are skipped by the lazy `[\s\S]*?`, and the
    // `^\S` guard stops the search at the next top-level key so we never reach
    // into a following block.
    const match = raw.match(
      new RegExp(`^outputs:[^\\n]*\\n(?:(?!^\\S)[\\s\\S])*?^\\s+${key}:[ \\t]*(.+)$`, "m"),
    );
    return match?.[1]?.trim().replace(/^["']|["']$/g, "");
  };

  const readConfig = (filename: string): string | undefined => {
    try {
      return extract(readFileSync(join(profileDir, filename), "utf-8"));
    } catch (error) {
      // A missing config.local.yaml is the normal case (it's gitignored and
      // optional), so that one falls through to the next source. Anything else
      // — unreadable file, permission error — is a real problem worth
      // surfacing rather than silently rendering to the wrong folder.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };

  return readConfig("config.local.yaml") ?? readConfig("config.yaml");
}

function readOutputsBaseDir(profileDir: string): string {
  const value = readOutputsKey(profileDir, "base_dir") ?? "outputs";
  return value.startsWith("~")
    ? join(homedir(), value.slice(1).replace(/^\/+/, ""))
    : value;
}

/**
 * Subfolder under the profile's output base dir for a given render script
 * (e.g. `outputs.brand_message`). This is an output-layout concern, so it
 * lives beside `base_dir` in the profile's config rather than in brand.json —
 * where a folder name sat oddly among colors, type and copy, and where every
 * profile was forced to declare one whether or not it rendered that variant.
 *
 * Falls back to the key itself, so a profile that never customizes it still
 * gets a sensible, non-colliding folder instead of an error.
 */
export function resolveOutputSubfolder(profileDir: string, key: string): string {
  return readOutputsKey(profileDir, key) ?? key;
}

/**
 * Absolute base directory for a profile's generated output. `base_dir` may be
 * relative (resolved against the profile's own folder) or absolute/"~"-prefixed
 * (e.g. "~/Pictures/<marca>/carruseles") to keep generated files entirely
 * outside the repo — every machine points this wherever makes sense; nothing
 * about the path is assumed here.
 */
export function resolveOutputBaseDir(profileDir: string): string {
  const baseDir = readOutputsBaseDir(profileDir);
  return isAbsolute(baseDir) ? baseDir : join(profileDir, baseDir);
}
