/**
 * Text-to-speech for the reel's narration track.
 *
 * The engine knows how to *speak* a script; it never knows what to say. Both
 * the words and the voice come from the profile — the text from the caller,
 * the voice id and model from `recipes/reel-week.yaml`.
 *
 * The API key is read from the environment (ELEVENLABS_API_KEY) and never from
 * a profile file: a key is a machine credential, not brand data, and a profile
 * folder is meant to be transportable between machines.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/** What the profile's recipe declares under `voice:`. */
export interface VoiceConfig {
  /** ElevenLabs voice id. Belongs to the profile: it is part of how a brand sounds. */
  voice_id: string;
  /** Model id. Defaults to the multilingual one, which is what non-English profiles need. */
  model_id?: string;
  stability?: number;
  similarity_boost?: number;
  /** 0..1. Exaggerates the delivery — how much life the read has. */
  style?: number;
  /** Speaking rate, ~0.7..1.2. Slightly above 1 reads as energy, not haste. */
  speed?: number;
  /** Sharpens resemblance to the source voice; keeps an expressive read on-voice. */
  use_speaker_boost?: boolean;
}

const ENV_KEY = "ELEVENLABS_API_KEY";
const ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";

/**
 * Reads the API key, failing with the variable name rather than a 401 later.
 * Returns undefined when absent so the caller can decide: a missing key means
 * "render this reel silent", never "abort a video that was otherwise fine".
 */
export function hasVoiceKey(): boolean {
  return Boolean(process.env[ENV_KEY]?.trim());
}

/**
 * Synthesises `text` into an MP3 at `outPath`.
 *
 * Throws on a non-200: a reel that silently loses its narration looks like a
 * render bug and would be debugged as one.
 */
export async function synthesise(
  text: string,
  outPath: string,
  config: VoiceConfig,
): Promise<void> {
  const key = process.env[ENV_KEY]?.trim();
  if (!key) {
    throw new Error(`Missing ${ENV_KEY}. Export it, or drop --voice to render a silent reel.`);
  }
  const script = text.trim();
  if (!script) {
    throw new Error("The narration script is empty. Nothing would be spoken.");
  }

  const response = await fetch(`${ENDPOINT}/${encodeURIComponent(config.voice_id)}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: script,
      model_id: config.model_id ?? "eleven_multilingual_v2",
      voice_settings: {
        stability: config.stability ?? 0.5,
        similarity_boost: config.similarity_boost ?? 0.75,
        style: config.style ?? 0,
        speed: config.speed ?? 1,
        use_speaker_boost: config.use_speaker_boost ?? true,
      },
    }),
  });

  if (!response.ok) {
    // The body carries the reason (bad voice id, quota, missing permission);
    // a bare status code sends you to the wrong place.
    const detail = await response.text().catch(() => "");
    throw new Error(
      `ElevenLabs answered ${response.status}. ${detail.slice(0, 300)}`,
    );
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) {
    throw new Error("ElevenLabs answered 200 with an empty body — no audio to mux.");
  }
  writeFileSync(outPath, audio);
}

/** What the profile's recipe declares under `music:`. */
export interface MusicConfig {
  /** Prompt describing the bed. Generated, so the brand describes a mood, not a file. */
  prompt: string;
  /** How far the bed is ducked under the narration, in dB. Negative. */
  gain_db?: number;
}

/**
 * Generates an instrumental bed of `seconds` from a text prompt.
 *
 * Length is passed in by the caller rather than declared by the profile: the
 * bed must match the video, and a brand cannot know how long a given week's
 * reel turned out to be.
 */
export async function composeMusic(
  prompt: string,
  seconds: number,
  outPath: string,
): Promise<void> {
  const key = process.env[ENV_KEY]?.trim();
  if (!key) {
    throw new Error(`Missing ${ENV_KEY}. Export it, or drop --music to render without a bed.`);
  }

  const response = await fetch("https://api.elevenlabs.io/v1/music", {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      // Asked for ~15% longer than the video, not the exact length: the model
      // ends its tracks with its own fade-out, so a bed cut to size arrives
      // already dying under the closing card. The mux trims the tail we do not
      // use, which is cheaper than a reel that goes quiet before it ends.
      music_length_ms: Math.min(Math.ceil(seconds * 1.15), 300) * 1000,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ElevenLabs music answered ${response.status}. ${detail.slice(0, 300)}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) {
    throw new Error("ElevenLabs music answered 200 with an empty body.");
  }
  writeFileSync(outPath, audio);
}

/** Duration of an audio file in seconds, via ffprobe. */
export function durationOf(path: string): number {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { encoding: "utf8" },
  );
  const seconds = Number.parseFloat(out.trim());
  if (!Number.isFinite(seconds)) {
    throw new Error(`ffprobe returned no duration for ${path}`);
  }
  return seconds;
}
