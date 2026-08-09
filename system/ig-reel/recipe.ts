/**
 * Loads the profile's `recipes/reel-week.yaml`.
 *
 * Unlike the carousel — where code reads exactly one field and the agent
 * interprets the rest — this loader reads the whole file, because the reel's
 * engine consumes `map.bbox` and `map.reference_types` directly: they become a
 * projection and an Overpass query, not prose an agent acts on.
 *
 * Validation happens **at load, before any request**. A recipe asking for
 * something unsupported fails with a sentence naming what it asked for and
 * what exists — never a silent downgrade. The precedent is `loadBrand()`,
 * which names the exact missing key rather than leaving `undefined` inside a
 * published file.
 *
 * The parser is hand-written rather than a YAML dependency, matching
 * `ig-carousel/recipe.ts`: this repo has no YAML dependency, and adding one on
 * the render path to read a handful of scalars would be disproportionate.
 * It covers the subset the recipe contract documents — nested maps, inline
 * lists, block lists, and `|` block scalars — and rejects anything else rather
 * than guessing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SUPPORTED_VERSIONS = [1];
export const SUPPORTED_SCRIPTS = ["render-reel-week"];
export const SUPPORTED_SOURCE_KINDS = ["http_json", "local_json"];

export interface ReelRecipe {
  recipe: string;
  version: number;
  defaults?: { city?: string; region?: string };
  source?: Record<string, unknown>;
  curation?: { count?: number; guidance?: string };
  map: {
    bbox: unknown;
    reference_types: unknown;
    geocode?: { user_agent?: string };
  };
  render: { script: string };
  caption?: Record<string, unknown>;
}

type Node = Record<string, unknown>;

/** Parses the documented YAML subset into plain objects. */
function parseYaml(text: string, path: string): Node {
  const root: Node = {};
  // Each frame owns the container at one indentation level.
  const stack: { indent: number; node: Node | unknown[] }[] = [{ indent: -1, node: root }];
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]!.node;
    const content = line.trim();

    if (content.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error(`${path}: list item at line ${i + 1} has no list to belong to.`);
      }
      parent.push(scalar(content.slice(2).trim()));
      continue;
    }

    const match = /^([\w.-]+):\s*(.*)$/.exec(content);
    if (!match) {
      throw new Error(`${path}: cannot parse line ${i + 1}: ${JSON.stringify(content)}`);
    }
    const [, key, rest] = match as unknown as [string, string, string];
    if (Array.isArray(parent)) {
      throw new Error(`${path}: key "${key}" at line ${i + 1} appears inside a list.`);
    }

    if (rest === "|" || rest === ">") {
      // Block scalar: everything indented further belongs to it.
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j]!;
        if (next.trim() && next.length - next.trimStart().length <= indent) break;
        body.push(next.slice(indent + 2));
      }
      parent[key] = body.join(rest === "|" ? "\n" : " ").trim();
      i = j - 1;
      continue;
    }

    if (rest === "") {
      // A container: whether it is a map or a list is decided by the next
      // non-blank line that is indented further.
      const next = lines.slice(i + 1).find((candidate) => candidate.trim() && !candidate.trim().startsWith("#"));
      const isList = next !== undefined
        && next.length - next.trimStart().length > indent
        && next.trim().startsWith("- ");
      const container: Node | unknown[] = isList ? [] : {};
      parent[key] = container;
      stack.push({ indent, node: container });
      continue;
    }

    parent[key] = scalar(rest);
  }

  return root;
}

function scalar(raw: string): unknown {
  const value = raw.replace(/\s+#.*$/, "").trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(",").map((part) => scalar(part.trim())) : [];
  }
  if (/^["'].*["']$/.test(value)) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

const ALLOWED_KEYS: Record<string, readonly string[]> = {
  "": ["recipe", "version", "defaults", "source", "curation", "map", "render", "caption"],
  defaults: ["city", "region"],
  source: ["kind", "url", "path", "items_path", "field_map", "image_hosts", "filters"],
  curation: ["count", "guidance", "prefer"],
  map: ["bbox", "reference_types", "geocode"],
  render: ["script"],
  caption: ["hashtag_count", "guidance"],
};

/**
 * Rejects keys the engine does not understand instead of ignoring them.
 *
 * An unknown key is not harmless: it is indistinguishable from an attempt to
 * declare behaviour the engine does not implement, and ignoring it lets a
 * profile believe a setting is in effect when nothing reads it.
 */
function rejectUnknownKeys(node: Node, scope: string, path: string): void {
  const allowed = ALLOWED_KEYS[scope];
  if (!allowed) return;
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `${path}: unknown key ${JSON.stringify(scope ? `${scope}.${key}` : key)}. ` +
          `Supported here: ${allowed.join(", ")}.`,
      );
    }
  }
}

export function loadReelRecipe(profileDir: string): ReelRecipe {
  const path = join(profileDir, "recipes", "reel-week.yaml");

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(
        `No reel recipe found at ${path}. See system/recipes/reel-week.md for the shape a profile must provide.`,
      );
    }
    throw error;
  }

  const parsed = parseYaml(text, path);

  rejectUnknownKeys(parsed, "", path);
  for (const scope of ["defaults", "source", "curation", "map", "render", "caption"]) {
    const node = parsed[scope];
    if (node && typeof node === "object" && !Array.isArray(node)) {
      rejectUnknownKeys(node as Node, scope, path);
    }
  }

  if (parsed.recipe !== "reel-week") {
    throw new Error(`${path}: "recipe" must be "reel-week", got ${JSON.stringify(parsed.recipe)}.`);
  }
  if (typeof parsed.version !== "number" || !SUPPORTED_VERSIONS.includes(parsed.version)) {
    throw new Error(
      `${path}: this profile asks for version ${JSON.stringify(parsed.version)}; ` +
        `this engine supports: ${SUPPORTED_VERSIONS.join(", ")}.`,
    );
  }

  const source = parsed.source as Node | undefined;
  if (source?.kind !== undefined) {
    if (typeof source.kind !== "string" || !SUPPORTED_SOURCE_KINDS.includes(source.kind)) {
      throw new Error(
        `${path}: this profile asks for source.kind: ${JSON.stringify(source.kind)}; ` +
          `this engine supports: ${SUPPORTED_SOURCE_KINDS.join(", ")}.`,
      );
    }
    if (source.kind === "http_json" && (typeof source.url !== "string" || !source.url.startsWith("https://"))) {
      throw new Error(
        `${path}: source.url must be an https:// URL, got ${JSON.stringify(source.url)}. ` +
          `http, file:, data: and private hosts are rejected.`,
      );
    }
  }

  const render = parsed.render as Node | undefined;
  if (typeof render?.script !== "string" || !SUPPORTED_SCRIPTS.includes(render.script)) {
    throw new Error(
      `${path}: this profile asks for render.script: ${JSON.stringify(render?.script)}; ` +
        `this engine supports: ${SUPPORTED_SCRIPTS.join(", ")}.`,
    );
  }

  const curation = parsed.curation as Node | undefined;
  if (curation?.count !== undefined) {
    const count = curation.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 3 || count > 6) {
      throw new Error(
        `${path}: curation.count must be an integer between 3 and 6, got ${JSON.stringify(count)}. ` +
          `Below 3 the video does not read as a tour; above 6 it runs past the length a reel holds attention for.`,
      );
    }
  }

  const map = parsed.map as ReelRecipe["map"] | undefined;
  if (!map || typeof map !== "object") {
    throw new Error(`${path}: a "map" block with bbox and reference_types is required.`);
  }

  return parsed as unknown as ReelRecipe;
}
