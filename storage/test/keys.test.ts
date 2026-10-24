import assert from "node:assert/strict";

import { blobKey, carouselExportKey, reelExportKey } from "../src/contracts/keys.ts";

const brand = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const sha = "ab" + "0".repeat(62);

assert.equal(blobKey(brand, sha), `brands/${brand}/blobs/sha256/ab/${sha}`);
assert.equal(carouselExportKey(brand, other, 3, "01.png"), `brands/${brand}/exports/carousels/${other}/v003/01.png`);
assert.equal(reelExportKey(brand, other, 12), `brands/${brand}/exports/reels/${other}/v012/reel.mp4`);

assert.throws(() => blobKey("acme-coffee", sha), /Invalid brandId/);
assert.throws(() => blobKey(brand, "xyz"), /Invalid sha256/);
assert.throws(() => carouselExportKey(brand, other, 0, "01.png"), /Invalid version/);
assert.throws(() => carouselExportKey(brand, other, 1, "../x"), /Invalid file name/);
assert.throws(() => carouselExportKey(brand, other, 1, ".."), /Invalid file name/);
assert.throws(() => carouselExportKey(brand, other, 1, "."), /Invalid file name/);
assert.throws(() => carouselExportKey(brand, other, 1, "a b"), /Invalid file name/);

console.log("keys: ok");
