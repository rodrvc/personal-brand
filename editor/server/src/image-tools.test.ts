import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { detectImage } from "../../../system/assets/index.js";
import { padToSize } from "./image-tools.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

if (existsSync("/usr/bin/sips")) {
  const padded = detectImage(padToSize(TINY_PNG, 64, 96), "out.png");
  assert.deepEqual([padded.mime, padded.w, padded.h], ["image/png", 64, 96], "letterboxed to exactly the requested size");
  console.log("ok - image-tools");
} else {
  console.log("skip - no sips on this system");
}
