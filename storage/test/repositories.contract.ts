import assert from "node:assert/strict";

import { AlreadyExistsError, InvalidInputError, NotFoundError, VersionConflictError, type WriteMeta } from "../src/contracts/index.ts";
import type { MemoryRepositories } from "../src/memory/index.ts";

export interface Harness {
  repos: MemoryRepositories;
  cleanup(): Promise<void>;
}
/** `now` is the clock the repositories must use, so the suite can move time. */
export type Factory = (now: () => Date) => Promise<Harness>;

const MIN = 60_000;
const meta = (over: Partial<WriteMeta> = {}): WriteMeta => ({ expectedVersion: null, author: "editor", source: "editor", reason: "save", ...over });
const identity = (body: unknown) => body;

/** Behavior every repository implementation must share. */
export async function runRepositoryContract(label: string, factory: Factory): Promise<void> {
  const cases: Record<string, (r: MemoryRepositories, clock: { t: number }) => Promise<void>> = {
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
  };

  let failed = 0;
  for (const [name, fn] of Object.entries(cases)) {
    const clock = { t: Date.parse("2026-01-01T00:00:00Z") };
    const h = await factory(() => new Date(clock.t));
    try {
      await fn(h.repos, clock);
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
