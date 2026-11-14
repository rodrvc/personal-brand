// Narration cache key: shared by the reel engine (system/ig-reel) and the storage importer, so both
// compute exactly the same hash for the same text and voice. Pure, no I/O. Node-only (node:crypto), not for browsers.
import { createHash } from 'node:crypto'

/** Collapses whitespace so a reflowed card does not re-synthesise. */
export function normaliseNarration(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Content hash of what actually reaches the TTS endpoint: normalised text, the effective voice
 * settings and the model. Same text + same voice = same key.
 */
export function narrationCacheKey(text, voice) {
  const payload = {
    text: normaliseNarration(text),
    model_id: voice.model_id ?? 'eleven_multilingual_v2',
    voice_id: voice.voice_id,
    stability: voice.stability ?? 0.5,
    similarity_boost: voice.similarity_boost ?? 0.75,
    style: voice.style ?? 0,
    speed: voice.speed ?? 1,
    use_speaker_boost: voice.use_speaker_boost ?? true,
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/** The recipe's voice with the storyboard's partial override applied (undefined values keep the recipe's). */
export function effectiveVoice(recipeVoice, override) {
  const merged = { ...recipeVoice }
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value !== undefined) merged[key] = value
  }
  return merged
}
