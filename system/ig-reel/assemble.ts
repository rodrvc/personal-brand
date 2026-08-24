/**
 * Per-card render and assembly: one silent clip per scene, then a cheap
 * concat + the existing audio mux, instead of one monolithic render.
 *
 * The problem this solves: today a single-detail fix in one scene forces a
 * full re-render of the whole reel. Rendering per card lets a single scene
 * be redone and the total re-assembled without re-encoding the others.
 *
 * The core idea: a clip is not a separate composition, it is a **frame range
 * of the same `Reel` composition**, rendered with the same props. The pixels
 * are therefore identical to a monolithic render, and the cross-fades between
 * scenes (an `overlap` of `TIMING.overlap` seconds) are preserved for free —
 * the frame at a scene boundary already blends both scenes, so the cut lands
 * cleanly on it. This module is pure: it computes frame ranges and validates
 * an assembly plan. It knows nothing about `remotion render`, `ffmpeg`, or
 * disk — `render-reel-week.ts` is the only caller that touches any of those.
 */

import { FPS, type Scene } from "./remotion/src/timeline.js";

/** One clip: a frame range of the full `Reel` composition, tied to its card. */
export interface ClipRange {
  /** Storyboard card id — also the clip's filename stem. */
  cardId: string;
  /** 0-based index in scene order — used only for the filename's sort prefix. */
  index: number;
  /** First frame of the composition this clip renders (inclusive). */
  startFrame: number;
  /** Last frame of the composition this clip renders (inclusive). */
  endFrame: number;
  /** Scene duration in seconds, as the timeline computed it — for validating a rendered clip later. */
  sceneSeconds: number;
}

/**
 * One clip per scene, covering the whole composition with no gaps or overlaps
 * in FRAME space (the visual overlap between scenes is baked into the pixels
 * of each frame, not into which clip owns which frame). Each clip starts at
 * `round(scene.start * FPS)`; the last clip's end is `totalFrames - 1` so the
 * union covers exactly `[0, totalFrames)`.
 *
 * `cardIds` must be parallel to `scenes` (same length, same order) — that is
 * the caller's job (`storyboard.cards` and `timeline.scenes` come from the
 * same `buildTimeline` call, in the same order).
 */
export function clipRangesFor(scenes: readonly Scene[], cardIds: readonly string[]): ClipRange[] {
  if (scenes.length === 0) {
    throw new Error("clipRangesFor: no scenes to render — the storyboard produced an empty timeline.");
  }
  if (cardIds.length !== scenes.length) {
    throw new Error(
      `clipRangesFor: ${cardIds.length} card id(s) for ${scenes.length} scene(s) — they must be parallel lists.`,
    );
  }
  const totalFrames = Math.round(scenes[scenes.length - 1]!.end * FPS);
  const starts = scenes.map((scene) => Math.round(scene.start * FPS));

  return scenes.map((scene, index) => {
    const startFrame = starts[index]!;
    const endFrame = index === scenes.length - 1 ? totalFrames - 1 : starts[index + 1]! - 1;
    return {
      cardId: cardIds[index]!,
      index,
      startFrame,
      endFrame,
      sceneSeconds: scene.duration,
    };
  });
}

/** Index + card id ("0-cover", "1-item-1"), zero-padded once 10+ cards — sorts in scene order on disk. */
export function clipFileName(range: ClipRange, total: number): string {
  const width = String(total - 1).length;
  return `${String(range.index).padStart(width, "0")}-${range.cardId}.mp4`;
}

/**
 * Verifies that a list of clip ranges tiles the composition exactly: starts
 * at 0, ends at `totalFrames - 1`, and each clip's start is exactly the
 * previous clip's end + 1 (no gap, no overlap in frame ownership). Pure
 * arithmetic check, run right after `clipRangesFor` so a bug here is caught
 * before any render is spent.
 */
export function assertRangesTileComposition(ranges: readonly ClipRange[], totalFrames: number): void {
  if (ranges.length === 0) {
    throw new Error("assertRangesTileComposition: no ranges to check.");
  }
  if (ranges[0]!.startFrame !== 0) {
    throw new Error(`assertRangesTileComposition: first clip starts at frame ${ranges[0]!.startFrame}, expected 0.`);
  }
  for (let i = 1; i < ranges.length; i += 1) {
    const previous = ranges[i - 1]!;
    const current = ranges[i]!;
    if (current.startFrame !== previous.endFrame + 1) {
      throw new Error(
        `assertRangesTileComposition: clip ${current.cardId} starts at frame ${current.startFrame}, ` +
          `but clip ${previous.cardId} ends at ${previous.endFrame} — expected ${previous.endFrame + 1} ` +
          "(a gap or overlap between clips).",
      );
    }
  }
  const last = ranges[ranges.length - 1]!;
  if (last.endFrame !== totalFrames - 1) {
    throw new Error(
      `assertRangesTileComposition: last clip ends at frame ${last.endFrame}, expected ${totalFrames - 1} ` +
        `(totalFrames=${totalFrames}).`,
    );
  }
}

/** What `--remotion render`'s `--frames=` flag expects for one range. */
export function framesArg(range: ClipRange): string {
  return `${range.startFrame}-${range.endFrame}`;
}

// --- assembly: turning already-rendered clips into one concatenated video ---

export interface ExistingClip {
  cardId: string;
  /** Absolute path on disk. */
  path: string;
  /** Whether the file exists at all. */
  exists: boolean;
  /** Measured duration in seconds, when the file exists (undefined otherwise). */
  measuredSeconds?: number;
}

/** How much a clip's measured duration may drift from its scene before assembly refuses it. One frame, in seconds. */
export const CLIP_DURATION_TOLERANCE_SECONDS = 1 / FPS;

/**
 * Validates that every range the current timeline expects has a matching,
 * correctly-sized clip on disk, in scene order. Pure: takes what the caller
 * already looked up (`ExistingClip[]`, parallel to `ranges`) rather than
 * touching the filesystem itself, so it is testable without disk I/O.
 *
 * Fails naming the card id — never a generic "clip missing" — because that is
 * what lets someone fix exactly the one card that regressed.
 */
export function validateClipsForAssembly(
  ranges: readonly ClipRange[],
  clips: readonly ExistingClip[],
): void {
  if (clips.length !== ranges.length) {
    throw new Error(
      `validateClipsForAssembly: ${clips.length} clip(s) given for ${ranges.length} scene(s) in the current timeline.`,
    );
  }
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i]!;
    const clip = clips[i]!;
    if (clip.cardId !== range.cardId) {
      throw new Error(
        `validateClipsForAssembly: expected card "${range.cardId}" at position ${i}, got "${clip.cardId}" — ` +
          "the clip list is not in the timeline's scene order.",
      );
    }
    if (!clip.exists) {
      throw new Error(
        `validateClipsForAssembly: no clip on disk for card "${range.cardId}" (expected ${clip.path}). ` +
          `Render it with --card ${range.cardId} before assembling.`,
      );
    }
    const expectedSeconds = (range.endFrame - range.startFrame + 1) / FPS;
    if (
      clip.measuredSeconds === undefined ||
      Math.abs(clip.measuredSeconds - expectedSeconds) > CLIP_DURATION_TOLERANCE_SECONDS
    ) {
      throw new Error(
        `validateClipsForAssembly: clip for card "${range.cardId}" is ${clip.measuredSeconds ?? "unknown"}s, ` +
          `but the current timeline expects ${expectedSeconds.toFixed(3)}s for its scene. ` +
          `Re-render it with --card ${range.cardId} — the storyboard or timeline changed since it was rendered.`,
      );
    }
  }
}

/** One line of an ffmpeg concat-demuxer list file, in order. */
export function concatListContents(clipPaths: readonly string[]): string {
  if (clipPaths.length === 0) {
    throw new Error("concatListContents: no clips to concatenate.");
  }
  // ffmpeg's concat demuxer format: `file '<path>'`, one per line. Paths are
  // single-quoted; a literal `'` inside a path is escaped per the documented
  // trick (close quote, escaped quote, reopen quote) — clip paths are engine-
  // generated card ids and never contain one, but the escape keeps this
  // correct instead of merely "correct today".
  return clipPaths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}
