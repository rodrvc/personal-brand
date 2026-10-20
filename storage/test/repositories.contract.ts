import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { runChecks } from "@personal-brand/core/checks";
import { toCheckRules } from "../src/revision-policy.ts";
import { AlreadyExistsError, InvalidInputError, NotFoundError, VersionConflictError, type AssetInput, type RuleInput, type WriteMeta } from "../src/contracts/index.ts";
import type { MemoryRepositories } from "../src/memory/index.ts";

export interface Harness {
  /** The editor/CLI-content role (brand_app on Postgres). */
  repos: MemoryRepositories;
  /** The role allowed to write rules and guidance (brand_owner on Postgres); the same repos in memory. */
  owner: MemoryRepositories;
  /** True when `repos` is a least-privilege role that must be denied rule/guidance writes. */
  restricted?: boolean;
  /** The stored `carousels.document` JSON, read raw (Postgres only). */
  rawCarouselDocument?(id: string): Promise<unknown>;
  /** A raw `brand_app` connection, to probe constraints and grants (Postgres only). */
  rawSql?: import("postgres").Sql;
  cleanup(): Promise<void>;
}
/** `now` is the clock the repositories must use, so the suite can move time. */
export type Factory = (now: () => Date) => Promise<Harness>;

const MIN = 60_000;
const meta = (over: Partial<WriteMeta> = {}): WriteMeta => ({ expectedVersion: null, author: "editor", source: "editor", reason: "save", ...over });
const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");
const asset = (seed: string, over: Partial<AssetInput> = {}): AssetInput => ({ sha256: sha(seed), kind: "photo", mime: "image/png", bytes: 10, origin: "manual", status: "approved", ...over });
const identity = (body: unknown) => body;

/** Behavior every repository implementation must share. */
export async function runRepositoryContract(label: string, factory: Factory): Promise<void> {
  const cases: Record<string, (r: MemoryRepositories, clock: { t: number }, h: Harness) => Promise<void>> = {
    async "brands: create, get, list, slug uniqueness, archive"(r) {
      const created = await r.brands.create({ slug: "acme-coffee", displayName: "Acme Coffee" }, meta());
      assert.equal(created.version, 1);
      assert.deepEqual(created.value, { slug: "acme-coffee", displayName: "Acme Coffee", status: "active", cutoverAt: null });
      assert.equal((await r.brands.getBySlug("acme-coffee")).id, created.id);
      await assert.rejects(() => r.brands.create({ slug: "acme-coffee", displayName: "Dup" }, meta()), (e) => e instanceof AlreadyExistsError && e instanceof VersionConflictError && e.currentVersion === 1);
      for (const bad of ["Bad Slug", "", "a_b"]) await assert.rejects(() => r.brands.create({ slug: bad, displayName: "x" }, meta()), InvalidInputError);
      await assert.rejects(() => r.brands.getBySlug("nope"), NotFoundError);
      await r.brands.create({ slug: "example", displayName: "Example" }, meta());
      assert.deepEqual((await r.brands.list()).map((b) => b.value.slug), ["acme-coffee", "example"], "listed by slug, not insertion order");
      const archived = await r.brands.archive(created.id, meta({ expectedVersion: 1, reason: "archive" }));
      assert.equal(archived.value.status, "archived");
      assert.deepEqual((await r.brands.list()).map((b) => b.value.slug), ["example"]);
      assert.equal((await r.brands.list({ includeArchived: true })).length, 2);
      assert.equal((await r.brands.unarchive(created.id, meta({ expectedVersion: 2 }))).value.status, "active");
      await assert.rejects(() => r.brands.update("not-an-id", {}, meta({ expectedVersion: 1 })), NotFoundError);
    },

    async "brands: stale update conflicts and changes nothing"(r) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const updated = await r.brands.update(b.id, { displayName: "B" }, meta({ expectedVersion: 1 }));
      assert.equal(updated.version, 2);
      await assert.rejects(() => r.brands.update(b.id, { displayName: "C" }, meta({ expectedVersion: 1 })), (e) => e instanceof VersionConflictError && e.currentVersion === 2);
      assert.equal((await r.brands.getBySlug("acme-coffee")).value.displayName, "B");
      assert.equal((await r.revisions.list("brand", b.id)).length, 2, "a rejected write leaves no revision");
    },

    async "brands: concurrent updates, exactly one wins"(r) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => r.brands.update(b.id, { displayName: `N${i}` }, meta({ expectedVersion: 1 }))),
      );
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      for (const x of results) if (x.status === "rejected") assert.ok(x.reason instanceof VersionConflictError);
      assert.equal((await r.brands.getBySlug("acme-coffee")).version, 2);
      assert.equal((await r.revisions.list("brand", b.id)).length, 2);
    },

    async "documents: put/get/list, templates by name, one-body rule, envelope"(r) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const tokens = await r.documents.put(b.id, "tokens", "", { json: { color: "red" }, schemaVersion: 2 }, meta());
      assert.equal(tokens.version, 1);
      assert.deepEqual((await r.documents.get(b.id, "tokens", "", identity)).value, { color: "red" });
      await r.documents.put(b.id, "identity", "", { text: "# Profile", schemaVersion: 1 }, meta());
      assert.equal((await r.documents.get(b.id, "identity", "", identity)).value, "# Profile");
      await r.documents.put(b.id, "template", "cover", { json: { w: 1 }, schemaVersion: 1 }, meta());
      await r.documents.put(b.id, "template", "outro", { json: { w: 2 }, schemaVersion: 1 }, meta());
      await r.documents.put(b.id, "template", "banner", { json: {}, schemaVersion: 1 }, meta());
      assert.deepEqual((await r.documents.list(b.id, "template")).map((d) => d.name), ["banner", "cover", "outro"]);
      let seen = 0;
      await r.documents.get(b.id, "tokens", "", (body, sv) => ((seen = sv), body));
      assert.equal(seen, 2, "the validator receives the stored schema version");
      await assert.rejects(() => r.documents.get(b.id, "spec", "", identity), NotFoundError);
      await assert.rejects(() => r.documents.get(b.id, "tokens", "", () => { throw new Error("invalid body"); }), /invalid body/);
      for (const bad of [{ json: [1], schemaVersion: 1 }, { json: null, schemaVersion: 1 }, { json: {}, schemaVersion: 0 }, { text: 5 as unknown as string, schemaVersion: 1 }]) {
        await assert.rejects(() => r.documents.put(b.id, "config", "", bad, meta()), InvalidInputError);
      }
      await assert.rejects(() => r.documents.put("00000000-0000-4000-8000-000000000000", "config", "", { json: {}, schemaVersion: 1 }, meta()), NotFoundError);
      // switching a document between json and text keeps exactly one body
      await r.documents.put(b.id, "tokens", "", { text: "now text", schemaVersion: 2 }, meta({ expectedVersion: 1 }));
      assert.equal((await r.documents.get(b.id, "tokens", "", identity)).value, "now text");
    },

    async "documents: versions, conflicts, brand scoping"(r) {
      const a = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const o = await r.brands.create({ slug: "example", displayName: "E" }, meta());
      const body = (n: number) => ({ json: { n }, schemaVersion: 1 });
      await r.documents.put(a.id, "config", "", body(1), meta());
      await assert.rejects(() => r.documents.put(a.id, "config", "", body(2), meta()), (e) => e instanceof AlreadyExistsError && e instanceof VersionConflictError && e.currentVersion === 1);
      await assert.rejects(() => r.documents.put(a.id, "spec", "", body(2), meta({ expectedVersion: 3 })), (e) => e instanceof VersionConflictError && e.currentVersion === null);
      const v2 = await r.documents.put(a.id, "config", "", body(2), meta({ expectedVersion: 1 }));
      assert.equal(v2.version, 2);
      await assert.rejects(() => r.documents.put(a.id, "config", "", body(3), meta({ expectedVersion: 1 })), VersionConflictError);
      await assert.rejects(() => r.documents.get(o.id, "config", "", identity), NotFoundError);
      assert.deepEqual(await r.documents.list(o.id, "config"), []);
      await r.documents.put(o.id, "config", "", body(9), meta());
      assert.deepEqual((await r.documents.get(a.id, "config", "", identity)).value, { n: 2 });
      const results = await Promise.allSettled([4, 5, 6].map((n) => r.documents.put(a.id, "config", "", body(n), meta({ expectedVersion: 2 }))));
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal((await r.documents.get(a.id, "config", "", identity)).version, 3);
    },

    async "revisions: autosave coalescing, author change, non-autosave, append-only"(r, clock) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const put = (n: number, m: Partial<WriteMeta>) => r.documents.put(b.id, "config", "", { json: { n }, schemaVersion: 1 }, meta(m));
      const d = await put(1, { reason: "autosave" });
      const revs = () => r.revisions.list("brand_document", d.id);
      assert.equal((await revs()).length, 1, "first write always has a revision");
      clock.t += 9 * MIN;
      await put(2, { expectedVersion: 1, reason: "autosave" });
      assert.equal((await revs()).length, 1, "same author inside 10 minutes coalesces");
      await put(3, { expectedVersion: 2, reason: "autosave", author: "cli:ana", source: "cli" });
      assert.deepEqual((await revs()).map((x) => x.version), [1, 3], "another author gets a revision");
      await put(4, { expectedVersion: 3, reason: "save" });
      assert.equal((await revs()).length, 3, "a non-autosave reason always appends");
      clock.t += 11 * MIN;
      await put(5, { expectedVersion: 4, reason: "autosave" });
      assert.equal((await revs()).length, 4, "older than 10 minutes appends");
      const all = await revs();
      assert.deepEqual(all.map((x) => x.version), [1, 3, 4, 5]);
      assert.deepEqual(all[3].body, { n: 5 });
      assert.equal(all[1].author, "cli:ana");
      assert.equal((await r.revisions.get("brand_document", d.id, 3)).source, "cli");
      await assert.rejects(() => r.revisions.get("brand_document", d.id, 2), NotFoundError);
      // history is a copy: mutating a returned revision cannot rewrite it
      all[0].author = "tampered";
      assert.equal((await r.revisions.get("brand_document", d.id, 1)).author, "editor");
      const text = await r.documents.put(b.id, "spec", "", { text: "hello", schemaVersion: 1 }, meta({ source: "import", reason: "import", sourceHash: "abc123" }));
      const imported = await r.revisions.get("brand_document", text.id, 1);
      assert.deepEqual([imported.bodyText, imported.body, imported.sourceHash, imported.brandId], ["hello", null, "abc123", b.id]);
    },

    async "rules: validated on write, ordered, versioned, brand scoped, disable"(r, clock, h) {
      const o = h.owner.rules;
      const a = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const other = await r.brands.create({ slug: "example", displayName: "E" }, meta());
      const cover: RuleInput = { kind: "max_length", params: { field: "title", max: 32, slides: "cover" }, severity: "error", appliesTo: ["carousel"], message: "Short covers." };
      const claims: RuleInput = { kind: "forbidden_terms", params: { terms: ["guaranteed"], fields: ["title"] }, severity: "warning", appliesTo: ["carousel", "caption"], message: "No claims." };
      const second = await o.create(a.id, cover, meta());
      clock.t += 1000;
      const first = await o.create(a.id, claims, meta());
      assert.deepEqual(first.value.params, { terms: ["guaranteed"], match: "word", case_sensitive: false, fields: ["title"], slides: "all" }, "defaults are stored");
      assert.deepEqual((await r.rules.list(a.id)).map((x) => x.id), [second.id, first.id], "ordered by creation");
      assert.deepEqual(await r.rules.list(other.id), []);
      for (const bad of [{ ...cover, kind: "regex" }, { ...cover, params: { field: "title", max: 0 } }, { ...cover, severity: "fatal" }, { ...cover, appliesTo: [] }] as unknown as RuleInput[]) {
        await assert.rejects(() => o.create(a.id, bad, meta()), InvalidInputError);
      }
      await assert.rejects(() => o.create("00000000-0000-4000-8000-000000000000", cover, meta()), NotFoundError);
      await assert.rejects(() => o.create(a.id, cover, meta({ expectedVersion: 1 })), VersionConflictError);
      const updated = await o.update(second.id, { params: { field: "title", max: 20 } }, meta({ expectedVersion: 1, reason: "structural" }));
      assert.deepEqual([updated.version, updated.value.params, updated.value.message], [2, { field: "title", max: 20, slides: "all" }, "Short covers."]);
      await assert.rejects(() => o.update(second.id, { message: "x" }, meta({ expectedVersion: 1 })), (e) => e instanceof VersionConflictError && e.currentVersion === 2);
      await assert.rejects(() => o.update(second.id, { params: { max: "x" } }, meta({ expectedVersion: 2 })), InvalidInputError);
      await assert.rejects(() => o.update("not-an-id", {}, meta({ expectedVersion: 1 })), NotFoundError);
      const off = await o.disable(second.id, meta({ expectedVersion: 2 }));
      assert.equal(off.value.enabled, false);
      assert.deepEqual((await r.rules.list(a.id)).map((x) => x.id), [first.id]);
      assert.equal((await r.rules.list(a.id, { includeDisabled: true })).length, 2);
      const on = await o.enable(second.id, meta({ expectedVersion: 3 }));
      assert.deepEqual([on.value.enabled, on.version], [true, 4]);
      const doc = { kind: "carousel" as const, slides: [{ title: "x".repeat(40) }, { title: "guaranteed" }] };
      const found = runChecks(doc, toCheckRules(await r.rules.list(a.id)));
      assert.deepEqual(found.map((f) => [f.ruleId, f.slide]), [[second.id, 0], [first.id, 1]], "findings carry the stored rule id");
      const revs = await r.revisions.list("brand_rule", second.id);
      assert.deepEqual(revs.map((x) => x.version), [1, 2, 3, 4]);
      assert.equal((revs[2].body as { enabled: boolean }).enabled, false);
    },

    async "guidance: trust envelope, versions, names, revisions"(r, _clock, h) {
      const o = h.owner.guidance;
      const a = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const put = await o.put(a.id, "content-fit", { description: "What fits", body: "# Criteria" }, meta());
      assert.deepEqual(await r.guidance.get(a.id, "content-fit"), { trust: "brand-data", id: put.id, name: "content-fit", description: "What fits", body: "# Criteria", version: 1, updatedAt: put.updatedAt });
      await o.put(a.id, "alpha", { description: "", body: "b" }, meta());
      assert.deepEqual((await r.guidance.list(a.id)).map((x) => x.name), ["alpha", "content-fit"]);
      await assert.rejects(() => o.put(a.id, "content-fit", { description: "", body: "x" }, meta()), (e) => e instanceof AlreadyExistsError && e.currentVersion === 1);
      await assert.rejects(() => o.put(a.id, "content-fit", { description: "", body: "x" }, meta({ expectedVersion: 5 })), (e) => e instanceof VersionConflictError && e.currentVersion === 1);
      await assert.rejects(() => o.put(a.id, "Bad Name", { description: "", body: "x" }, meta()), InvalidInputError);
      await assert.rejects(() => o.put("00000000-0000-4000-8000-000000000000", "x", { description: "", body: "x" }, meta()), NotFoundError);
      await assert.rejects(() => r.guidance.get(a.id, "nope"), NotFoundError);
      await assert.rejects(() => o.put(a.id, "big", { description: "", body: "x".repeat(32 * 1024 + 1) }, meta()), InvalidInputError);
      await o.put(a.id, "big", { description: "", body: "x".repeat(32 * 1024) }, meta());
      assert.equal((await o.put(a.id, "content-fit", { description: "v2", body: "# New" }, meta({ expectedVersion: 1 }))).version, 2);
      const revs = await r.revisions.list("brand_guidance", put.id);
      assert.deepEqual(revs.map((x) => [x.version, x.bodyText]), [[1, "# Criteria"], [2, "# New"]], "guidance history supports `--since` diffs");
    },

    async "recipes: put/get with schema version, conflicts, brand scoping"(r) {
      const a = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const other = await r.brands.create({ slug: "example", displayName: "E" }, meta());
      const input = { params: { period: "week", image_hosts: ["cdn.example.test"] }, schemaVersion: 3 };
      const put = await r.recipes.put(a.id, "weekly-roundup", input, meta());
      let seen = 0;
      const got = await r.recipes.get(a.id, "weekly-roundup", (body, sv) => ((seen = sv), body));
      assert.deepEqual([got.value, got.id, seen], [input.params, put.id, 3]);
      await assert.rejects(() => r.recipes.put(a.id, "weekly-roundup", input, meta()), AlreadyExistsError);
      assert.equal((await r.recipes.put(a.id, "weekly-roundup", { params: { period: "day" }, schemaVersion: 4 }, meta({ expectedVersion: 1 }))).version, 2);
      await assert.rejects(() => r.recipes.put(a.id, "weekly-roundup", input, meta({ expectedVersion: 1 })), VersionConflictError);
      await assert.rejects(() => r.recipes.get(other.id, "weekly-roundup", identity), NotFoundError);
      for (const bad of [{ params: [1], schemaVersion: 1 }, { params: {}, schemaVersion: 0 }]) await assert.rejects(() => r.recipes.put(a.id, "reel-week", bad, meta()), InvalidInputError);
      await assert.rejects(() => r.recipes.put(a.id, "Bad Recipe", input, meta()), InvalidInputError);
      await assert.rejects(() => r.recipes.get(a.id, "weekly-roundup", () => { throw new Error("invalid params"); }), /invalid params/);
      assert.deepEqual((await r.revisions.list("brand_recipe", put.id)).map((x) => x.version), [1, 2]);
    },

    async "assets: register, get, ordering, brand scoping, same bytes once"(r, clock) {
      const a = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const o = await r.brands.create({ slug: "example", displayName: "E" }, meta());
      const first = await r.assets.register(a.id, asset("one", { width: 4, height: 3, tags: ["ink:light"], generation: { prompt: "p" } }), meta());
      assert.equal(first.version, 1);
      assert.deepEqual([first.value.assetId, first.value.blobKey], [sha("one").slice(0, 16), `brands/${a.id}/blobs/sha256/${sha("one").slice(0, 2)}/${sha("one")}`]);
      assert.deepEqual([first.value.width, first.value.tags, first.value.generation, first.value.family], [4, ["ink:light"], { prompt: "p" }, null]);
      clock.t += 1000;
      const second = await r.assets.register(a.id, asset("two", { kind: "font", family: "Example Sans" }), meta());
      assert.deepEqual((await r.assets.list(a.id)).map((x) => x.id), [first.id, second.id], "ordered by creation");
      assert.deepEqual((await r.assets.list(a.id, { kind: "font" })).map((x) => x.id), [second.id]);
      assert.deepEqual((await r.assets.get(a.id, first.value.assetId)).value, first.value);
      await assert.rejects(() => r.assets.register(a.id, asset("one"), meta()), (e) => e instanceof AlreadyExistsError && e.currentVersion === 1);
      await r.assets.register(a.id, { ...asset("c"), sha256: "a".repeat(16) + "0".repeat(48) }, meta());
      await assert.rejects(() => r.assets.register(a.id, { ...asset("c"), sha256: "a".repeat(16) + "1".repeat(48) }, meta()), (e) => e instanceof InvalidInputError && /collides/.test(e.message));
      await assert.rejects(() => r.assets.get(o.id, first.value.assetId), NotFoundError);
      assert.deepEqual(await r.assets.list(o.id), []);
      assert.equal((await r.assets.register(o.id, asset("one"), meta())).value.blobKey.includes(o.id), true, "the same bytes are a separate asset per brand");
      for (const bad of [{ sha256: "abc" }, { kind: "video" }, { status: "gone" }, { origin: "x" }, { bytes: -1 }, { width: 0 }, { mime: "" }] as Array<Partial<AssetInput>>) {
        await assert.rejects(() => r.assets.register(a.id, asset("z", bad), meta()), InvalidInputError);
      }
    },

    async "assets: classification updates are versioned and revisioned"(r) {
      const a = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const reg = await r.assets.register(a.id, asset("one", { status: "candidate", origin: "ai" }), meta());
      const up = await r.assets.update(a.id, reg.value.assetId, { kind: "character", tags: ["x"] }, meta({ expectedVersion: 1, reason: "structural" }));
      assert.deepEqual([up.version, up.value.kind, up.value.tags, up.value.status, up.value.origin], [2, "character", ["x"], "candidate", "ai"], "untouched fields keep their value");
      await assert.rejects(() => r.assets.update(a.id, reg.value.assetId, { status: "hidden" }, meta({ expectedVersion: 1 })), (e) => e instanceof VersionConflictError && e.currentVersion === 2);
      await assert.rejects(() => r.assets.update(a.id, reg.value.assetId, { kind: "video" as never }, meta({ expectedVersion: 2 })), InvalidInputError);
      const results = await Promise.allSettled([1, 2, 3].map((n) => r.assets.update(a.id, reg.value.assetId, { tags: [`t${n}`] }, meta({ expectedVersion: 2 }))));
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      assert.deepEqual((await r.revisions.list("brand_asset", reg.id)).map((x) => x.version), [1, 2, 3]);
    },

    async "tts cache: re-takes append, latest is current, brand scoped"(r, clock) {
      const a = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const o = await r.brands.create({ slug: "example", displayName: "E" }, meta());
      const entry = { sha256: sha("audio"), seconds: 2.5, voice: { id: "v1", speed: 1 } };
      await assert.rejects(() => r.tts.get(a.id, "n1"), NotFoundError);
      const rec = await r.tts.record(a.id, "n1", entry);
      assert.deepEqual([rec.sha256, rec.seconds, rec.voice], [entry.sha256, 2.5, entry.voice]);
      assert.deepEqual(await r.tts.record(a.id, "n1", entry), rec, "recording the same audio again returns the stored entry");
      assert.deepEqual(await r.tts.get(a.id, "n1"), rec);
      clock.t += 1000;
      const retake = await r.tts.record(a.id, "n1", { ...entry, sha256: sha("retake"), seconds: 3 });
      assert.deepEqual(await r.tts.get(a.id, "n1"), retake, "the re-take becomes current");
      assert.deepEqual((await r.tts.takes(a.id, "n1")).map((t) => t.sha256), [sha("audio"), sha("retake")], "the old take is kept");
      assert.deepEqual(await r.tts.record(a.id, "n1", entry), rec, "an existing take is returned and does not become current");
      assert.deepEqual(await r.tts.get(a.id, "n1"), retake);
      await assert.rejects(() => r.tts.get(o.id, "n1"), NotFoundError);
      await assert.rejects(() => r.tts.record("00000000-0000-4000-8000-000000000000", "n1", entry), NotFoundError);
      for (const bad of [{ ...entry, sha256: "x" }, { ...entry, seconds: -1 }, { ...entry, voice: [] }]) await assert.rejects(() => r.tts.record(a.id, "n2", bad as never), InvalidInputError);
    },

    async "carousels: status lives in the column, never in the stored document"(r, _clock, h) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const doc = { json: { slides: [1, 2], status: "published" }, schemaVersion: 3 };
      const c = await r.carousels.create(b.id, { slug: "week-1", title: "Week 1", document: doc }, meta());
      assert.deepEqual([c.version, c.value.status], [1, "draft"], "a status inside the document is ignored");
      const seen: Array<[unknown, number]> = [];
      const got = await r.carousels.get(b.id, "week-1", (body, sv) => (seen.push([body, sv]), body));
      assert.deepEqual(seen, [[{ slides: [1, 2], status: "draft" }, 3]], "the validator sees the column status overlaid");
      assert.equal((await r.carousels.getById(c.id, identity)).id, got.id);
      if (h.rawCarouselDocument) assert.deepEqual(await h.rawCarouselDocument(c.id), { slides: [1, 2] });
      const saved = await r.carousels.save(c.id, { title: "Week 1b", document: { json: { slides: [1], status: "scheduled" }, schemaVersion: 3 } }, meta({ expectedVersion: 1 }));
      assert.deepEqual([saved.version, saved.value.status, saved.value.title], [2, "draft", "Week 1b"]);
      if (h.rawCarouselDocument) assert.deepEqual(await h.rawCarouselDocument(c.id), { slides: [1] });
      const st = await r.carousels.setStatus(c.id, { status: "scheduled", scheduledFor: "2026-02-01T10:00:00Z" }, meta({ expectedVersion: 2, reason: "status" }));
      assert.deepEqual([st.value.status, st.value.scheduledFor, st.value.publishedAt], ["scheduled", "2026-02-01T10:00:00.000Z", null]);
      assert.equal((await r.carousels.setStatus(c.id, { status: "published", publishedAt: "2026-02-01T11:00:00Z" }, meta({ expectedVersion: 3, reason: "status" }))).value.scheduledFor, "2026-02-01T10:00:00.000Z");
      assert.deepEqual((await r.revisions.list("carousel", c.id)).map((x) => [x.version, x.reason]), [[1, "save"], [2, "save"], [3, "status"], [4, "status"]]);
      const rev = await r.revisions.get("carousel", c.id, 4);
      assert.equal((rev.body as { status: string }).status, "published");
    },

    async "carousels: list, slug uniqueness, stale save, bad input"(r) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const o = await r.brands.create({ slug: "example", displayName: "E" }, meta());
      const doc = { json: {}, schemaVersion: 1 };
      const second = await r.carousels.create(b.id, { slug: "week-2", title: "Two", document: doc, status: "exported" }, meta());
      const first = await r.carousels.create(b.id, { slug: "week-1", title: "One", document: doc }, meta());
      await r.carousels.create(o.id, { slug: "week-1", title: "Other brand", document: doc }, meta());
      assert.deepEqual((await r.carousels.list(b.id)).map((c) => c.value.slug), ["week-1", "week-2"]);
      assert.deepEqual((await r.carousels.list(b.id, { status: "exported" })).map((c) => c.id), [second.id]);
      await assert.rejects(() => r.carousels.create(b.id, { slug: "week-1", title: "Dup", document: doc }, meta()), (e) => e instanceof AlreadyExistsError && e.currentVersion === 1);
      await assert.rejects(() => r.carousels.create(b.id, { slug: "Bad Slug", title: "x", document: doc }, meta()), InvalidInputError);
      await assert.rejects(() => r.carousels.create(b.id, { slug: "ok", title: "x", document: { json: [] as never, schemaVersion: 1 } }, meta()), InvalidInputError);
      await assert.rejects(() => r.carousels.setStatus(first.id, { status: "gone" as never }, meta({ expectedVersion: 1 })), InvalidInputError);
      await assert.rejects(() => r.carousels.create(b.id, { slug: "ok", title: undefined as never, document: doc }, meta()), InvalidInputError);
      await assert.rejects(() => r.carousels.get(b.id, "nope", identity), NotFoundError);
      await assert.rejects(() => r.carousels.create("00000000-0000-4000-8000-000000000000", { slug: "x", title: "x", document: doc }, meta()), NotFoundError);
      await r.carousels.save(first.id, { document: doc }, meta({ expectedVersion: 1 }));
      await assert.rejects(() => r.carousels.save(first.id, { document: doc }, meta({ expectedVersion: 1 })), (e) => e instanceof VersionConflictError && e.currentVersion === 2);
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => r.carousels.save(first.id, { document: doc }, meta({ expectedVersion: 2 }))));
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal((await r.carousels.getById(first.id, identity)).version, 3);
      assert.equal((await r.revisions.list("carousel", first.id)).length, 3);
    },

    async "exports: concurrent reservations get distinct consecutive versions"(r) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const c = await r.carousels.create(b.id, { slug: "week-1", title: "One", document: { json: {}, schemaVersion: 1 } }, meta());
      const reserved = await Promise.all(Array.from({ length: 8 }, () => r.exports.reserveNextVersion(c.id, 1)));
      assert.deepEqual(reserved.map((e) => e.versionNo).sort((a, z) => a - z), [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.ok(reserved.every((e) => e.status === "running" && e.manifest === null && e.finishedAt === null && e.carouselVersion === 1));
      assert.equal((await r.exports.reserveNextVersion(c.id, 2)).versionNo, 9);
      await assert.rejects(() => r.exports.reserveNextVersion("00000000-0000-4000-8000-000000000000", 1), NotFoundError);
      await assert.rejects(() => r.exports.reserveNextVersion(c.id, 0), InvalidInputError);
    },

    async "exports: complete, fail, and stale running exports are reclaimed as failed"(r, clock) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const c = await r.carousels.create(b.id, { slug: "week-1", title: "One", document: { json: {}, schemaVersion: 1 } }, meta());
      const stale = await r.exports.reserveNextVersion(c.id, 1);
      clock.t += 29 * MIN;
      const fresh = await r.exports.reserveNextVersion(c.id, 1);
      assert.deepEqual((await r.exports.list(c.id)).map((e) => e.status), ["running", "running"], "29 minutes is not stale yet");
      clock.t += 2 * MIN;
      const third = await r.exports.reserveNextVersion(c.id, 2);
      const listed = await r.exports.list(c.id);
      assert.deepEqual(listed.map((e) => [e.versionNo, e.status]), [[1, "failed"], [2, "running"], [3, "running"]], "only the export older than 30 minutes is reclaimed");
      assert.equal(listed[0].finishedAt, new Date(clock.t).toISOString());
      await assert.rejects(() => r.exports.complete(stale.id, { files: [] }), InvalidInputError);
      assert.equal((await r.exports.fail(stale.id)).status, "failed", "failing a finished export is a no-op");
      const done = await r.exports.complete(fresh.id, { files: ["a.png"] });
      assert.deepEqual([done.status, done.manifest, done.finishedAt], ["done", { files: ["a.png"] }, new Date(clock.t).toISOString()]);
      assert.equal((await r.exports.fail(fresh.id)).status, "done");
      assert.equal((await r.exports.fail(third.id)).status, "failed");
      clock.t += 5 * MIN;
      assert.equal((await r.exports.reserveNextVersion(c.id, 2, { staleAfterMs: 1 })).versionNo, 4);
      await assert.rejects(() => r.exports.complete("00000000-0000-4000-8000-000000000000", {}), NotFoundError);
      await assert.rejects(() => r.exports.complete(fresh.id, [] as never), InvalidInputError);
    },

    async "chat: concurrent appends get distinct gap-free seqs, list pages by seq"(r) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const c = await r.carousels.create(b.id, { slug: "week-1", title: "One", document: { json: {}, schemaVersion: 1 } }, meta());
      const other = await r.carousels.create(b.id, { slug: "week-2", title: "Two", document: { json: {}, schemaVersion: 1 } }, meta());
      const seqs = await Promise.all(Array.from({ length: 10 }, (_, i) => r.chat.append(c.id, { n: i })));
      assert.deepEqual([...seqs].sort((a, z) => a - z), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal(await r.chat.append(other.id, { role: "user" }), 1, "seq is per carousel");
      const all = await r.chat.list(c.id);
      assert.deepEqual(all.map((m) => m.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal(all.find((m) => m.seq === seqs[0])!.body.n, 0, "each message keeps the seq it was handed");
      assert.deepEqual((await r.chat.list(c.id, { afterSeq: 4, limit: 3 })).map((m) => m.seq), [5, 6, 7]);
      assert.deepEqual(await r.chat.list("00000000-0000-4000-8000-000000000000"), []);
      for (const bad of [{ limit: -1 }, { afterSeq: 1.5 }, { limit: Number.NaN }]) await assert.rejects(() => r.chat.list(c.id, bad), InvalidInputError);
      await assert.rejects(() => r.chat.append("00000000-0000-4000-8000-000000000000", {}), NotFoundError);
      await assert.rejects(() => r.chat.append(c.id, "hi" as never), InvalidInputError);
    },

    async "carousels and exports: database constraints and grants"(r, _clock, h) {
      const sql = h.rawSql;
      if (!sql) return;
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const c = await r.carousels.create(b.id, { slug: "week-1", title: "One", document: { json: {}, schemaVersion: 1 } }, meta());
      await assert.rejects(() => sql`INSERT INTO carousels (brand_id, slug, title, document, document_schema_version) VALUES (${b.id}, 'raw', 't', '{"status":"draft"}'::jsonb, 1)`, /violates check constraint/);
      const e = await r.exports.reserveNextVersion(c.id, 1);
      await assert.rejects(() => sql`UPDATE exports SET carousel_version = 9 WHERE id = ${e.id}`, /permission denied/);
      await assert.rejects(() => sql`UPDATE exports SET status = 'done' WHERE id = ${e.id}`, /violates check constraint/);
      if (h.restricted) await assert.rejects(() => sql`DELETE FROM chat_messages`, /permission denied/);
    },

    async "content items: create, list filters and order, uniqueness, save, derivation"(r, _clock, h) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const o = await r.brands.create({ slug: "example", displayName: "E" }, meta());
      const zed = await r.content.create(b.id, { slug: "zed", title: "Zed", channel: "newsletter", meta: { stage: "draft", topic: "x" } }, meta());
      const alpha = await r.content.create(b.id, { slug: "alpha", title: "Alpha", stage: "draft", channel: "social", format: "short", bodyMd: "# Hi", derivedFrom: zed.id }, meta());
      const foreign = await r.content.create(o.id, { slug: "alpha", title: "Other brand" }, meta());
      await r.content.create(b.id, { slug: "ab", title: "Ab" }, meta());
      await r.content.create(b.id, { slug: "a-c", title: "A-c" }, meta());
      assert.deepEqual((await r.content.list(b.id)).map((c) => c.value.slug), ["a-c", "ab", "alpha", "zed"], "byte order, not locale order");
      assert.deepEqual((await r.content.list(b.id, { stage: "draft" })).map((c) => c.id), [alpha.id]);
      assert.deepEqual((await r.content.list(b.id, { channel: "newsletter" })).map((c) => c.id), [zed.id]);
      assert.deepEqual((await r.content.list(b.id, { derivedFrom: zed.id })).map((c) => c.id), [alpha.id]);
      assert.equal(alpha.value.derivedFrom, zed.id);
      const got = await r.content.get(b.id, "zed");
      assert.deepEqual([got.value.stage, got.value.bodyMd, got.value.meta, got.value.metaSchemaVersion], ["idea", "", { topic: "x", stage: "idea" }, 1], "stage is overlaid on meta, not taken from the input");
      if (h.rawSql) assert.deepEqual((await h.rawSql`SELECT meta FROM content_items WHERE id = ${zed.id}`)[0].meta, { topic: "x" });
      await assert.rejects(() => r.content.create(b.id, { slug: "alpha", title: "Dup" }, meta()), (e) => e instanceof AlreadyExistsError && e.currentVersion === 1);
      await assert.rejects(() => r.content.create(b.id, { slug: "Bad Slug", title: "x" }, meta()), InvalidInputError);
      await assert.rejects(() => r.content.create(b.id, { slug: "ok", title: "x", channel: "Bad Channel" }, meta()), InvalidInputError);
      await assert.rejects(() => r.content.create(b.id, { slug: "ok", title: "x", stage: "gone" as never }, meta()), InvalidInputError);
      await assert.rejects(() => r.content.create(b.id, { slug: "ok", title: "x", channel: "" }, meta()), InvalidInputError);
      await assert.rejects(() => r.content.create(b.id, { slug: "ok", title: "x", metaSchemaVersion: 0 }, meta()), InvalidInputError);
      await assert.rejects(() => r.content.create(b.id, { slug: "ok", title: "x", meta: [] as never }, meta()), InvalidInputError);
      await assert.rejects(() => r.content.create(b.id, { slug: "ok", title: "x", derivedFrom: foreign.id }, meta()), InvalidInputError);
      await assert.rejects(() => r.content.create(b.id, { slug: "ok", title: "x", derivedFrom: "00000000-0000-4000-8000-000000000000" }, meta()), InvalidInputError);
      await assert.rejects(() => r.content.create(b.id, { slug: "ok", title: "x", stage: "published" }, meta()), InvalidInputError, "published needs a date");
      await assert.rejects(() => r.content.create(b.id, { slug: "ok", title: "x", publishedAt: "2026-02-01T10:00:00Z" }, meta()), InvalidInputError, "a date needs the published stage");
      await assert.rejects(() => r.content.get(b.id, "nope"), NotFoundError);
      await assert.rejects(() => r.content.create("00000000-0000-4000-8000-000000000000", { slug: "x", title: "x" }, meta()), NotFoundError);
      const imported = await r.content.create(b.id, { slug: "old-post", title: "Old", stage: "published", publishedAt: "2025-12-01T10:00:00Z" }, meta({ reason: "import", source: "import" }));
      assert.equal(imported.value.publishedAt, "2025-12-01T10:00:00.000Z");
      const saved = await r.content.save(zed.id, { title: "Zed 2", bodyMd: "text", channel: null, metaSchemaVersion: 2, meta: { stage: "published", topic: "y" } }, meta({ expectedVersion: 1 }));
      assert.deepEqual([saved.version, saved.value.title, saved.value.channel, saved.value.stage], [2, "Zed 2", null, "idea"], "save never changes the stage");
      assert.deepEqual((await r.content.getById(zed.id)).value.meta, { topic: "y", stage: "idea" });
      assert.equal((await r.content.getById(zed.id)).value.metaSchemaVersion, 2);
      await assert.rejects(() => r.content.save(zed.id, { title: "Stale" }, meta({ expectedVersion: 1 })), (e) => e instanceof VersionConflictError && e.currentVersion === 2);
      await assert.rejects(() => r.content.save("00000000-0000-4000-8000-000000000000", {}, meta({ expectedVersion: 1 })), NotFoundError);
      const rev = await r.revisions.get("content_item", zed.id, 2);
      assert.deepEqual([rev.bodyText, (rev.body as { meta: unknown }).meta], ["text", { topic: "y" }]);
    },

    async "content items: stage transitions, published date and revisions"(r) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const item = await r.content.create(b.id, { slug: "post", title: "Post" }, meta());
      const status = (expectedVersion: number) => meta({ expectedVersion, reason: "status" });
      const date = "2026-03-01T09:00:00Z";
      await assert.rejects(() => r.content.setStage(item.id, { stage: "published", publishedAt: date }, status(1)), InvalidInputError, "an idea cannot be published directly");
      assert.equal((await r.content.getById(item.id)).version, 1, "a rejected transition changes nothing");
      await assert.rejects(() => r.content.setStage(item.id, { stage: "gone" as never }, status(1)), InvalidInputError);
      await assert.rejects(() => r.content.setStage(item.id, { stage: "draft" }, meta({ expectedVersion: 1, reason: "autosave" })), InvalidInputError);
      await r.content.setStage(item.id, { stage: "draft" }, status(1));
      await assert.rejects(() => r.content.setStage(item.id, { stage: "published" }, status(2)), InvalidInputError, "publishing needs a date");
      await assert.rejects(() => r.content.setStage(item.id, { stage: "published", publishedAt: "not a date" }, status(2)), InvalidInputError);
      await assert.rejects(() => r.content.setStage(item.id, { stage: "idea", publishedAt: date }, status(2)), InvalidInputError);
      const pub = await r.content.setStage(item.id, { stage: "published", publishedAt: date }, status(2));
      assert.deepEqual([pub.value.stage, pub.value.publishedAt, pub.value.slug], ["published", "2026-03-01T09:00:00.000Z", "post"]);
      const back = await r.content.setStage(item.id, { stage: "draft" }, status(3));
      assert.deepEqual([back.value.stage, back.value.publishedAt], ["draft", null], "leaving published clears the date");
      await r.content.setStage(item.id, { stage: "archived" }, status(4));
      await assert.rejects(() => r.content.setStage(item.id, { stage: "published", publishedAt: date }, status(5)), InvalidInputError, "an archived item cannot be published directly");
      assert.equal((await r.content.setStage(item.id, { stage: "draft" }, status(5))).value.stage, "draft", "archived items can be restored");
      await assert.rejects(() => r.content.setStage(item.id, { stage: "idea" }, status(2)), (e) => e instanceof VersionConflictError && e.currentVersion === 6);
      assert.deepEqual((await r.revisions.list("content_item", item.id)).map((x) => [x.version, x.reason]), [[1, "save"], [2, "status"], [3, "status"], [4, "status"], [5, "status"], [6, "status"]]);
    },

    async "content items: database constraints and grants"(r, _clock, h) {
      const sql = h.rawSql;
      if (!sql) return;
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const item = await r.content.create(b.id, { slug: "post", title: "Post" }, meta());
      await assert.rejects(() => sql`INSERT INTO content_items (brand_id, slug, title, meta) VALUES (${b.id}, 'raw', 't', '{"stage":"idea"}'::jsonb)`, /violates check constraint/);
      await assert.rejects(() => sql`INSERT INTO content_items (brand_id, slug, title, stage) VALUES (${b.id}, 'raw', 't', 'published')`, /violates check constraint/);
      await assert.rejects(() => sql`UPDATE content_items SET derived_from = id WHERE id = ${item.id}`, /violates check constraint/);
      await assert.rejects(() => sql`UPDATE content_items SET derived_from = gen_random_uuid() WHERE id = ${item.id}`, /violates foreign key constraint/);
      await assert.rejects(() => sql`INSERT INTO content_items (brand_id, slug, title, published_at) VALUES (${b.id}, 'raw2', 't', now())`, /violates check constraint/);
      const other = await r.brands.create({ slug: "example", displayName: "E" }, meta());
      const foreign = await r.content.create(other.id, { slug: "post", title: "Other" }, meta());
      await assert.rejects(() => sql`UPDATE content_items SET derived_from = ${foreign.id} WHERE id = ${item.id}`, /violates foreign key constraint/);
      if (h.restricted) await assert.rejects(() => sql`DELETE FROM content_items WHERE id = ${item.id}`, /permission denied/);
    },

    async "recipe runs: create, get, list order and filters, save, storyboard clear, revisions"(r, clock) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const o = await r.brands.create({ slug: "example", displayName: "E" }, meta());
      const input = (json: Record<string, unknown>) => ({ json, schemaVersion: 2 });
      const run = (recipe: string, start: string, end: string) => ({ recipe, periodStart: start, periodEnd: end, input: input({ items: [start] }) });
      const old = await r.runs.create(b.id, run("weekly-reel", "2026-02-02", "2026-02-08"), meta({ author: "alice" }));
      clock.t += 1000;
      const first = await r.runs.create(b.id, run("weekly-reel", "2026-02-09", "2026-02-15"), meta());
      clock.t += 1000;
      const rerun = await r.runs.create(b.id, { ...run("weekly-reel", "2026-02-09", "2026-02-15"), storyboard: { cards: [1] } }, meta());
      clock.t += 1000;
      const other = await r.runs.create(b.id, run("weekly-carousel", "2026-02-09", "2026-02-09"), meta());
      await r.runs.create(o.id, run("weekly-reel", "2026-03-01", "2026-03-07"), meta());
      assert.deepEqual((await r.runs.list(b.id)).map((x) => x.id), [other.id, rerun.id, first.id, old.id], "newest period first, then newest creation");
      assert.deepEqual((await r.runs.list(b.id, { recipe: "weekly-reel" })).map((x) => x.id), [rerun.id, first.id, old.id]);
      assert.deepEqual((await r.runs.list(b.id, { recipe: "weekly-reel", periodStart: "2026-02-09" })).map((x) => x.id), [rerun.id, first.id]);
      assert.deepEqual((await r.runs.list(b.id, { periodStart: "2026-02-02" })).map((x) => x.id), [old.id]);
      const got = await r.runs.get(old.id, (body, v) => ({ body, v }));
      assert.deepEqual(got.value, { recipe: "weekly-reel", periodStart: "2026-02-02", periodEnd: "2026-02-08", schemaVersion: 2, createdBy: "alice", createdAt: got.value.createdAt, input: { body: { items: ["2026-02-02"] }, v: 2 }, storyboard: null });
      await assert.rejects(() => r.runs.get("00000000-0000-4000-8000-000000000000", identity), NotFoundError);
      await assert.rejects(() => r.runs.create(b.id, run("weekly-reel", "2026-02-09", "2026-02-08"), meta()), InvalidInputError);
      await assert.rejects(() => r.runs.create(b.id, run("weekly-reel", "2026-02-30", "2026-03-01"), meta()), InvalidInputError);
      await assert.rejects(() => r.runs.create(b.id, run("Bad Recipe", "2026-02-09", "2026-02-09"), meta()), InvalidInputError);
      await assert.rejects(() => r.runs.create(b.id, { ...run("weekly-reel", "2026-02-09", "2026-02-09"), input: { json: [] as never, schemaVersion: 1 } }, meta()), InvalidInputError);
      await assert.rejects(() => r.runs.create(b.id, { ...run("weekly-reel", "2026-02-09", "2026-02-09"), storyboard: [] as never }, meta()), InvalidInputError);
      await assert.rejects(() => r.runs.create("00000000-0000-4000-8000-000000000000", run("weekly-reel", "2026-02-09", "2026-02-09"), meta()), NotFoundError);
      const kept = await r.runs.save(rerun.id, { input: { json: { items: ["edited"] }, schemaVersion: 3 } }, meta({ expectedVersion: 1, author: "bob" }));
      assert.deepEqual([kept.version, kept.value.schemaVersion, kept.value.createdBy], [2, 3, "editor"], "created_by stays the creator");
      assert.deepEqual((await r.runs.get(rerun.id, identity)).value.storyboard, { cards: [1] }, "undefined keeps the storyboard");
      await r.runs.save(rerun.id, { storyboard: null }, meta({ expectedVersion: 2, author: "bob" }));
      const cleared = await r.runs.get(rerun.id, identity);
      assert.deepEqual([cleared.value.storyboard, cleared.value.input, cleared.version, cleared.value.schemaVersion], [null, { items: ["edited"] }, 3, 3], "a storyboard-only save keeps the schema version");
      await assert.rejects(() => r.runs.save(rerun.id, {}, meta({ expectedVersion: 3 })), InvalidInputError);
      await assert.rejects(() => r.runs.save(rerun.id, { storyboard: { cards: [] } }, meta({ expectedVersion: 1 })), (e) => e instanceof VersionConflictError && e.currentVersion === 3);
      await assert.rejects(() => r.runs.save(rerun.id, { storyboard: [] as never }, meta({ expectedVersion: 3 })), InvalidInputError);
      await assert.rejects(() => r.runs.save("00000000-0000-4000-8000-000000000000", { storyboard: null }, meta({ expectedVersion: 1 })), NotFoundError);
      assert.deepEqual((await r.revisions.list("recipe_run", rerun.id)).map((x) => [x.version, x.author]), [[1, "editor"], [2, "bob"], [3, "bob"]]);
      assert.deepEqual((await r.revisions.get("recipe_run", rerun.id, 3)).body, { ...cleared.value, input: { items: ["edited"] }, storyboard: null });
    },

    async "run artifacts: record dedupes only the current one, current, history, validation"(r, _clock, h) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const run = await r.runs.create(b.id, { recipe: "weekly-reel", periodStart: "2026-02-02", periodEnd: "2026-02-08", input: { json: {}, schemaVersion: 1 } }, meta());
      const clip = (index: number, seed: string, hash = "h1") => ({ kind: "clip" as const, cardIndex: index, cardId: `card-${index}`, sha256: sha(seed), inputsHash: hash });
      const a0 = await r.runArtifacts.record(run.id, clip(0, "a"));
      assert.equal((await r.runArtifacts.record(run.id, clip(0, "a"))).id, a0.id, "the same artifact twice is one row");
      assert.notEqual((await r.runArtifacts.record(run.id, clip(0, "a", "h2"))).id, a0.id, "same bytes, other inputs hash");
      const b0 = await r.runArtifacts.record(run.id, clip(0, "b"));
      const a0again = await r.runArtifacts.record(run.id, clip(0, "a"));
      assert.ok(![a0.id, b0.id].includes(a0again.id) && a0again.seq > b0.seq, "re-rendering back to A inserts a new row");
      assert.equal((await r.runArtifacts.record(run.id, clip(0, "a"))).id, a0again.id);
      await r.runArtifacts.record(run.id, clip(1, "c"));
      await r.runArtifacts.record(run.id, { kind: "audio", cardIndex: 0, cardId: "card-0", sha256: sha("v"), inputsHash: "n1" });
      const timeline = await r.runArtifacts.record(run.id, { kind: "timeline", cardIndex: null, cardId: null, sha256: sha("t"), inputsHash: "t1" });
      assert.deepEqual((await r.runArtifacts.current(run.id)).map((x) => [x.kind, x.cardIndex, x.sha256 === sha("a") || undefined]), [["audio", 0, undefined], ["clip", 0, true], ["clip", 1, undefined], ["timeline", null, undefined]]);
      assert.equal((await r.runArtifacts.current(run.id)).find((x) => x.kind === "clip" && x.cardIndex === 0)!.id, a0again.id);
      assert.deepEqual((await r.runArtifacts.current(run.id, { kind: "clip" })).map((x) => x.cardIndex), [0, 1]);
      assert.deepEqual((await r.runArtifacts.current(run.id, { kind: "timeline" })).map((x) => x.id), [timeline.id]);
      assert.deepEqual((await r.runArtifacts.history(run.id, "clip", 0)).map((x) => x.sha256), [sha("a"), sha("a"), sha("b"), sha("a")], "oldest first");
      assert.deepEqual((await r.runArtifacts.history(run.id, "timeline", null)).map((x) => x.id), [timeline.id]);
      const bad = [
        { ...clip(0, "a"), kind: "video" as never }, { ...clip(0, "a"), cardIndex: null }, { ...clip(0, "a"), cardIndex: -1 }, { ...clip(0, "a"), cardIndex: 1.5 },
        { ...clip(0, "a"), cardId: null }, { ...clip(0, "a"), sha256: "xyz" }, { ...clip(0, "a"), inputsHash: "" },
        { kind: "timeline" as const, cardIndex: 0, cardId: null, sha256: sha("t"), inputsHash: "t1" }, { kind: "timeline" as const, cardIndex: null, cardId: "c", sha256: sha("t"), inputsHash: "t1" },
      ];
      for (const input of bad) await assert.rejects(() => r.runArtifacts.record(run.id, input), InvalidInputError);
      const unknown = "00000000-0000-4000-8000-000000000000";
      await assert.rejects(() => r.runArtifacts.record(unknown, clip(0, "a")), NotFoundError);
      await assert.rejects(() => r.runArtifacts.current(unknown), NotFoundError);
      await assert.rejects(() => r.runArtifacts.history(unknown, "clip", 0), NotFoundError);
      await assert.rejects(() => r.runArtifacts.history(run.id, "timeline", 0), InvalidInputError);
      const sql = h.rawSql;
      if (!sql) return;
      await assert.rejects(() => sql`INSERT INTO run_artifacts (run_id, kind, card_index, sha256, inputs_hash) VALUES (${run.id}, 'timeline', 0, ${sha("z")}, 'x')`, /violates check constraint/);
      await assert.rejects(() => sql`INSERT INTO run_artifacts (run_id, kind, card_index, card_id, sha256, inputs_hash) VALUES (${run.id}, 'clip', 0, 'c', 'ABC', 'x')`, /violates check constraint/);
      await assert.rejects(() => sql`UPDATE recipe_runs SET period_end = '2026-01-01' WHERE id = ${run.id}`, /violates check constraint/);
      if (h.restricted) {
        await assert.rejects(() => sql`UPDATE run_artifacts SET inputs_hash = 'y' WHERE id = ${a0.id}`, /permission denied/);
        await assert.rejects(() => sql`DELETE FROM run_artifacts WHERE id = ${a0.id}`, /permission denied/);
        await assert.rejects(() => sql`DELETE FROM recipe_runs WHERE id = ${run.id}`, /permission denied/);
      }
    },

    async "recipe runs and artifacts: concurrent writers"(r) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const base = { recipe: "weekly-reel", periodStart: "2026-02-02", periodEnd: "2026-02-08", input: { json: {}, schemaVersion: 1 } };
      const [x, y] = await Promise.all([r.runs.create(b.id, base, meta()), r.runs.create(b.id, base, meta())]);
      assert.notEqual(x.id, y.id, "re-runs of one period are allowed");
      const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => r.runs.save(x.id, { storyboard: { i } }, meta({ expectedVersion: 1 }))));
      assert.equal(results.filter((s) => s.status === "fulfilled").length, 1);
      for (const s of results) if (s.status === "rejected") assert.ok(s.reason instanceof VersionConflictError);
      const art = { kind: "clip" as const, cardIndex: 0, cardId: "card-0", sha256: sha("a"), inputsHash: "h1" };
      const rows = await Promise.all([r.runArtifacts.record(x.id, art), r.runArtifacts.record(x.id, art)]);
      const history = await r.runArtifacts.history(x.id, "clip", 0);
      assert.ok(history.length >= 1 && history.length <= 2 && rows.every((row) => history.some((h) => h.id === row.id)));
      const current = await r.runArtifacts.current(x.id);
      assert.equal(current.length, 1);
      assert.ok(rows.some((row) => row.id === current[0].id));
    },

    async "brands: markCutover sets cutoverAt once, idempotently, with a revision"(r, clock) {
      const b = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const done = await r.brands.markCutover(b.id, meta({ expectedVersion: 1, source: "cli", reason: "structural" }));
      assert.equal(done.version, 2);
      assert.equal(done.value.cutoverAt, "2026-01-01T00:00:00.000Z");
      assert.equal((await r.brands.getBySlug("acme-coffee")).value.cutoverAt, done.value.cutoverAt);
      await assert.rejects(() => r.brands.markCutover(b.id, meta({ expectedVersion: 1 })), VersionConflictError);
      clock.t += MIN;
      const again = await r.brands.markCutover(b.id, meta({ expectedVersion: 2, source: "cli", reason: "structural" }));
      assert.equal(again.value.cutoverAt, done.value.cutoverAt, "a second call keeps the first timestamp");
      assert.equal((await r.revisions.list("brand", b.id)).length, 3);
    },

    async "import runs: insert-only log written by the owner role"(r, clock, h) {
      const a = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const run = (n: number) => ({ brandId: a.id, sourceKind: "folder" as const, sourceRootHash: sha(`root${n}`), startedAt: new Date(clock.t + n * 1000).toISOString(), finishedAt: new Date(clock.t + n * 1000 + 1).toISOString(), report: { n } });
      const first = await h.owner.importRuns.record(run(1));
      const second = await h.owner.importRuns.record(run(2));
      assert.notEqual(first.id, second.id);
      assert.deepEqual(second.report, { n: 2 });
      if (h.rawSql) assert.equal((await h.rawSql`SELECT count(*)::int AS n FROM import_runs WHERE brand_id = ${a.id}`)[0].n, 2, "the app role can read them");
      await assert.rejects(() => h.owner.importRuns.record({ ...run(3), brandId: "00000000-0000-4000-8000-000000000000" }), NotFoundError);
    },

    async "least privilege: the app role cannot write rules, guidance or import runs"(r, _clock, h) {
      if (!h.restricted) return;
      const a = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const rule: RuleInput = { kind: "slide_count", params: { max: 5 }, severity: "error", appliesTo: ["carousel"], message: "m" };
      await assert.rejects(() => r.rules.create(a.id, rule, meta()), /permission denied/);
      await assert.rejects(() => r.guidance.put(a.id, "x", { description: "", body: "b" }, meta()), /permission denied/);
      for (const statement of ["UPDATE import_runs SET report = '{}'", "DELETE FROM import_runs"]) {
        await assert.rejects(() => h.rawSql!.unsafe(statement), /permission denied/, `app role: ${statement}`);
      }
      await assert.rejects(() => r.importRuns.record({ brandId: a.id, sourceKind: "folder", sourceRootHash: sha("r"), startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", report: {} }), /permission denied/);
      const created = await h.owner.rules.create(a.id, rule, meta());
      await assert.rejects(() => r.rules.disable(created.id, meta({ expectedVersion: 1 })), /permission denied/);
    },
  };

  let failed = 0;
  for (const [name, fn] of Object.entries(cases)) {
    const clock = { t: Date.parse("2026-01-01T00:00:00Z") };
    const h = await factory(() => new Date(clock.t));
    try {
      await fn(h.repos, clock, h);
      console.log(`  ok - ${label}: ${name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL - ${label}: ${name}\n`, error);
    } finally {
      await h.cleanup();
    }
  }
  if (failed) throw new Error(`${label}: ${failed} contract case(s) failed`);
}
