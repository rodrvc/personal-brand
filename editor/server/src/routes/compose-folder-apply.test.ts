import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Folder `plan/apply` over real HTTP with a library that leaves slots empty, so generation runs: create-only first write, resume, a save landing meanwhile. */
const root = mkdtempSync(join(tmpdir(), "editor-server-folder-apply-"));
process.env.BRAND_PROFILES_DIR = root;
const SLUG = "folder-apply";
cpSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "profiles", "example"), join(root, SLUG), { recursive: true });

const { default: express } = await import("express");
const { composeRouter } = await import("./compose.js");
const { ProfileStore } = await import("../profile-store.js");
const { readDocumentRaw, writeDocumentThroughRevision, readDocumentRevision } = await import("../document-store.js");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const calls = { images: 0, failOnImage: 0, onImage: undefined as ((n: number) => Promise<void>) | undefined };
const generator = {
  draftCopy: async (plan: { slides: Array<{ slideId: string }> }) => ({ slides: plan.slides.map((s) => ({ slideId: s.slideId, headline: `Headline ${s.slideId}`, body: "Body" })), model: "fake", costCents: 0 }),
  generateImage: async () => {
    const n = ++calls.images;
    await calls.onImage?.(n);
    if (n === calls.failOnImage) throw new Error("provider down");
    return { buffer: PNG, mime: "image/png", model: "fake-image", costCents: 4, usedReferenceIds: [] };
  },
  completeJson: async () => ({ json: {}, model: "fake", costCents: 0 }),
  acceptsReference: () => false,
};

const app = express();
app.use(express.json());
app.use(composeRouter(() => generator as never));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/profiles/${SLUG}`;
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const store = new ProfileStore(SLUG);
const plan = async (id: string) => {
  const preview = await post("/carousels?mode=plan", { id, prompt: "weekly tips" });
  assert.equal(preview.status, 201, JSON.stringify(preview.body));
  assert.equal(preview.body.generatedPieces > 0, true, "the example library leaves slots empty, so the apply generates");
  return preview.body.generatedPieces as number;
};

try {
  const pieces = await plan("generated");
  const done = await post("/carousels/generated/plan/apply", {});
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(calls.images, pieces);
  assert.equal(JSON.stringify(readDocumentRaw(store, "generated")).includes("Headline"), true);

  await plan("appeared");
  const mine = readDocumentRaw(store, "generated") as { id: string; title: string };
  await writeDocumentThroughRevision(store, { ...mine, id: "appeared", title: "Mine" } as never, { create: true });
  const images = calls.images;
  const clash = await post("/carousels/appeared/plan/apply", {});
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
  assert.equal(clash.body.planDropped, true);
  assert.equal((readDocumentRaw(store, "appeared") as { title: string }).title, "Mine", "left untouched");
  assert.equal(calls.images, images, "nothing generated");
  assert.equal((await post("/carousels/appeared/plan/apply", {})).status, 404);

  await plan("resumed");
  const before = calls.images;
  calls.failOnImage = before + 2;
  const partial = await post("/carousels/resumed/plan/apply", {});
  calls.failOnImage = 0;
  assert.equal(partial.status, 202, JSON.stringify(partial.body));
  assert.equal(partial.body.planDropped, false);
  const retried = await post("/carousels/resumed/plan/apply", {});
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.equal(pieces >= 2, true);
  assert.equal(calls.images - before, pieces + 1, "two attempts at the second slot, the first slot generated once");

  await plan("raced");
  calls.onImage = async () => {
    calls.onImage = undefined;
    const current = readDocumentRaw(store, "raced") as { title: string };
    await writeDocumentThroughRevision(store, { ...current, title: "Saved meanwhile" } as never, { expectedRevision: (await readDocumentRevision(store, "raced"))?.revision ?? null });
  };
  const raced = await post("/carousels/raced/plan/apply", {});
  assert.equal(raced.status, 202, JSON.stringify(raced.body));
  assert.equal(raced.body.planDropped, true);
  assert.equal((readDocumentRaw(store, "raced") as { title: string }).title, "Saved meanwhile", "the user's save stays");
  assert.equal((await post("/carousels/raced/plan/apply", {})).status, 404);
  assert.equal(existsSync(join(root, SLUG, "assets", "generated")), true);
  console.log("compose-folder-apply: ok");
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
