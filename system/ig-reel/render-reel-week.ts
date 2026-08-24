/**
 * Renders a weekly reel for a profile.
 *
 * Usage:
 *   npx tsx system/ig-reel/render-reel-week.ts --profile <slug> [--date YYYY-MM-DD]
 *                                              [--storyboard [path]] [--audio-only]
 *                                              [--voice <script.txt>] [--music]
 *
 * The profile slug is required and never inferred: rendering the wrong brand
 * silently is the expensive failure, and asking is cheap.
 *
 * The video is rendered by the Remotion project under `remotion/`: the map is
 * real raster tiles driven frame by frame by a MapLibre camera, not a drawn
 * SVG. This script's job is to flatten profile data — brand tokens, recipe,
 * verified items — into the `ReelProps` contract, stage the profile's assets
 * under the Remotion project's `public/`, invoke the render, and then mux the
 * audio. Everything brand-shaped stays on this side of the boundary.
 *
 * `--storyboard` narrates one card per scene and derives each scene's length
 * from its own audio ("audio first" — see storyboard.ts). It is the default
 * whenever `profiles/<slug>/reels/<date>/storyboard.yaml` exists. `--voice`
 * is the legacy single-script narration laid over the fixed rhythm; the two
 * are exclusive. `--music` adds the bed described by the profile. Without any
 * of them the reel is rendered silent, exactly as before storyboards existed.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  categoryStyle,
  color,
  interpolate,
  loadBrand,
  templateCopy,
  withAlpha,
} from "../ig-carousel/brand-schema.js";
import { resolveOutputBaseDir, resolveOutputSubfolder, resolveProfileDir } from "../ig-carousel/profile.js";
import {
  assertRangesTileComposition,
  clipFileName,
  clipRangesFor,
  concatListContents,
  framesArg,
  validateClipsForAssembly,
  type ClipRange,
  type ExistingClip,
} from "./assemble.js";
import { validateBBox, wideFraming } from "./geo.js";
import { loadDotEnv } from "./env.js";
import { geocode } from "./osm.js";
import { loadReelRecipe } from "./recipe.js";
import { FPS } from "./remotion/src/timeline.js";
import type { ReelProps } from "./remotion/src/props.js";
import {
  buildTimeline,
  defaultStoryboardPath,
  effectiveVoice,
  formatStoryboardTable,
  formatTimelineTable,
  loadStoryboard,
  synthesiseCards,
  type CardAudio,
  type ReelTimeline,
} from "./storyboard.js";
import type { ReelInput } from "./types.js";
import { verifyOrThrow, type Period } from "./verify-items.js";
import { composeMusic, durationOf, synthesise } from "./voice.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Every value of a repeatable flag, e.g. `--card a --card b` → `["a", "b"]`. */
function repeatedFlag(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((arg, index) => {
    if (arg === `--${name}`) {
      const value = process.argv[index + 1];
      if (value && !value.startsWith("--")) values.push(value);
    }
  });
  return values;
}

/** Monday-to-Sunday week containing the reference date, in local time. */
function weekOf(reference: Date): Period {
  const monday = new Date(reference);
  // getDay() is 0 for Sunday, which belongs to the week that started 6 days ago.
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const iso = (date: Date): string =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { start: iso(monday), end: iso(sunday) };
}

/**
 * Duration of a video's VIDEO stream, in seconds — not the container's
 * `format=duration`. Remotion writes each clip with its own silent AAC audio
 * track whose packet padding does not line up with the video's frame count
 * (measured: a 77-frame/2.5667s video stream inside a container that
 * `ffprobe -show_entries format=duration` reports as 2.624s, because that
 * figure is the longest stream, and the padded silent audio track is it).
 * Comparing a clip's container duration against the timeline therefore fails
 * spuriously; comparing the video stream's duration does not.
 */
function videoDurationOf(path: string): number {
  const out = execFileSync(
    "ffprobe",
    [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1", path,
    ],
    { encoding: "utf8" },
  );
  const seconds = Number.parseFloat(out.trim());
  if (!Number.isFinite(seconds)) {
    throw new Error(`ffprobe returned no video stream duration for ${path}`);
  }
  return seconds;
}

/**
 * Checks that a concatenated video's duration matches the timeline it was
 * assembled from, within one frame. The existing ffprobe-based audio-length
 * guard (further down) checks audio against video; this is the video-against-
 * timeline check the clip path needs before that one ever runs — a bad concat
 * should fail here, not surface later as a video/audio mismatch.
 */
function assertConcatDuration(path: string, expectedSeconds: number): void {
  const actual = videoDurationOf(path);
  const tolerance = 1 / 30; // one frame at the engine's fixed FPS
  if (Math.abs(actual - expectedSeconds) > tolerance) {
    throw new Error(
      `Assembled video is ${actual.toFixed(3)}s, expected ${expectedSeconds.toFixed(3)}s from the timeline ` +
        `(±${tolerance.toFixed(3)}s). The concat produced the wrong length — do not mux audio onto it.`,
    );
  }
}

/**
 * Validates the clips on disk against `ranges`, concatenates them with the
 * ffmpeg concat demuxer, and verifies the result's duration. Tries
 * `-c copy` (no re-encode — the clips share the exact same codec/params, so
 * this is normally lossless and fast); a boundary glitch would show up as
 * either a failing ffmpeg process or a wrong total duration, either of which
 * triggers a fallback to a re-encoded concat with the engine's fixed
 * parameters, at the cost of a generation of quality on the seams only.
 */
function assembleClips(
  ranges: readonly ClipRange[],
  clipsDir: string,
  rendersDir: string,
  periodStart: string,
  expectedSeconds: number,
): void {
  const existing: ExistingClip[] = ranges.map((range) => {
    const path = join(clipsDir, clipFileName(range, ranges.length));
    const exists = existsSync(path);
    return {
      cardId: range.cardId,
      path,
      exists,
      measuredSeconds: exists ? videoDurationOf(path) : undefined,
    };
  });
  validateClipsForAssembly(ranges, existing);

  mkdirSync(rendersDir, { recursive: true });
  const listPath = join(clipsDir, "concat-list.txt");
  writeFileSync(listPath, concatListContents(existing.map((clip) => clip.path)));
  const assembledPath = join(rendersDir, `reel-${periodStart}.mp4`);

  console.log("Concatenating clips (stream copy, no re-encode)…");
  try {
    execFileSync(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", assembledPath],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    assertConcatDuration(assembledPath, expectedSeconds);
  } catch (error) {
    // `-c copy` can produce boundary glitches when a clip's keyframes do not
    // line up with the cut — Remotion renders every frame as a keyframe by
    // default, so in practice this path is a safety net, not the common case.
    console.warn(
      "  stream copy failed or produced a mismatched duration — falling back to a re-encoded concat:",
      error instanceof Error ? error.message : String(error),
    );
    execFileSync(
      "ffmpeg",
      [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        assembledPath,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    assertConcatDuration(assembledPath, expectedSeconds);
  }
  console.log(`  assembled: ${assembledPath}`);
}

async function main(): Promise<void> {
  const loaded = loadDotEnv(repoRoot);
  if (loaded.length > 0) {
    console.log(`env: loaded ${loaded.length} var(s) from .env`);
  }

  const profile = flag("profile");
  if (!profile) {
    throw new Error("Missing --profile <slug>. The engine never guesses which brand to render.");
  }

  const profileDir = resolveProfileDir(profile);
  const brand = loadBrand(profileDir, ["categories", "reel"]);
  const recipe = loadReelRecipe(profileDir);
  const bbox = validateBBox(recipe.map.bbox);
  if (recipe.map.zones !== undefined || recipe.map.reference_types !== undefined) {
    console.warn(
      "  map.zones/map.reference_types belong to the retired SVG renderer — the MapLibre renderer ignores them; they can be removed from the recipe.",
    );
  }
  const userAgent = recipe.map.geocode?.user_agent ?? `personal-brand-reel/1.0 (+${brand.copy.site})`;

  const scriptPath = flag("voice");
  const wantsMusic = process.argv.includes("--music");
  const audioOnly = process.argv.includes("--audio-only");
  // Per-card render/assembly (see system/ig-reel/README.md → "Clips and
  // assembly"). `--clips` renders every scene as its own silent clip and
  // assembles them; `--card <id>` renders only the named cards, without
  // assembling; `--assemble` only concatenates clips already on disk. All
  // three require a storyboard: the default fixed rhythm has no card ids to
  // name a clip after.
  const wantsAllClips = process.argv.includes("--clips");
  const requestedCardIds = repeatedFlag("card");
  const assembleOnly = process.argv.includes("--assemble");
  const clipModeCount = [wantsAllClips, requestedCardIds.length > 0, assembleOnly].filter(Boolean).length;
  if (clipModeCount > 1) {
    throw new Error("--clips, --card and --assemble are mutually exclusive — pick one.");
  }
  const dateFlag = flag("date");
  const reference = dateFlag ? new Date(`${dateFlag}T12:00:00`) : new Date();
  if (Number.isNaN(reference.getTime())) {
    throw new Error(`--date must be YYYY-MM-DD, got: ${dateFlag}`);
  }
  const period = weekOf(reference);

  // The storyboard is on whenever the flag is passed or the profile's file
  // for this period exists. It is exclusive with --voice: one of them decides
  // the scene lengths, and a reel cannot follow two clocks.
  const storyboardFlag = process.argv.indexOf("--storyboard");
  const storyboardArg = storyboardFlag === -1 ? undefined : process.argv[storyboardFlag + 1];
  const explicitStoryboard = storyboardArg && !storyboardArg.startsWith("--") ? resolve(storyboardArg) : undefined;
  const storyboardPath =
    explicitStoryboard
    ?? (storyboardFlag !== -1 || existsSync(defaultStoryboardPath(profileDir, period.start))
      ? defaultStoryboardPath(profileDir, period.start)
      : undefined);
  if (storyboardPath && scriptPath) {
    throw new Error(
      `--voice and the storyboard are exclusive: ${storyboardPath} would derive the scene lengths ` +
        "from its cards, and --voice lays one script over the fixed rhythm. Drop --voice, " +
        "or move the storyboard aside to render the legacy way.",
    );
  }
  if (audioOnly && !storyboardPath) {
    throw new Error("--audio-only needs a storyboard: it stops after the per-card narration and timeline.");
  }
  if (clipModeCount > 0 && !storyboardPath) {
    throw new Error(
      "--clips, --card and --assemble all need a storyboard: the default fixed rhythm has no card ids " +
        "to name a clip after. Pass --storyboard, or use one of the default period's storyboard.yaml.",
    );
  }
  for (const cardId of requestedCardIds) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(cardId)) {
      throw new Error(`--card ${cardId}: not a valid card id (lowercase letters, digits, dashes).`);
    }
  }

  // How long the bed plays alone before the narration comes in — what gives an
  // opening fanfare room to land. Only meaningful when there is both a bed and
  // a voice; 0 puts the narration on the first frame, as before.
  const narrated = Boolean(scriptPath || storyboardPath);
  const introSeconds = wantsMusic && narrated ? (recipe.music?.intro_seconds ?? 0) : 0;
  /** Length of the fade from full bed to ducked bed. */
  const duckSeconds = 0.6;

  const inputPath = join(profileDir, "reels", "week-input.json");
  const input = JSON.parse(readFileSync(inputPath, "utf-8")) as ReelInput;

  // Every network call goes through the on-disk cache, so a re-run of the same
  // week costs no requests at all. `--no-cache` forces fresh data; the cache
  // announces itself either way, because a silent cache is a trap.
  const fetchOptions = { noCache: process.argv.includes("--no-cache"), report: console.log };

  // Geocode anything the source did not carry coordinates for. Sequential and
  // one call per item, as Nominatim's usage policy requires.
  for (const item of input.items) {
    if (typeof item.lat === "number" && typeof item.lng === "number") continue;
    const found = await geocode(bbox, `${item.where}, ${input.city}`, userAgent, fetchOptions);
    if (found) {
      item.lat = found.lat;
      item.lng = found.lon;
    }
    // Anything still without a coordinate is dropped by verifyOrThrow, with a
    // reason. It is never defaulted to the centre of the bbox.
  }

  console.log(`Verifying items against ${period.start}..${period.end}`);
  const verified = verifyOrThrow({ input, inputPath, bbox, period });
  console.log(`  ${verified.length} item(s) verified`);
  let items = verified;

  // --- storyboard: audio first, video after ---
  // One MP3 per card (cached by content), measured, and a timeline derived
  // from those lengths. The scene order follows the cards, not the input.
  let timeline: ReelTimeline | undefined;
  let cardAudio: CardAudio[] = [];
  /** Card ids in scene order — parallel to `timeline.scenes`. Only set with a storyboard. */
  let cardIds: string[] | undefined;
  if (storyboardPath) {
    if (!recipe.voice) {
      throw new Error(
        "A storyboard needs a `voice:` block in the profile's recipes/reel-week.yaml " +
          "(voice_id at minimum): which voice a brand speaks in is a profile decision.",
      );
    }
    console.log(`Storyboard: ${storyboardPath}`);
    const storyboard = loadStoryboard(storyboardPath, input.items.length);
    console.log(formatStoryboardTable(storyboard));

    // Each item card points at week-input.json; the item it names must have
    // survived verification, and the reel shows them in card order.
    const ordered = storyboard.cards
      .filter((card) => card.visual === "item")
      .map((card) => {
        const source = input.items[card.item!]!;
        const kept = verified.find((item) => item === source);
        if (!kept) {
          throw new Error(
            `card ${card.id} points at item ${card.item} (${JSON.stringify(source.title)}), ` +
              "which did not survive verification — see the reasons above. Fix the item or drop the card.",
          );
        }
        return kept;
      });
    items = ordered;

    const voice = effectiveVoice(recipe.voice, storyboard.voice);
    const cardsAudioDir = join(dirname(storyboardPath), "audio");
    console.log("Synthesising the narration, one card at a time…");
    cardAudio = await synthesiseCards(storyboard, voice, cardsAudioDir, { report: console.log });

    timeline = buildTimeline(storyboard, cardAudio, introSeconds);
    cardIds = storyboard.cards.map((card) => card.id);
    for (const requested of requestedCardIds) {
      if (!cardIds.includes(requested)) {
        throw new Error(`--card ${requested}: no such card in ${storyboardPath}. Cards: ${cardIds.join(", ")}.`);
      }
    }
    const timelinePath = join(dirname(storyboardPath), "timeline.json");
    writeFileSync(timelinePath, JSON.stringify({ cards: timeline.cards, total: timeline.total }, null, 2));
    console.log("\nTimeline (derived from the audio):");
    console.log(formatTimelineTable(timeline));
    console.log(`  written to ${timelinePath}`);

    if (audioOnly) {
      console.log("\n--audio-only: stopping before the render. Listen to the cards, then render without the flag.");
      try {
        execFileSync("open", [cardsAudioDir], { stdio: "ignore" });
      } catch {
        // Not macOS, or no opener: the path was printed above.
      }
      console.log(`Output folder: ${resolve(cardsAudioDir)}`);
      return;
    }
  }

  const outputDir = join(
    resolveOutputBaseDir(profileDir),
    resolveOutputSubfolder(profileDir, "reels"),
    period.start,
  );
  mkdirSync(outputDir, { recursive: true });

  // --- stage the profile's assets inside the Remotion project ---
  // Remotion's `staticFile()` only serves from the project's own `public/`,
  // so the brand's images and font are copied into a staging folder there for
  // the duration of the render. The folder is gitignored and wiped afterwards:
  // nothing brand-shaped may be left lying under system/.
  const remotionDir = join(__dirname, "remotion");
  const stagingDir = join(remotionDir, "public", "staging");
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  // Local item images are staged so the render never depends on the network;
  // a remote URL is passed through as-is and Remotion fetches it at render.
  const imageSrcs = items.map((item, index) => {
    const local = join(profileDir, item.image.replace(/^\.?\//, ""));
    const target = `staging/item${index + 1}${(item.image.match(/\.\w+$/) ?? [".jpg"])[0]}`;
    try {
      copyFileSync(local, join(remotionDir, "public", target));
      return target;
    } catch {
      return item.image;
    }
  });

  // A local logo font, if the profile ships one, so preview and render agree.
  let logoFontFile: string | undefined;
  const fontsDir = join(profileDir, "assets", "fonts");
  try {
    const font = readdirSync(fontsDir).find((name) => name.endsWith(".woff2"));
    if (font) {
      copyFileSync(join(fontsDir, font), join(stagingDir, font));
      logoFontFile = `staging/${font}`;
    }
  } catch {
    // No font folder: the composition falls back to the named brand font.
  }

  // --- flatten everything into the ReelProps contract ---
  const accent = color(brand, "accent");
  const surface = color(brand, "surface");
  const onSurface = color(brand, "onSurface");
  const reelCopy = templateCopy(brand, "reel");
  const vars = { city: input.city, count: String(items.length) };

  const props: ReelProps = {
    locale: brand.locale ?? "en",
    colors: {
      accent,
      surface,
      onSurface,
      onSurfaceMuted: color(brand, "onSurfaceMuted"),
      wordmark: color(brand, "wordmark"),
      orbA: withAlpha(color(brand, "highlight"), 0.5),
      orbB: withAlpha(accent, 0.45),
      labelPlate: withAlpha(surface, 0.92),
      credit: withAlpha(onSurface, 0.55),
      pulse: withAlpha(accent, 0.75),
    },
    coverGradient: brand.gradients!.cover!,
    fonts: { body: brand.fonts.body, logo: brand.fonts.logo },
    logoFontFile,
    copy: {
      coverTitle: interpolate(reelCopy.coverTitle, vars),
      coverSubtitle: interpolate(reelCopy.coverSubtitle, vars),
      coverCount: interpolate(reelCopy.coverCount, vars),
      closingCta: interpolate(reelCopy.closingCta, vars),
      wordmark: brand.copy.wordmark,
      site: brand.copy.site,
    },
    // Required by the ODbL terms of the data and CARTO's tile terms. Engine-
    // owned: no profile field turns it off.
    attribution: "© OpenStreetMap contributors © CARTO",
    // Framed on the verified items, not on the bbox: the bbox is the filter's
    // territory, and in a coastal city its midpoint is open water. All the
    // verified items, even when a storyboard shows a subset of them.
    map: wideFraming(bbox, verified.map(({ lat, lng }) => ({ lat, lng }))),
    items: items.map((item, index) => {
      const style = categoryStyle(brand, item.category);
      return {
        title: item.title,
        when: item.when,
        where: item.where,
        mapLabel: item.mapLabel,
        category: (item.category ?? "").toUpperCase(),
        categoryBackground: style.gradient ?? style.solid,
        image: imageSrcs[index]!,
        lng: item.lng,
        lat: item.lat,
      };
    }),
    // Absent without a storyboard: the composition runs its fixed rhythm.
    scenes: timeline?.scenes,
  };

  const propsPath = join(outputDir, "reel-props.json");
  writeFileSync(propsPath, JSON.stringify(props, null, 2));

  // --- per-card clips: render, or assemble already-rendered ones ---
  // A clip is not a separate composition — it is a frame range of this same
  // `Reel` composition, rendered with the same props. That is what keeps the
  // pixels identical to a monolithic render and preserves the cross-fades
  // between scenes for free (see assemble.ts). This branch never falls
  // through to the monolithic render below.
  const clipsDir = join(outputDir, "clips");
  const rendersDir = join(outputDir, "renders");
  if (clipModeCount > 0) {
    if (!timeline || !cardIds) {
      throw new Error("internal error: clip mode requires a storyboard-derived timeline.");
    }
    const ranges = clipRangesFor(timeline.scenes, cardIds);
    const totalFrames = Math.round(timeline.total * FPS);
    assertRangesTileComposition(ranges, totalFrames);

    if (!assembleOnly) {
      const wanted = wantsAllClips ? ranges : ranges.filter((range) => requestedCardIds.includes(range.cardId));
      if (!existsSync(join(remotionDir, "node_modules"))) {
        console.log("Installing the Remotion project's dependencies (first run)…");
        execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: remotionDir, stdio: "inherit" });
      }
      mkdirSync(clipsDir, { recursive: true });
      console.log(`Rendering ${wanted.length} clip(s)…`);
      for (const range of wanted) {
        const clipPath = join(clipsDir, clipFileName(range, ranges.length));
        console.log(`  ${range.cardId}: frames ${framesArg(range)} → ${clipPath}`);
        execFileSync(
          "npx",
          [
            "remotion",
            "render",
            "src/index.ts",
            "Reel",
            clipPath,
            `--props=${propsPath}`,
            `--frames=${framesArg(range)}`,
            // Same flags as the monolithic render, on purpose: identical
            // codec/params across clips is what lets them concatenate with
            // `-c copy` and no re-encode.
            "--concurrency=1",
            "--gl=swangle",
            // A clip must be genuinely silent, not "silent audio track with
            // its own padding": Remotion writes a per-render silent AAC track
            // whose packet duration does not line up with the video's frame
            // count (measured: a 77-frame/2.5667s video wrapped in a
            // container ffprobe reports as 2.624s, because the padded audio
            // track is the longest stream). Concatenating clips that each
            // carry a mismatched audio track produces a variable-frame-rate
            // result — 758 correct frames stretched to 25.5s instead of
            // 25.2667s. `--muted` drops the track entirely so a clip's only
            // stream is its video, and the concat has nothing to misalign.
            "--muted",
          ],
          { cwd: remotionDir, stdio: "inherit" },
        );
      }
      rmSync(stagingDir, { recursive: true, force: true });
      console.log(`\n${wanted.length} clip(s) rendered under ${clipsDir}`);
      if (!wantsAllClips) {
        for (const range of wanted) {
          console.log(`  ${range.cardId}: ${join(clipsDir, clipFileName(range, ranges.length))}`);
        }
        console.log(`Output folder: ${resolve(clipsDir)}`);
        return;
      }
      console.log("Assembling…");
    } else {
      console.log(`Assembling ${ranges.length} clip(s) from ${clipsDir}…`);
    }

    assembleClips(ranges, clipsDir, rendersDir, period.start, timeline.total);
    // Falls through to the shared audio mux below, exactly like the
    // monolithic render — `rendered` just needs to resolve to the file
    // assembleClips wrote.
  } else {
    // --- render (monolithic, default) ---
    if (!existsSync(join(remotionDir, "node_modules"))) {
      console.log("Installing the Remotion project's dependencies (first run)…");
      execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: remotionDir, stdio: "inherit" });
    }

    mkdirSync(rendersDir, { recursive: true });
    console.log("Rendering…");
    execFileSync(
      "npx",
      [
        "remotion",
        "render",
        "src/index.ts",
        "Reel",
        join(rendersDir, `reel-${period.start}.mp4`),
        `--props=${propsPath}`,
        // One browser at a time: each frame's MapLibre instance loads tiles, and
        // parallel instances race the tile cache for no wall-clock gain.
        "--concurrency=1",
        // SwiftShader/ANGLE software GL — the headless-safe way to run WebGL.
        "--gl=swangle",
      ],
      { cwd: remotionDir, stdio: "inherit" },
    );

    // The staging folder has done its job; brand assets do not live under
    // system/ a second longer than the render needs them.
    rmSync(stagingDir, { recursive: true, force: true });
  }

  const audioDir = join(outputDir, "audio");
  mkdirSync(audioDir, { recursive: true });
  const rendered = readdirSync(rendersDir)
    .filter((name) => name.endsWith(".mp4"))
    .sort()
    .pop();
  if (!rendered) {
    throw new Error(`remotion render produced no MP4 in ${rendersDir}`);
  }

  // Narration is opt-in and never inferred: the engine speaks a script it is
  // handed, and a reel with no --voice renders exactly as it did before.
  let voicePath: string | undefined;
  // How far the mux delays the narration track. The legacy script is delayed
  // by the music intro here; a storyboard track already carries the intro
  // inside the cover (see buildTimeline), so it is placed at 0.
  let voiceDelayMs = Math.round(introSeconds * 1000);
  if (timeline) {
    const spoken = timeline.cards
      .map((card, index) => ({ card, audio: cardAudio[index]! }))
      .filter(({ audio }) => audio.path);
    if (spoken.length > 0) {
      voicePath = join(audioDir, `narration-${period.start}.wav`);
      voiceDelayMs = 0;
      console.log("Laying the cards on the narration track…");
      // Each card's MP3 is delayed to its scene start (plus the cover's intro
      // offset) and the delayed copies are summed. Cards never overlap — each
      // scene lasts at least its own narration — so the sum is a concat with
      // silences, and `normalize=0` keeps the level of each card intact.
      const inputs = spoken.flatMap(({ audio }) => ["-i", audio.path!]);
      const delays = spoken
        .map(({ card }, index) => {
          const ms = Math.round((card.start + card.narrationOffset) * 1000);
          return `[${index}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[c${index}]`;
        })
        .join(";");
      const labels = spoken.map((_, index) => `[c${index}]`).join("");
      const graph =
        spoken.length === 1
          ? `${delays};[c0]anull[voz]`
          : `${delays};${labels}amix=inputs=${spoken.length}:duration=longest:dropout_transition=0:normalize=0[voz]`;
      execFileSync(
        "ffmpeg",
        ["-y", ...inputs, "-filter_complex", graph, "-map", "[voz]", "-c:a", "pcm_s16le", voicePath],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      console.log(`  narration: ${durationOf(voicePath).toFixed(1)}s over ${timeline.total.toFixed(1)}s of video`);
    }
  } else if (scriptPath) {
    if (!recipe.voice) {
      throw new Error(
        "--voice needs a `voice:` block in the profile's recipes/reel-week.yaml " +
          "(voice_id at minimum): which voice a brand speaks in is a profile decision.",
      );
    }
    const script = readFileSync(resolve(scriptPath), "utf8");
    console.log("Synthesising the narration…");
    // Written to a sibling folder, not into renders/: an audio file left next
    // to the video would be picked up by tooling that scans the output, and
    // the bed belongs to the mux step, not to the composition.
    voicePath = join(audioDir, `narration-${period.start}.mp3`);
    await synthesise(script, voicePath, recipe.voice);

    // A narration longer than the video would be cut mid-sentence by -shortest,
    // which reads as a TTS failure rather than a script that was too long.
    const videoSeconds = durationOf(join(rendersDir, rendered));
    const voiceSeconds = durationOf(voicePath);
    // The intro delay pushes the narration later, so it counts against the
    // budget: without this a script that just fits would be cut by the fanfare.
    if (voiceSeconds + introSeconds > videoSeconds + 0.25) {
      throw new Error(
        `The narration runs ${voiceSeconds.toFixed(1)}s` +
          (introSeconds ? ` after a ${introSeconds}s intro` : "") +
          ` but the reel is ${videoSeconds.toFixed(1)}s. ` +
          "Shorten the script — trimming it here would cut a sentence in half.",
      );
    }
    console.log(
      `  narration: ${voiceSeconds.toFixed(1)}s over ${videoSeconds.toFixed(1)}s of video` +
        (introSeconds ? ` (after a ${introSeconds}s intro)` : ""),
    );
  }

  // The music bed is opt-in the same way, and its mood comes from the profile:
  // what a brand sounds like under its own voice is a brand decision.
  let musicPath: string | undefined;
  let musicGainDb = -18;
  if (wantsMusic) {
    if (!recipe.music) {
      throw new Error(
        "--music needs a `music:` block in the profile's recipes/reel-week.yaml " +
          "(prompt at minimum): the mood of the bed is a profile decision.",
      );
    }
    musicGainDb = recipe.music.gain_db ?? (voicePath ? -18 : -6);
    console.log("Composing the music bed…");
    musicPath = join(audioDir, `music-${period.start}.mp3`);
    await composeMusic(recipe.music.prompt, durationOf(join(rendersDir, rendered)), musicPath);
    console.log(`  bed: ${durationOf(musicPath).toFixed(1)}s at ${musicGainDb}dB`);
  }

  // The audio track is not optional: a mute video stream freezes several macOS
  // players on the first frame — the file looks broken while being fine.
  // Without narration the track is silent and exists only so the platform's
  // own music can be added later; with `--voice` it carries the spoken script.
  const finalPath = join(outputDir, `reel-${period.start}.mp4`);

  // Three shapes, one mux: silent, narration only, or narration over a bed.
  // `apad` on every branch is what keeps -shortest from trimming the *video*
  // down to a track that is shorter than it.
  const audioArgs: string[] = [];
  if (voicePath && musicPath) {
    audioArgs.push("-i", voicePath, "-i", musicPath);
    // The bed is ducked by a fixed gain rather than a sidechain compressor:
    // the narration is the content, and a bed that rises in the gaps draws the
    // ear away from the card being read.
    // The narration is loudness-normalised before the bed is mixed under it.
    // Raw TTS output varies by several dB between voices — and a script with
    // pauses averages lower still — so a fixed bed gain against un-normalised
    // speech makes the mix depend on which voice the profile happens to name.
    audioArgs.push(
      "-filter_complex",
      // `duration=longest`, not `first`: the narration is shorter than the
      // reel, and ending the mix with it left the closing card in dead
      // silence. `-shortest` still trims the result to the video.
      // The bed is not a flat gain. It plays at full strength for the intro —
      // the fanfare the profile asked for has to actually land — then ducks to
      // `gain_db` once the narration starts, and the voice is delayed by the
      // same amount so it does not fight the horns. A generated bed cannot be
      // relied on to quieten itself: the model returns a level track and
      // "then it calms down" is not something the prompt controls.
      // `adelay` comes BEFORE `loudnorm`, not after. Reversed, the two-pass
      // normaliser emits timestamps the muxer cannot use and the output gets a
      // 0.04s audio stream — a silent video that still probes as having sound.
      `[1:a]adelay=${voiceDelayMs}|${voiceDelayMs},loudnorm=I=-16:TP=-1.5:LRA=11,apad[voz];` +
        // The duck is a cross-fade between the full-strength bed and a ducked
      // copy of itself, rather than a time-varying `volume` expression: nested
      // `if()` in `volume:eval=frame` produced a 0.04s audio stream instead of
      // failing, which reads as a mux bug rather than a bad filter.
      `[2:a]asplit=2[loud][soft];` +
        `[loud]afade=t=out:st=${introSeconds}:d=${duckSeconds}[fanfare];` +
        `[soft]volume=${musicGainDb}dB,afade=t=in:st=${introSeconds}:d=${duckSeconds}[under];` +
        `[fanfare][under]amix=inputs=2:duration=longest:normalize=0,apad[bed];` +
        `[voz][bed]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]`,
      "-map", "0:v:0", "-map", "[a]",
    );
  } else if (voicePath) {
    audioArgs.push(
      "-i", voicePath,
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,apad",
      "-map", "0:v:0", "-map", "1:a:0",
    );
  } else if (musicPath) {
    audioArgs.push("-i", musicPath, "-af", "apad", "-map", "0:v:0", "-map", "1:a:0");
  } else {
    audioArgs.push(
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-map", "0:v:0", "-map", "1:a:0",
    );
  }

  console.log(
    voicePath && musicPath
      ? "Muxing narration over the music bed…"
      : voicePath
        ? "Muxing the narration track…"
        : musicPath
          ? "Muxing the music bed…"
          : "Adding the silent audio track…",
  );
  execFileSync(
    "ffmpeg",
    [
      "-y", "-i", join(rendersDir, rendered),
      ...audioArgs,
      // The video is copied, never re-encoded: muxing audio must not cost a
      // generation of quality on a file that already rendered correctly.
      "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest",
      "-movflags", "+faststart", finalPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  // A filter graph can emit a near-empty audio stream instead of failing — the
  // file then plays silent while probing as having sound, which is exactly the
  // shape of bug that ships. Cheap to check, expensive to discover after.
  const finalVideoSeconds = durationOf(join(rendersDir, rendered));
  const finalAudioSeconds = Number.parseFloat(
    execFileSync(
      "ffprobe",
      [
        "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1", finalPath,
      ],
      { encoding: "utf8" },
    ).trim(),
  );
  if (!Number.isFinite(finalAudioSeconds) || finalAudioSeconds < finalVideoSeconds - 0.5) {
    throw new Error(
      `The muxed audio track is ${finalAudioSeconds}s against ${finalVideoSeconds.toFixed(1)}s of video. ` +
        "The filter graph dropped the audio; the reel would play silent.",
    );
  }

  // --- copy card audio files and storyboard/timeline snapshots to output ---
  if (cardAudio.length > 0) {
    const cardsDir = join(audioDir, "cards");
    mkdirSync(cardsDir, { recursive: true });
    const cardsAudioDir = join(dirname(storyboardPath!), "audio");
    for (const audio of cardAudio) {
      if (audio.path && existsSync(audio.path)) {
        const fileName = basename(audio.path);
        copyFileSync(audio.path, join(cardsDir, fileName));
      }
    }
    console.log(`Copied ${cardAudio.length} card audio file(s) to ${cardsDir}`);
  }

  // Copy storyboard and timeline as snapshots of what was rendered
  if (storyboardPath && existsSync(storyboardPath)) {
    copyFileSync(storyboardPath, join(outputDir, "storyboard.yaml"));
  }
  const timelinePath = join(dirname(storyboardPath || ""), "timeline.json");
  if (storyboardPath && existsSync(timelinePath)) {
    copyFileSync(timelinePath, join(outputDir, "timeline.json"));
  }

  console.log(`\nReel: ${basename(finalPath)}`);
  console.log(`Output folder: ${resolve(outputDir)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
