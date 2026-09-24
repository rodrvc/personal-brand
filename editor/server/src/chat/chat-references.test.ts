import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeReference } from "./chat-references.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

assert.deepEqual(normalizeReference(TINY_PNG, "image/png"), { bytes: TINY_PNG, mime: "image/png" }, "a small PNG passes through");

if (existsSync("/usr/bin/sips")) {
  const dir = mkdtempSync(join(tmpdir(), "heic-test-"));
  try {
    writeFileSync(join(dir, "in.png"), TINY_PNG);
    execFileSync("sips", ["-s", "format", "heic", join(dir, "in.png"), "--out", join(dir, "in.heic")], { stdio: "ignore" });
    const out = normalizeReference(readFileSync(join(dir, "in.heic")), "image/heic");
    assert.equal(out.mime, "image/jpeg");
    assert.deepEqual([...out.bytes.subarray(0, 2)], [0xff, 0xd8], "the HEIC photo becomes a JPEG");
    console.log("ok - HEIC becomes JPEG");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log("skip - no sips on this system");
}
{
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    assert.throws(() => normalizeReference(TINY_PNG, "image/heic"), /solo funciona en macOS/, "names the real cause, not the file");
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}
console.log("ok - chat-references");
