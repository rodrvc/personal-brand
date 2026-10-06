import type { BBox } from "./mask";

/**
 * Browser-only adapter, kept out of `mask.ts` so the pure model stays
 * testable with `tsx` (no DOM): rasterizes a 0/1 mask bitmap, cropped to its
 * `bbox`, into a PNG data URL via a plain `<canvas>`. White pixels with the
 * bit set, fully transparent otherwise — this editor is local-first
 * desktop Chromium/Safari only, so a synchronous `HTMLCanvasElement` covers
 * every target browser without `OffscreenCanvas`'s async `convertToBlob`.
 */
export function rasterToPngDataUrl(bitmap: Uint8Array, sourceWidth: number, bbox: BBox): string {
  const width = Math.max(1, bbox.w);
  const height = Math.max(1, bbox.h);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const imageData = ctx.createImageData(width, height);
  for (let y = 0; y < bbox.h; y++) {
    for (let x = 0; x < bbox.w; x++) {
      const on = bitmap[(bbox.y + y) * sourceWidth + (bbox.x + x)] === 1;
      const i = (y * width + x) * 4;
      imageData.data[i] = 255;
      imageData.data[i + 1] = 255;
      imageData.data[i + 2] = 255;
      imageData.data[i + 3] = on ? 255 : 0;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}
