import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlobCache, FakeObjectStore } from "@personal-brand/storage/blob";
import { createMemoryRepositories } from "@personal-brand/storage/memory";

/** The chat log of a stored carousel (S10b7a): read, pending proposal, currency and discard, over real HTTP and the memory repositories. */
const root = mkdtempSync(join(tmpdir(), "editor-server-stored-chat-"));
process.env.BRAND_PROFILES_DIR = join(root, "profiles");

const { default: express } = await import("express");
const { chatRouter } = await import("./chat.js");
const { storedBrandGuard } = await import("../stored-read.js");

const SLUG = "chat-example";
const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "save" as const };
const STAMP = "2026-08-17T10:00:00.000Z";
const repos = createMemoryRepositories();
const brand = await repos.brands.create({ slug: SLUG, displayName: "Chat Example" }, meta);
await repos.brands.markCutover(brand.id, { ...meta, expectedVersion: brand.version });
const objects = new FakeObjectStore();
const storage = { brands: repos.brands, documents: repos.documents, assets: repos.assets, carousels: repos.carousels, exports: repos.exports, revisions: repos.revisions, chat: repos.chat, files: objects, blobs: (brandId: string) => new BlobCache(objects, brandId, join(root, ".blobs")) };
const doc = (id: string) => ({ json: { schemaVersion: 1, id, title: id, createdAt: STAMP, updatedAt: STAMP, canvas: { w: 1080, h: 1350 }, prompt: { text: "x", createdAt: STAMP }, slides: [] }, schemaVersion: 1 });
const created = await repos.carousels.create(brand.id, { slug: "week-one", title: "Week one", document: doc("week-one") }, meta);
// What the importer keeps from a folder's chat.jsonl: the whole record as the body.
const proposal = { id: "prop-1", actions: [{ id: "a1", type: "set_text", slideId: "s1", text: "New", why: "asked", provenance: [] }] };
await repos.chat.append(created.id, { id: "msg-1", at: STAMP, role: "user", text: "Change the title" });
await repos.chat.append(created.id, { id: "msg-2", at: STAMP, role: "assistant", text: "Proposed", proposal });

const app = express();
app.use(express.json());
app.use("/api/profiles/:slug", storedBrandGuard(storage));
app.use(chatRouter(() => { throw new Error("no generator in these tests"); }, { storage }));
const failing = express();
failing.use("/api/profiles/:slug", storedBrandGuard({ ...storage, chat: { ...storage.chat, list: async () => { throw new Error("connection refused"); } } }));
failing.use(chatRouter(() => { throw new Error("no generator"); }, { storage: { ...storage, chat: { ...storage.chat, list: async () => { throw new Error("connection refused"); } } } }));
const appendFails = { ...storage, chat: { ...storage.chat, append: async () => { throw new Error("connection refused"); } } };
const failingAppend = express();
failingAppend.use("/api/profiles/:slug", storedBrandGuard(appendFails));
failingAppend.use(chatRouter(() => { throw new Error("no generator"); }, { storage: appendFails }));
const servers = [app, failing, failingAppend].map((a) => a.listen(0, "127.0.0.1"));
await Promise.all(servers.map((srv) => new Promise<void>((resolve) => srv.once("listening", resolve))));
const [base, failingBase, failingAppendBase] = servers.map((srv) => `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/profiles`);
const call = async (path: string, method = "GET", url = base) => {
  const res = await fetch(`${url}${path}`, { method });
  return { status: res.status, body: (await res.json()) as any };
};
const log = async () => (await repos.chat.list(created.id)).map((m) => m.body);

const tests: Array<[string, () => Promise<void>]> = [
  ["the log, the pending proposal and the default currency come from the repository", async () => {
    const got = await call(`/${SLUG}/carousels/week-one/chat`);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.records, await log());
    assert.equal(got.body.pendingProposalId, "prop-1");
    assert.deepEqual(got.body.currency, { code: "USD", rate: 1 });
    assert.equal((await call(`/${SLUG}/carousels/missing/chat`)).status, 404);
    assert.equal(existsSync(join(root, "profiles", SLUG)), false, "no folder appears");
  }],
  ["the currency is the stored config's, read as the folder reads config.yaml (3 letters, a positive rate)", async () => {
    await repos.documents.put(brand.id, "config", "", { json: { currency: { code: "eur", rate: 0.9 } }, schemaVersion: 1 }, meta);
    assert.deepEqual((await call(`/${SLUG}/carousels/week-one/chat`)).body.currency, { code: "EUR", rate: 0.9 });
    await repos.documents.put(brand.id, "config", "", { json: { currency: { code: "EURO", rate: 0.9 } }, schemaVersion: 1 }, { ...meta, expectedVersion: 1 });
    assert.deepEqual((await call(`/${SLUG}/carousels/week-one/chat`)).body.currency, { code: "USD", rate: 1 });
  }],
  ["discarding appends a resolving record, clears the pending proposal, and only the pending one can be discarded", async () => {
    assert.equal((await call(`/${SLUG}/carousels/week-one/chat/proposals/other/discard`, "POST")).status, 409);
    assert.equal((await call(`/${SLUG}/carousels/missing/chat/proposals/prop-1/discard`, "POST")).status, 404);
    const before = (await log()).length;
    const done = await call(`/${SLUG}/carousels/week-one/chat/proposals/prop-1/discard`, "POST");
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.records[0].role, "user");
    assert.deepEqual(done.body.records[0].resolves, { proposalId: "prop-1", decision: "discard" });
    assert.equal((await log()).length, before + 1);
    assert.deepEqual((await log()).at(-1), done.body.records[0]);
    assert.equal((await call(`/${SLUG}/carousels/week-one/chat`)).body.pendingProposalId, null);
    assert.equal((await call(`/${SLUG}/carousels/week-one/chat/proposals/prop-1/discard`, "POST")).status, 409);
  }],
  ["a storage failure is a 503", async () => {
    assert.equal((await call(`/${SLUG}/carousels/week-one/chat`, "GET", failingBase)).status, 503);
  }],
  ["a discard whose append fails is a 503 and appends nothing", async () => {
    const row = await repos.carousels.create(brand.id, { slug: "outage", title: "Outage", document: doc("outage") }, meta);
    await repos.chat.append(row.id, { id: "msg-1", at: STAMP, role: "assistant", text: "Proposed", proposal });
    assert.equal((await call(`/${SLUG}/carousels/outage/chat/proposals/prop-1/discard`, "POST", failingAppendBase)).status, 503);
    assert.equal((await repos.chat.list(row.id)).length, 1);
  }],
  ["an archived brand still shows its chat but refuses a discard (403, nothing appended)", async () => {
    const old = await repos.brands.create({ slug: "old-chat", displayName: "Old" }, meta);
    const oldCut = await repos.brands.markCutover(old.id, { ...meta, expectedVersion: old.version });
    const row = await repos.carousels.create(old.id, { slug: "late", title: "Late", document: doc("late") }, meta);
    await repos.chat.append(row.id, { id: "msg-1", at: STAMP, role: "assistant", text: "Proposed", proposal });
    await repos.brands.archive(old.id, { ...meta, expectedVersion: oldCut.version });
    assert.equal((await call(`/old-chat/carousels/late/chat`)).body.pendingProposalId, "prop-1");
    assert.equal((await call(`/old-chat/carousels/late/chat/proposals/prop-1/discard`, "POST")).status, 403);
    assert.equal((await repos.chat.list(row.id)).length, 1);
  }],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(error as Error).message.split("\n").slice(0, 8).join(" | ")}`);
  }
}
servers.forEach((srv) => srv.close());
rmSync(root, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
