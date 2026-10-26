import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The rasteriser takes its fonts from a `RasterFonts`: the folder's (no resolver) or a stored brand's (served through a resolver, a refusal fails the raster). Runs the real Chromium. */
const root = mkdtempSync(join(tmpdir(), "editor-server-text-raster-"));
process.env.BRAND_PROFILES_DIR = root;
cpSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "profiles", "example"), join(root, "raster-example"), { recursive: true });

const { chromiumRasteriser, folderRasterFonts } = await import("./text-raster.js");
const { ProfileStore } = await import("./profile-store.js");
const { loadBrand } = await import("../../../system/ig-carousel/brand-schema.js");
const { getSharedBrowser } = await import("./browser.js");

const store = new ProfileStore("raster-example");
const brand = loadBrand(store.roots.profileDir);
const run = { text: "Hello", family: "sans-serif", size: 40, weight: 700, color: "#112233" };
const isPng = (b: Buffer) => b.subarray(1, 4).toString() === "PNG";

try {
  assert.deepEqual(await chromiumRasteriser(brand, folderRasterFonts(store, brand))([]), []);
  const folder = await chromiumRasteriser(brand, folderRasterFonts(store, brand))([run, run]);
  assert.equal(folder.length === 2 && folder.every(isPng), true, "a folder brand rasterises with no resolver");
  const served = await chromiumRasteriser(brand, { fontFaces: [], resolve: async () => { throw new Error("nothing is requested"); } })([run]);
  assert.equal(isPng(served[0]!), true, "a stored brand with no font to fetch needs no asset");
  const asked: string[] = [];
  const refused = chromiumRasteriser(brand, async () => ({ fontFaces: [{ family: "Stored Face", url: "http://render.local/assets/0123456789abcdef" }], resolve: async (id) => { asked.push(id); throw new Error("blob gone"); } }));
  await assert.rejects(refused([{ ...run, family: "'Stored Face'" }]), /The slide asked for assets it cannot have: http:\/\/render\.local\/assets\/0123456789abcdef \(resolver failed: blob gone\)/, "a font the resolver cannot serve fails the raster with the resolver's own refusal");
  assert.equal(asked.includes("0123456789abcdef"), true, "the font went through the resolver (a thunk may be async)");
  console.log("text-raster: ok");
} finally {
  await (await getSharedBrowser()).close();
  rmSync(root, { recursive: true, force: true });
}
