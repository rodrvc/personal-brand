/**
 * Renders a weekly reel for a profile.
 *
 * Usage:
 *   npx tsx system/ig-reel/render-reel-week.ts --profile <slug> [--date YYYY-MM-DD]
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
 * `--voice` points at a plain-text script to narrate. `--music` adds the bed
 * described by the profile. Without either the reel is rendered silent.
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
import { validateBBox, wideFraming } from "./geo.js";
import { geocode } from "./osm.js";
import { loadReelRecipe } from "./recipe.js";
import type { ReelProps } from "./remotion/src/props.js";
import type { ReelInput } from "./types.js";
import { verifyOrThrow, type Period } from "./verify-items.js";
import { composeMusic, durationOf, synthesise } from "./voice.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
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

async function main(): Promise<void> {
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
  // How long the bed plays alone before the narration comes in — what gives an
  // opening fanfare room to land. Only meaningful when there is both a bed and
  // a voice; 0 puts the narration on the first frame, as before.
  const introSeconds = wantsMusic && scriptPath ? (recipe.music?.intro_seconds ?? 0) : 0;
  const introMs = Math.round(introSeconds * 1000);
  /** Length of the fade from full bed to ducked bed. */
  const duckSeconds = 0.6;
  const dateFlag = flag("date");
  const reference = dateFlag ? new Date(`${dateFlag}T12:00:00`) : new Date();
  if (Number.isNaN(reference.getTime())) {
    throw new Error(`--date must be YYYY-MM-DD, got: ${dateFlag}`);
  }
  const period = weekOf(reference);

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
  const items = verifyOrThrow({ input, inputPath, bbox, period });
  console.log(`  ${items.length} item(s) verified`);

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
    // territory, and in a coastal city its midpoint is open water.
    map: wideFraming(bbox, items.map(({ lat, lng }) => ({ lat, lng }))),
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
  };

  const propsPath = join(outputDir, "reel-props.json");
  writeFileSync(propsPath, JSON.stringify(props, null, 2));

  // --- render ---
  if (!existsSync(join(remotionDir, "node_modules"))) {
    console.log("Installing the Remotion project's dependencies (first run)…");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: remotionDir, stdio: "inherit" });
  }

  const rendersDir = join(outputDir, "renders");
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

  const audioDir = join(outputDir, "..", `audio-${period.start}`);
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
  if (scriptPath) {
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
      `[1:a]adelay=${introMs}|${introMs},loudnorm=I=-16:TP=-1.5:LRA=11,apad[voz];` +
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

  console.log(`\nReel: ${basename(finalPath)}`);
  console.log(`Output folder: ${resolve(outputDir)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
