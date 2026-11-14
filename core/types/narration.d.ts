export interface VoiceSettings {
  voice_id: string
  model_id?: string
  stability?: number
  similarity_boost?: number
  style?: number
  speed?: number
  use_speaker_boost?: boolean
}

export function normaliseNarration(text: string): string
export function narrationCacheKey(text: string, voice: VoiceSettings): string
export function effectiveVoice<V extends VoiceSettings>(recipeVoice: V, override?: Partial<V>): V
