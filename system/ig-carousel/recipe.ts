import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal reader for the one recipe field the engine must know about on its
 * own: whether the profile declared where its content images come from.
 *
 * Why the engine reads the recipe at all, when every other recipe field is
 * interpreted by the agent following `system/recipes/*.md`: this field does not
 * describe *what* to fetch, it asserts *what is trustworthy*. An assertion that
 * only takes effect when whoever copies it remembers to copy it is not an
 * assertion. Concretely, the step that transcribes the hosts into the carousel
 * input is the same step that can invent an image URL — the actor the check
 * guards is the actor installing it, so its absence cannot be read as consent.
 *
 * So the engine reads the declaration from the recipe (the profile's stated
 * intent, which the agent does not rewrite) and compares it against the input
 * (what the agent produced). Mismatch is a finding, not a default.
 *
 * Deliberately *not* a YAML parser. Adding one to read a single list would put
 * a dependency in the render path and create a second recipe loader competing
 * with the one in `system/recipes/weekly-roundup.md`. This reads one key and
 * refuses to guess about anything else — see `readRecipeImageHosts`.
 */

/** What the recipe says about image provenance, if it says anything. */
export interface RecipeImagePolicy {
  /** The recipe file, for error messages that name where to go and fix. */
  path: string;
  /**
   * Whether that file exists. Distinct from `declaredHosts` being absent: a
   * recipe that exists and stays silent on hosts is a deliberate "anywhere",
   * while no recipe at all means nobody stated a policy. Collapsing the two let
   * `--input` from one profile be rendered under a `--profile` that has no
   * recipe, and the host check approved it.
   */
  exists: boolean;
  /** Present when the recipe declares `source.image_hosts`. */
  declaredHosts?: string[];
}

/**
 * Hosts that look like an attempt to write "any host" as a value.
 *
 * There is no wildcard syntax here, and this list exists to say so out loud
 * rather than let the attempt fail into something that only looks like it
 * worked. `image_hosts: ["*"]` parsed cleanly and then matched nothing, because
 * the comparison is `includes(host)` against a literal — so a recipe whose
 * author meant "allow everything" silently got "allow nothing", and every
 * image in the batch was dropped with the message `image host "api.example.com"
 * is not one of the source hosts (*)`. Failing closed by accident is still
 * failing for the wrong reason, and the message accuses the data instead of the
 * declaration.
 *
 * The other direction — actually implementing `*` as "any host" — is worse, and
 * that is the real reason this is a rejection and not a feature. The whole point
 * of reading this field from the recipe is that the profile's declaration is a
 * *ceiling* the render cannot rewrite (see the module comment). A supported
 * wildcard is a one-token, in-band way for a profile — possibly written by a
 * third party and downloaded — to switch the image-provenance check off while
 * the file still reads as if a check were configured. A guard with a documented
 * off switch inside the data it guards is not a guard.
 *
 * "My images can come from anywhere" is already expressible, and deliberately
 * only expressible by *omitting the key*: `verifyImagePolicy` treats a recipe
 * that exists and stays silent on hosts as the written opt-out. That form is
 * honest — there is no allowlist to misread as active — and it is documented in
 * `system/recipes/brand-message.md` and `weekly-roundup.md`.
 */
const WILDCARD_HOSTS = new Set(["*", "*.*", "**", "all", "any"]);

/**
 * Extracts `source.image_hosts` from a recipe's YAML text.
 *
 * Scoped rather than free-matching: it walks from the `source:` block header to
 * the next key at that indentation, so an `image_hosts` mentioned inside a
 * `guidance: |` prose block elsewhere cannot be mistaken for the declaration.
 * A sibling parser in the commit gate learned that lesson the hard way by
 * matching keys inside block scalars.
 *
 * Returns `undefined` for "not declared" and `[]` never — a declared-but-empty
 * list is a malformed declaration, and the caller reports it as such rather
 * than treating it as "no hosts". `"wildcard"` is the same kind of answer for a
 * declaration that tries to mean "anything" — see `WILDCARD_HOSTS`.
 */
export function parseRecipeImageHosts(
  yaml: string,
): string[] | undefined | "malformed" | "wildcard" {
  // `\r?\n`, not `\n`: a recipe saved by a CRLF editor left a stray \r on the
  // list-item lines, every item parsed empty, and a perfectly valid file was
  // rejected as "malformed" — a false positive that erodes trust in the check.
  const lines = yaml.split(/\r?\n/);

  const sourceStart = lines.findIndex((line) => /^source\s*:/.test(line));
  if (sourceStart === -1) {
    return undefined;
  }

  // The `source:` block ends at the next line that starts at column 0 with a
  // key — anything more indented still belongs to it.
  let sourceEnd = lines.length;
  for (let i = sourceStart + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i]!)) {
      sourceEnd = i;
      break;
    }
  }

  const block = lines.slice(sourceStart + 1, sourceEnd);
  const keyIndex = block.findIndex((line) => /^\s+image_hosts\s*:/.test(line));
  if (keyIndex === -1) {
    return undefined;
  }

  const keyLine = block[keyIndex]!;
  const inline = /^\s+image_hosts\s*:\s*(.+)$/.exec(keyLine)?.[1]?.trim();

  // Flow style: `image_hosts: [a, b]`. Supported because it is idiomatic YAML
  // and silently missing it would lose the declaration.
  if (inline && inline.startsWith("[")) {
    const items = inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((item) => stripScalar(item))
      .filter((item) => item.length > 0);
    return classify(items);
  }

  // A scalar where a list belongs, e.g. `image_hosts: api.example.com`. Not
  // silently accepted as a one-item list: the schema says list, and quietly
  // normalizing a wrong shape is how a typo becomes invisible.
  if (inline && !inline.startsWith("#")) {
    return "malformed";
  }

  const items: string[] = [];
  for (const line of block.slice(keyIndex + 1)) {
    if (/^\s*(#|$)/.test(line)) {
      continue; // comment or blank inside the list
    }
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (!item) {
      break; // next key at this level ends the list
    }
    const value = stripScalar(item[1] ?? "");
    if (value.length > 0) {
      items.push(value);
    }
  }
  return classify(items);
}

/**
 * Turns a parsed list into the parser's answer.
 *
 * Shared by both list styles on purpose: the flow-style branch and the block
 * branch each used to end in their own `items.length > 0 ? items : "malformed"`,
 * and adding the wildcard rule to one and not the other would have made
 * `image_hosts: ["*"]` and the block form behave differently — exactly the kind
 * of split where a check is present in the shape nobody tested.
 *
 * A wildcard anywhere in the list poisons the whole declaration rather than
 * being filtered out: `["*", "api.example.com"]` is not "allow that one host",
 * it is a declaration whose author believed the first entry did something.
 * Dropping it silently would leave them with a narrower allowlist than they
 * wrote and no way to find out.
 */
function classify(items: string[]): string[] | "malformed" | "wildcard" {
  if (items.length === 0) {
    return "malformed";
  }
  if (items.some((item) => WILDCARD_HOSTS.has(item.trim().toLowerCase()))) {
    return "wildcard";
  }
  return items;
}

/**
 * Unquotes a scalar and strips a trailing comment.
 *
 * Quotes first, then comments, and a `#` only counts as a comment when it
 * follows whitespace: `- "#Hashtag"` is a value, not an empty string. The
 * reverse order silently ate quoted values that begin with `#` — which is the
 * *natural* way to write one, since an unquoted `#` starts a comment.
 */
function stripScalar(raw: string): string {
  let value = raw.trim();
  const quoted = /^(["'])(.*)\1/.exec(value);
  if (quoted) {
    return quoted[2]!;
  }
  value = value.split(/\s+#/)[0]!;
  return value.trim();
}

/**
 * Reads the image policy from `<profileDir>/recipes/<recipe>.yaml`.
 *
 * A missing recipe file is not an error here: a profile may legitimately be
 * driven by `--input` alone. It simply means the engine has no declaration to
 * compare against, which the caller reports rather than assumes.
 */
export function readRecipeImageHosts(profileDir: string, recipe: string): RecipeImagePolicy {
  const path = join(profileDir, "recipes", `${recipe}.yaml`);

  let yaml: string;
  try {
    yaml = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { path, exists: false };
    }
    throw error;
  }

  const parsed = parseRecipeImageHosts(yaml);
  if (parsed === "malformed") {
    throw new Error(
      `Invalid ${path}: source.image_hosts must be a non-empty list of hosts, ` +
        `e.g.\n  image_hosts:\n    - api.example.com\n` +
        `Malformed, the image-host check would silently never run.`,
    );
  }
  // Thrown, not reported as a finding: the file is invalid, not the batch. A
  // finding is severity the caller chooses, and there is no run of any input for
  // which this declaration becomes meaningful.
  if (parsed === "wildcard") {
    throw new Error(
      `Invalid ${path}: source.image_hosts has no wildcards — hosts are compared ` +
        `literally, so "*" matches no real host and would drop every image ` +
        `instead of allowing them.\n` +
        `  · to allow images from a specific host, name it:\n` +
        `      image_hosts:\n        - api.example.com\n` +
        `  · to state that your images can come from anywhere, DELETE the ` +
        `image_hosts key. Absence is the written opt-out; an allowlist that ` +
        `permits everything is not, because the file would read as if a check ` +
        `were active.`,
    );
  }

  return { path, exists: true, declaredHosts: parsed };
}
