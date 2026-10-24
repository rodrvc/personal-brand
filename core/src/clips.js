/**
 * File name of a rendered reel clip: card index, zero-padded to the width of the last index, then the card id
 * (`0-cover.mp4`, or `03-item.mp4` for a storyboard of 11+ cards). Padding keeps the clips in scene order on disk.
 * Shared by the render engine (which writes the names) and the storage importer (which accepts only these names).
 */
export function clipFileName(index, cardId, total) {
  return `${String(index).padStart(String(total - 1).length, '0')}-${cardId}.mp4`
}
