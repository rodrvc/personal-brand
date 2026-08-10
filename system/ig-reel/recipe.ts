/**
 * Loads the profile's `recipes/reel-week.yaml`.
 *
 * Unlike the carousel — where code reads exactly one field and the agent
 * interprets the rest — this loader reads the whole file, because the reel's
 * engine consumes `map.bbox` directly: it becomes the camera's wide framing
 * and the geocoding bound, not prose an agent acts on.
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
    /**
     * The framing for the whole city, and the outer bound for every zone.
     * An item outside it is dropped: the frame is a declared decision, not
     * something an item can move.
     */
    bbox: unknown;
    /**
     * DEPRECATED — accepted for compatibility with existing recipes, ignored
     * by the tile-based renderer. Zones were sub-frames of the drawn SVG map;
     * a MapLibre camera can centre any coordinate in the bbox, so there is
     * nothing left for a zone to fix.
     */
    zones?: Record<string, unknown>;
    /**
     * DEPRECATED — accepted for compatibility, ignored. Landmark discovery
     * belonged to the drawn map; the raster tiles carry their own labels.
     * No longer validated against an enum.
     */
    reference_types?: unknown;
    geocode?: { user_agent?: string };
  };
  render: { script: string };
  /**
   * How this brand sounds when the reel is narrated. Optional: a profile that
   * never uses --voice does not declare it. The API key is NOT here — that is
   * a machine credential, read from the environment.
   */
  voice?: {
    voice_id: string;
    model_id?: string;
    stability?: number;
    similarity_boost?: number;
    style?: number;
    speed?: number;
    use_speaker_boost?: boolean;
  };
  /**
   * The mood of the instrumental bed, as a prompt. Optional, and a prompt
   * rather than a file path because the bed is generated to the length of the
   * week's video — which a profile cannot know in advance.
   */
  music?: { prompt: string; gain_db?: number; intro_seconds?: number };
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
  "": ["recipe", "version", "defaults", "source", "curation", "map", "render", "voice", "music", "caption"],
  defaults: ["city", "region"],
  source: ["kind", "url", "path", "items_path", "field_map", "image_hosts", "filters"],
  curation: ["count", "guidance", "prefer"],
  map: ["bbox", "zones", "reference_types", "geocode"],
  render: ["script"],
  voice: ["voice_id", "model_id", "stability", "similarity_boost", "style", "speed", "use_speaker_boost"],
  music: ["prompt", "gain_db", "intro_seconds"],
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
  for (const scope of ["defaults", "source", "curation", "map", "render", "voice", "music", "caption"]) {
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

  // A `voice:` block with no voice_id would fail at synthesis time, after the
  // video has already rendered — the expensive half of the run.
  const voice = parsed.voice as Node | undefined;
  if (voice !== undefined) {
    if (typeof voice.voice_id !== "string" || !voice.voice_id.trim()) {
      throw new Error(
        `${path}: voice.voice_id must be a non-empty string. ` +
          `It names the voice this brand speaks in, and the engine never picks one for you.`,
      );
    }
    for (const key of ["stability", "similarity_boost", "style"] as const) {
      const value = voice[key];
      if (value !== undefined && (typeof value !== "number" || value < 0 || value > 1)) {
        throw new Error(
          `${path}: voice.${key} must be a number between 0 and 1, got ${JSON.stringify(value)}.`,
        );
      }
    }
  }

  const music = parsed.music as Node | undefined;
  if (music !== undefined) {
    if (typeof music.prompt !== "string" || !music.prompt.trim()) {
      throw new Error(
        `${path}: music.prompt must be a non-empty string describing the bed's mood.`,
      );
    }
    if (
      music.intro_seconds !== undefined
      && (typeof music.intro_seconds !== "number" || music.intro_seconds < 0 || music.intro_seconds > 5)
    ) {
      throw new Error(
        `${path}: music.intro_seconds must be a number between 0 and 5, got ${JSON.stringify(music.intro_seconds)}. ` +
          `It is the head start the bed gets before the narration, not a whole scene.`,
      );
    }
    if (music.gain_db !== undefined && (typeof music.gain_db !== "number" || music.gain_db > 0)) {
      throw new Error(
        `${path}: music.gain_db must be a number at or below 0 (it attenuates the bed), ` +
          `got ${JSON.stringify(music.gain_db)}. A positive value would push the bed over the narration.`,
      );
    }
  }

  const curation = parsed.curation as Node | undefined;
  if (curation?.count !== undefined) {
    const count = curation.count;
    // The floor is 2, not 3: a week where only two items survive verification
    // is a real outcome of a thin source, and refusing to render it pushed the
    // operator towards padding the reel with an item that was not verifiable —
    // which is the failure this engine exists to prevent. Two still reads as a
    // short tour; one does not, and is where the line stays.
    if (typeof count !== "number" || !Number.isInteger(count) || count < 2 || count > 6) {
      throw new Error(
        `${path}: curation.count must be an integer between 2 and 6, got ${JSON.stringify(count)}. ` +
          `A single item does not read as a tour; above 6 it runs past the length a reel holds attention for.`,
      );
    }
  }

  const map = parsed.map as ReelRecipe["map"] | undefined;
  if (!map || typeof map !== "object") {
    throw new Error(`${path}: a "map" block with a bbox is required.`);
  }

  return parsed as unknown as ReelRecipe;
}
