import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { detectImage } from "../../../system/assets/index.js";
import { cropToSize, edgeColor, padToSize } from "./image-tools.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

if (existsSync("/usr/bin/sips")) {
  const padded = detectImage(padToSize(TINY_PNG, 64, 96), "out.png");
  assert.deepEqual([padded.mime, padded.w, padded.h], ["image/png", 64, 96], "letterboxed to exactly the requested size");
  const cropped = detectImage(cropToSize(padToSize(TINY_PNG, 64, 96), 40, 50), "out.png");
  assert.deepEqual([cropped.w, cropped.h], [40, 50], "cropped to the exact size");
  const white = padToSize(TINY_PNG, 20, 40, "FFFFFF");
  assert.equal(edgeColor(white), "FFFFFF", "the colour of the band above the picture");
  console.log("ok - image-tools");
} else {
  console.log("skip - no sips on this system");
}
