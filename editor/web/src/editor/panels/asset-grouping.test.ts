import assert from "node:assert/strict";

import { ASSET_KINDS } from "../../../../../system/assets/index.js";
import { ASSET_KIND_LABEL } from "./asset-grouping.js";

/**
 * Guards against the exact drift that once left "font" out of the client's
 * `AssetKind` union: every kind the server actually indexes (`ASSET_KINDS`)
 * must have a Spanish label here, or `AssetsPane`/`BucketPane` render an
 * empty group heading for it.
 */
for (const kind of ASSET_KINDS) {
  assert.ok(
    Object.prototype.hasOwnProperty.call(ASSET_KIND_LABEL, kind),
    `ASSET_KIND_LABEL is missing an entry for server asset kind "${kind}"`,
  );
}

// And the reverse: a label for a kind the server no longer indexes would be a
// dead dropdown entry that `patchAsset` rejects.
for (const key of Object.keys(ASSET_KIND_LABEL)) {
  assert.ok(
    (ASSET_KINDS as readonly string[]).includes(key),
    `ASSET_KIND_LABEL has a stale entry "${key}" that is not a server asset kind`,
  );
}

console.log("asset-grouping.test.ts: ok");
