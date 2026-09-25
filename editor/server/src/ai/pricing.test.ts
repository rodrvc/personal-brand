import assert from "node:assert/strict";

import { sizeHolding } from "./openai.js";
import { estimateImageCostFromUsage, posterImageModel, posterImageQuality, POSTER_IMAGE_MODEL, POSTER_IMAGE_QUALITY } from "./pricing.js";

const portrait = { w: 1080, h: 1350 };
assert.equal(sizeHolding(portrait, "gpt-image-2"), "1024x1280", "a model that takes any size gets the slide's own 4:5");
assert.equal(sizeHolding(portrait, "gpt-image-2-2026-04-21"), "1024x1280", "a dated snapshot of it too");
assert.equal(sizeHolding(portrait, "gpt-image-1-mini"), "1024x1536", "a fixed-size model gets the size that holds the most of the slide");
assert.equal(sizeHolding({ w: 1080, h: 1080 }, "gpt-image-2"), "1152x1152");

const usage = { input_tokens_details: { text_tokens: 1_000_000, image_tokens: 1_000_000 }, output_tokens: 1_000_000 };
assert.equal(estimateImageCostFromUsage(usage, "gpt-image-1-mini"), 1250, "mini at list price, in cents: $2 + $2.50 + $8 per 1M");
assert.equal(estimateImageCostFromUsage(usage, "gpt-image-2-2026-04-21"), 4300, "a dated snapshot is priced as its model");
assert.equal(estimateImageCostFromUsage(usage, "gpt-image-1"), 5500, "gpt-image-1 is not mistaken for its mini");
{
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    assert.equal(estimateImageCostFromUsage(usage, "unlisted-image-model"), 5500, "an unlisted model is priced at the highest known rate, not the mini's");
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1, "and the missing price is reported");
  assert.match(String(warnings[0]![0]), /unlisted-image-model/);
}

delete process.env.EDITOR_POSTER_IMAGE_MODEL;
delete process.env.EDITOR_POSTER_IMAGE_QUALITY;
assert.equal(posterImageModel(), POSTER_IMAGE_MODEL);
assert.equal(posterImageQuality(), POSTER_IMAGE_QUALITY);
process.env.EDITOR_POSTER_IMAGE_MODEL = "gpt-image-1-mini";
process.env.EDITOR_POSTER_IMAGE_QUALITY = "high";
assert.equal(posterImageModel(), "gpt-image-1-mini", "the environment overrides the model");
assert.equal(posterImageQuality(), "high");
delete process.env.EDITOR_POSTER_IMAGE_MODEL;
delete process.env.EDITOR_POSTER_IMAGE_QUALITY;
console.log("ok - pricing");
