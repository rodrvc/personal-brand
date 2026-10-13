import assert from "node:assert/strict";

import { runChecks } from "@personal-brand/core/checks";
import { toCheckRules } from "../src/revision-policy.ts";
import { AlreadyExistsError, InvalidInputError, NotFoundError, VersionConflictError, type RuleInput, type WriteMeta } from "../src/contracts/index.ts";
import type { MemoryRepositories } from "../src/memory/index.ts";

export interface Harness {
  /** The editor/CLI-content role (brand_app on Postgres). */
  repos: MemoryRepositories;
  /** The role allowed to write rules and guidance (brand_owner on Postgres); the same repos in memory. */
  owner: MemoryRepositories;
  /** True when `repos` is a least-privilege role that must be denied rule/guidance writes. */
  restricted?: boolean;
  cleanup(): Promise<void>;
}
/** `now` is the clock the repositories must use, so the suite can move time. */
export type Factory = (now: () => Date) => Promise<Harness>;

const MIN = 60_000;
const meta = (over: Partial<WriteMeta> = {}): WriteMeta => ({ expectedVersion: null, author: "editor", source: "editor", reason: "save", ...over });
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

    async "least privilege: the app role cannot write rules or guidance"(r, _clock, h) {
      if (!h.restricted) return;
      const a = await r.brands.create({ slug: "acme-coffee", displayName: "A" }, meta());
      const rule: RuleInput = { kind: "slide_count", params: { max: 5 }, severity: "error", appliesTo: ["carousel"], message: "m" };
      await assert.rejects(() => r.rules.create(a.id, rule, meta()), /permission denied/);
      await assert.rejects(() => r.guidance.put(a.id, "x", { description: "", body: "b" }, meta()), /permission denied/);
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
