import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { narrationCacheKey } from "@personal-brand/core/narration";
import postgres from "postgres";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { resolveBrandSource } from "../src/brand-source.ts";
import { FakeObjectStore } from "../src/blob/index.ts";
import { blobKey, carouselExportKey, type BlobStore } from "../src/contracts/index.ts";
import { blobStoreFromEnv, isLocalDatabase, runCli } from "../src/cli/brand.ts";
import { contentRefusal } from "../src/import/allowlist.ts";
import { importBrand, verifyBrand } from "../src/import/importer.ts";
import { DEFAULT_EXPORT_STALE_MS } from "../src/revision-policy.ts";
import { rereadChecked, sha256 } from "../src/import/shared.ts";
import { createMemoryRepositories, type MemoryRepositories } from "../src/memory/index.ts";
import { createPgRepositories } from "../src/pg/index.ts";
import { migrate } from "../src/pg/migrate.ts";

const example = join(import.meta.dirname, "..", "..", "profiles", "example");
const work = mkdtempSync(join(tmpdir(), "brand-cli-"));
const identity = (b: unknown) => b;

/** A throwaway copy of the fictional example brand plus one guidance skill, under the given slug. */
function fixture(label: string, slug: string): string {
  const dir = join(work, label, slug);
  cpSync(example, dir, { recursive: true });
  mkdirSync(join(dir, "skills", "tone"), { recursive: true });
  writeFileSync(join(dir, "skills", "tone", "SKILL.md"), "---\nname: tone\ndescription: How this brand sounds\n---\nBe warm.\n");
  return dir;
}

async function scenario(label: string, repos: MemoryRepositories): Promise<void> {
  const env = { USER: "tester", HOME: join(work, label, "home") }; // a temp home, so no test ever stats the real one
  let recorded = 0;
  const spied = { ...repos, importRuns: { ...repos.importRuns, record: (i: Parameters<typeof repos.importRuns.record>[0]) => (recorded++, repos.importRuns.record(i)) } };
  const blobs = new FakeObjectStore();
  const run = (...argv: string[]) => runCli(argv, env, spied, blobs);
  const dir = fixture(label, "example-coffee");
  const REMOTE = { DATABASE_URL: "postgres://u:p@db.example.com:5432/x" };

  assert.equal((await run()).exitCode, 2, "no verb prints usage");
  const remote = await runCli(["import", "--from", dir], REMOTE, repos);
  assert.equal(remote.exitCode, 6);
  assert.match(remote.lines[0], /remota/);
  const noUrl = await runCli(["import", "--from", dir], {});
  assert.deepEqual([noUrl.exitCode, /DATABASE_URL/.test(noUrl.lines[0])], [1, true], "a missing DATABASE_URL is a clean message, not a stack trace");

  // Each verb accepts only its own flags; a typo never swallows the next argument or reaches a verb that cannot honor it.
  const noDryRun = await runCli(["cutover", "example-coffee", "--confirm", "example-coffee", "--dry-run", "--from", dir], REMOTE, repos);
  assert.equal(noDryRun.exitCode, 2, "cutover has no --dry-run, so the remote gate cannot be skipped");
  assert.equal((await run("import", "--dryrun", "--from", dir)).exitCode, 2);
  assert.equal((await run("import", "--from")).exitCode, 2);
  assert.equal((await run("import", "--from", dir, "stray")).exitCode, 2);
  assert.deepEqual(await repos.brands.list(), [], "refused invocations write nothing");

  const dry = await run("import", "--from", dir, "--dry-run");
  assert.equal(dry.exitCode, 0);
  assert.match(dry.lines.join("\n"), /simulacro/);
  assert.equal((await runCli(["import", `--from=example-coffee`, "--dry-run"], { INIT_CWD: join(work, label), HOME: env.HOME }, repos)).exitCode, 0, "relative --from resolves against INIT_CWD");
  assert.deepEqual(await repos.brands.list(), [], "a dry run writes nothing, not even the brand");
  assert.match((await runCli(["import", "--from", dir, "--dry-run"], env, spied)).lines.join("\n"), /Omitidos: .*assets \(no blob store configured: nothing imported\)/, "without a bucket the assets are reported, never silently dropped");

  const first = await run("import", "--from", dir);
  assert.equal(first.exitCode, 0, first.lines.join("\n"));
  const brand = await repos.brands.getBySlug("example-coffee");
  assert.deepEqual((await repos.guidance.get(brand.id, "tone")).body, "Be warm.\n");
  assert.ok((await repos.recipes.get(brand.id, "reel-week", identity)).value);
  assert.match((await repos.documents.get(brand.id, "identity", "", identity)).value as string, /^# Perfil/);
  assert.ok((await repos.documents.get(brand.id, "tokens", "", identity)).value);
  assert.ok((await repos.documents.get(brand.id, "config", "", identity)).value);
  assert.match(first.lines.join("\n"), /no importado: config\.local\.yaml\.example\./);
  const revisions = (await repos.revisions.list("brand_document", (await repos.documents.get(brand.id, "spec", "", identity)).id)).length;

  const again = await run("import", "--from", dir);
  assert.match(again.lines.join("\n"), /Creados 0, actualizados 0, sin cambios 15, conflictos 0/);
  assert.equal((await repos.documents.get(brand.id, "spec", "", identity)).version, 1, "re-run is a no-op");
  assert.equal((await repos.revisions.list("brand_document", (await repos.documents.get(brand.id, "spec", "", identity)).id)).length, revisions);
  assert.equal(recorded, 2, "each real pass is logged");

  writeFileSync(join(dir, "brand-spec.md"), "# Changed spec\n");
  assert.match((await run("import", "--from", dir)).lines.join("\n"), /actualizados 1/);
  assert.equal((await repos.documents.get(brand.id, "spec", "", identity)).version, 2);

  // A write that lands between classify and write is reported as a conflict; the pass still finishes and is logged.
  writeFileSync(join(dir, "skills", "tone", "SKILL.md"), "---\ndescription: new\n---\nSource moved on\n");
  const racing = { ...spied, guidance: { ...repos.guidance, put: async (...a: Parameters<typeof repos.guidance.put>) => {
    await repos.guidance.put(brand.id, "tone", { description: "x", body: "Racing edit" }, { expectedVersion: 1, author: "editor", source: "editor", reason: "save" });
    return repos.guidance.put(...a);
  } } };
  const before = recorded;
  const raced = await runCli(["import", "--from", dir], env, racing);
  assert.equal(raced.exitCode, 3);
  assert.match(raced.lines.join("\n"), /conflict guidance:tone/);
  assert.equal(recorded, before + 1, "a pass with a conflict still records its import run");
  assert.equal((await repos.guidance.get(brand.id, "tone")).body, "Racing edit");

  // Edited in storage, source untouched since the last import: still a conflict, never "unchanged".
  const spec = await repos.documents.get(brand.id, "spec", "", identity);
  await repos.documents.put(brand.id, "spec", "", { text: "Edited in storage", schemaVersion: 1 }, { expectedVersion: spec.version, author: "editor", source: "editor", reason: "save" });
  const edited = await run("import", "--from", dir);
  assert.match(edited.lines.join("\n"), /conflict document:spec/);
  assert.equal((await repos.documents.get(brand.id, "spec", "", identity)).value, "Edited in storage");
  const refused = await run("cutover", "example-coffee", "--confirm", "example-coffee", "--partial", "--from", dir);
  assert.equal(refused.exitCode, 6, "a dirty verification does not cut over");
  assert.equal((await repos.brands.getBySlug("example-coffee")).value.cutoverAt, null);
  assert.equal(existsSync(join(dir, ".storage-cutover")), false);

  const clean = fixture(label, "example-other-shop");
  assert.equal((await run("cutover", "example-other-shop", "--confirm", "nope", "--from", clean)).exitCode, 6);
  assert.equal(existsSync(join(clean, ".storage-cutover")), false, "no marker without a matching --confirm");
  assert.equal(await resolveBrandSource(repos.brands, "example-other-shop"), "folder");
  writeFileSync(join(work, "outside-guard.txt"), "outside");
  symlinkSync(join(work, "outside-guard.txt"), join(clean, "stray-link.txt"));
  const guarded = await run("cutover", "example-other-shop", "--confirm", "example-other-shop", "--from", clean);
  assert.equal(guarded.exitCode, 6, "data the importer does not carry yet blocks a cutover without --partial");
  assert.match(guarded.lines[0], /sin importar \(stray-link.txt \(not a regular file\)\).*--partial/);
  assert.doesNotMatch(guarded.lines[0], /config\.local/, "files never imported by design are not listed");
  await assert.rejects(() => repos.brands.getBySlug("example-other-shop"), /Not found/);
  const cut = await run("cutover", "example-other-shop", "--confirm", "example-other-shop", "--partial", "--from", clean);
  assert.equal(cut.exitCode, 0, cut.lines.join("\n"));
  const cutBrand = await repos.brands.getBySlug("example-other-shop");
  assert.ok(cutBrand.value.cutoverAt);
  assert.deepEqual(JSON.parse(readFileSync(join(clean, ".storage-cutover"), "utf-8")), { brandId: cutBrand.id, cutoverAt: cutBrand.value.cutoverAt });
  assert.equal(await resolveBrandSource(repos.brands, "example-other-shop"), "storage");

  const reimport = await run("import", "--from", clean);
  assert.equal(reimport.exitCode, 6);
  assert.match(reimport.lines[0], /ya fue cortada/);
  assert.match((await run("cutover", "example-other-shop", "--confirm", "example-other-shop", "--from", clean)).lines[0], /marcador presente/);
  unlinkSync(join(clean, ".storage-cutover"));
  assert.match((await run("cutover", "example-other-shop", "--confirm", "example-other-shop", "--from", clean)).lines[0], /marcador restituido/);
  assert.deepEqual(JSON.parse(readFileSync(join(clean, ".storage-cutover"), "utf-8")), { brandId: cutBrand.id, cutoverAt: cutBrand.value.cutoverAt }, "a deleted marker is restored");

  // A planted dangling symlink is never followed.
  const planted = fixture(label, "example-planted-shop");
  symlinkSync(join(work, "nowhere"), join(planted, ".storage-cutover"));
  assert.equal((await run("cutover", "example-planted-shop", "--confirm", "example-planted-shop", "--from", planted)).exitCode, 6);
  assert.equal(existsSync(join(work, "nowhere")), false);
  assert.equal((await repos.brands.getBySlug("example-planted-shop").catch(() => null)), null, "refused before importing anything");
  // Name must match the slug; the profiles root comes from BRAND_PROFILES_DIR (a temp dir here, never <repo>/profiles).
  const misnamed = await run("cutover", "example-coffee", "--confirm", "example-coffee", "--partial", "--from", clean);
  assert.deepEqual([misnamed.exitCode, /igual que la marca/.test(misnamed.lines[0])], [6, true]);
  fixture(label, "example-home-shop");
  const home = await runCli(["cutover", "example-home-shop", "--confirm", "example-home-shop", "--partial"], { ...env, BRAND_PROFILES_DIR: join(work, label) }, spied);
  assert.equal(home.exitCode, 0, home.lines.join("\n"));
  assert.equal(existsSync(join(work, label, "example-home-shop", ".storage-cutover")), true);

  // The marker cannot be written after markCutover: the brand is cut over, the message says so, and a re-run restores it.
  // Skipped as root: root ignores the mode bits, so the folder would stay writable.
  if (process.getuid?.() !== 0) {
    const locked = fixture(label, "example-locked-shop");
    chmodSync(locked, 0o555);
    try {
      const failed = await run("cutover", "example-locked-shop", "--confirm", "example-locked-shop", "--partial", "--from", locked);
      assert.equal(failed.exitCode, 1);
      assert.match(failed.lines[0], /quedó cortada en storage.*Vuelve a ejecutar/);
      assert.ok((await repos.brands.getBySlug("example-locked-shop")).value.cutoverAt);
    } finally {
      chmodSync(locked, 0o755);
    }
    assert.match((await run("cutover", "example-locked-shop", "--confirm", "example-locked-shop", "--from", locked)).lines[0], /marcador restituido/);
  }

  // A concurrent cutover wrote this brand's marker first: that is success, not an error.
  const twin = fixture(label, "example-twin-shop");
  const twinned = { ...spied, brands: { ...repos.brands, markCutover: async (...a: Parameters<typeof repos.brands.markCutover>) => {
    const done = await repos.brands.markCutover(...a);
    writeFileSync(join(twin, ".storage-cutover"), JSON.stringify({ brandId: done.id, cutoverAt: done.value.cutoverAt }));
    return done;
  } } };
  const twinRun = await runCli(["cutover", "example-twin-shop", "--confirm", "example-twin-shop", "--partial", "--from", twin], env, twinned);
  assert.deepEqual([twinRun.exitCode, /ya estaba cortada/.test(twinRun.lines[0])], [0, true]);

  // The real pass can see more than the dry-run plan did: left-behind entries it reports still refuse without --partial.
  const shifting = fixture(label, "example-shifting-shop");
  for (const left of ["assets", "reels", "content/drafts/README.md", "content/published/README.md", "carousels"]) rmSync(join(shifting, left), { recursive: true, force: true });
  let lookups = 0;
  const shifted = { ...spied, brands: { ...repos.brands, getBySlug: async (...a: Parameters<typeof repos.brands.getBySlug>) => {
    // Lookups: 1 = cutover, 2 = plan, 3 = real pass; the folder gains a passed-over entry just before the real pass scans it.
    if (++lookups === 3) symlinkSync(join(work, "outside-guard.txt"), join(shifting, "recipes", "notes.txt"));
    return repos.brands.getBySlug(...a);
  } } };
  const shiftedRun = await runCli(["cutover", "example-shifting-shop", "--confirm", "example-shifting-shop", "--from", shifting], env, shifted);
  assert.equal(shiftedRun.exitCode, 6, shiftedRun.lines.join("\n"));
  assert.match(shiftedRun.lines[0], /sin importar \(.*notes\.txt.*\).*--partial/);
  assert.equal(existsSync(join(shifting, ".storage-cutover")), false);
  assert.equal((await repos.brands.getBySlug("example-shifting-shop")).value.cutoverAt, null, "the real import ran but the brand is not cut over");

  // Entries passed over are reported, and a symlink is never followed out of the folder.
  const edge = fixture(label, "example-edge-shop");
  mkdirSync(join(edge, "skills", "empty"));
  writeFileSync(join(edge, "recipes", "notes.txt"), "not a recipe");
  writeFileSync(join(work, "outside.yaml"), "recipe: outside\n");
  symlinkSync(join(work, "outside.yaml"), join(edge, "recipes", "linked.yaml"));
  mkdirSync(join(work, "outside-skill"), { recursive: true });
  writeFileSync(join(work, "outside-skill", "SKILL.md"), "---\ndescription: x\n---\nOutside\n");
  symlinkSync(join(work, "outside-skill"), join(edge, "skills", "escaped"));
  const edgeRun = await run("import", "--from", edge);
  assert.equal(edgeRun.exitCode, 0, edgeRun.lines.join("\n"));
  assert.match(edgeRun.lines.join("\n"), /Omitidos: .*skills\/empty\/SKILL\.md \(missing\).*recipes\/linked\.yaml \(not a regular file\).*recipes\/notes\.txt \(not a \.yaml file\)/);
  assert.match(edgeRun.lines.join("\n"), /Guardados como legado, por contenido: 3 archivo\(s\)/, "a stray file is kept as a content-keyed blob, with its reason still reported");
  await assert.rejects(async () => repos.recipes.get((await repos.brands.getBySlug("example-edge-shop")).id, "linked", identity), /Not found/);
  assert.match(edgeRun.lines.join("\n"), /skills\/escaped\/SKILL\.md \(outside the folder\)/, "a symlinked directory pointing out of the folder is not read");
  await assert.rejects(async () => repos.guidance.get((await repos.brands.getBySlug("example-edge-shop")).id, "escaped"), /Not found/);
  symlinkSync(edge, join(work, label, "example-linked-shop"));
  assert.match((await run("import", "--from", join(work, label, "example-linked-shop"), "--dry-run")).lines.join("\n"), /created document:tokens/, "the brand folder itself may be a symlink");

  // A brand created by a concurrent importer is adopted; it does not abort the pass.
  const raceDir = fixture(label, "example-race-shop");
  const creating = { ...spied, brands: { ...repos.brands, create: async (...a: Parameters<typeof repos.brands.create>) => {
    await repos.brands.create({ slug: "example-race-shop", displayName: "other importer" }, a[1]);
    return repos.brands.create(...a);
  } } };
  assert.equal((await runCli(["import", "--from", raceDir], env, creating)).exitCode, 0);
  assert.equal((await repos.documents.get((await repos.brands.getBySlug("example-race-shop")).id, "tokens", "", identity)).version, 1);

  // A pass that throws part-way still leaves a run row saying so, and the caller sees the original error.
  const reports: Array<Record<string, unknown>> = [];
  const failing = { ...repos, importRuns: { ...repos.importRuns, record: (i: Parameters<typeof repos.importRuns.record>[0]) => (reports.push(i.report), repos.importRuns.record(i)) },
    guidance: { ...repos.guidance, put: async () => { throw new Error("disk full"); } } };
  const aborted = await runCli(["import", "--from", fixture(label, "example-abort-shop")], env, failing);
  assert.deepEqual([aborted.exitCode, aborted.lines[0]], [1, "Error: disk full"]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].aborted, "disk full");
  assert.ok((reports[0].counts as { created: number }).created >= 4, "the items done before the failure are counted");

  // If recording the aborted run fails too, that is warned about and the original error is still the one reported.
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void warnings.push(m);
  try {
    const both = { ...failing, importRuns: { ...repos.importRuns, record: async () => { throw new Error("db gone"); } } };
    assert.equal((await runCli(["import", "--from", fixture(label, "example-abort2-shop")], env, both)).lines[0], "Error: disk full");
  } finally {
    console.warn = warn;
  }
  assert.match(warnings[0], /Could not record the aborted import run: db gone/);

  // Content, templates and carousels (with history and chat) import, read back clean, and re-import as a no-op.
  const rich = fixture(label, "example-rich-shop");
  mkdirSync(join(rich, "templates"));
  writeFileSync(join(rich, "templates", "plain.json"), JSON.stringify({ zones: [] }));
  writeFileSync(join(rich, "templates", "broken.json"), "{ not json");
  writeFileSync(join(rich, "templates", "list.json"), "[1]");
  writeFileSync(join(rich, "ideas", "backlog.md"), "# Ideas\n\n- [ ] Open idea\n- [x] Done idea\n- Plain bullet\nstray prose\n");
  mkdirSync(join(rich, "content", "published"), { recursive: true });
  writeFileSync(join(rich, "content", "published", "2026-02-01-launch.md"), "---\ntitulo: Launch\ncanal: linkedin\naprobado: true\n---\nBody\n");
  writeFileSync(join(rich, "content", "published", "undated.md"), "Body without a date\n");
  const car = join(rich, "carousels", "intro");
  mkdirSync(join(car, "versions"), { recursive: true });
  const doc = (title: string, status: string) => JSON.stringify({ schemaVersion: 1, title, status, slides: [] });
  writeFileSync(join(car, "versions", "2026-01-01T00-00-00-000Z.json"), doc("First", "draft"));
  writeFileSync(join(car, "versions", "2026-01-02T00-00-00-000Z.json"), doc("Second", "draft"));
  writeFileSync(join(car, "carousel.json"), doc("Third", "exported"));
  writeFileSync(join(car, "chat.jsonl"), '{"role":"user","text":"hi"}\n{"role":"assistant","text":"hello"}\nnot json\n');
  const richRun = await run("import", "--from", rich);
  assert.equal(richRun.exitCode, 0, richRun.lines.join("\n"));
  const text = richRun.lines.join("\n");
  assert.match(text, /Propuesta de regla \(no creada\): image_hosts .*images\.example\.com.* desde recipe:reel-week/);
  assert.match(text, /content\/published\/undated\.md \(no publication date/);
  assert.match(text, /ideas\/backlog\.md \(1 line\(s\) outside the checklist/);
  assert.match(text, /created run:carousels\/week-input\.json/);
  assert.match(text, /templates\/broken\.json \(not valid JSON\).*templates\/list\.json \(not valid JSON\)/, "a malformed template is skipped and reported; the rest imports");
  const rid = (await repos.brands.getBySlug("example-rich-shop")).id;
  assert.deepEqual((await repos.content.list(rid)).map((c) => [c.value.slug, c.value.stage]), [
    ["2026-01-15-ejemplo-borrador", "draft"], ["2026-02-01-launch", "published"], ["idea-done-idea", "archived"], ["idea-open-idea", "idea"], ["idea-plain-bullet", "idea"],
  ]);
  const launch = (await repos.content.get(rid, "2026-02-01-launch")).value;
  assert.deepEqual([launch.channel, launch.publishedAt, (launch.meta.frontmatter as { aprobado: boolean }).aprobado], ["linkedin", "2026-02-01T00:00:00.000Z", true], "an owner approval stays in meta, not in the stage");
  assert.deepEqual((await repos.content.get(rid, "idea-done-idea")).value.meta, { legacy: { file: "ideas/backlog.md", checked: true }, stage: "archived" }, "get overlays the stage column");
  assert.deepEqual((await repos.documents.get(rid, "template", "plain", identity)).value, { zones: [] });
  const carousel = await repos.carousels.get(rid, "intro", identity);
  assert.deepEqual([carousel.value.title, carousel.value.status], ["Third", "exported"]);
  assert.deepEqual((await repos.revisions.list("carousel", carousel.id)).map((r) => [r.version, r.reason, (r.body as { document: { title: string } }).document.title]), [[1, "import", "First"], [2, "import", "Second"], [3, "import", "Third"], [4, "import", "Third"]], "history oldest first, current last, then the status move");
  assert.deepEqual((await repos.chat.list(carousel.id)).map((m) => m.body.text), ["hi", "hello"]);
  assert.match((await run("import", "--from", rich)).lines.join("\n"), /Creados 0, actualizados 0, sin cambios 18, conflictos 0/, "re-import is a no-op");
  assert.equal((await repos.chat.list(carousel.id)).length, 2);
  // A new snapshot and chat line arrive later: only they are added, in order.
  writeFileSync(join(car, "versions", "2026-01-03T00-00-00-000Z.json"), doc("Fourth", "draft"));
  writeFileSync(join(car, "chat.jsonl"), '{"role":"user","text":"hi"}\n{"role":"assistant","text":"hello"}\n{"role":"user","text":"more"}\n');
  assert.equal((await run("import", "--from", rich)).exitCode, 0);
  assert.equal((await repos.chat.list(carousel.id)).length, 3);
  assert.equal((await repos.carousels.get(rid, "intro", identity)).value.status, "exported");
  assert.equal((await repos.importRuns.list(rid))[0].sourceKind, "folder", "import runs read back, newest first");
  // A checked line moving stage later (file edited) updates in place.
  writeFileSync(join(rich, "ideas", "backlog.md"), "- [x] Open idea\n");
  assert.equal((await run("import", "--from", rich)).exitCode, 0);
  assert.equal((await repos.content.get(rid, "idea-open-idea")).value.stage, "archived");

  // A changed publication date is written, so the stored piece reads back clean and the brand can be cut over.
  writeFileSync(join(rich, "content", "published", "2026-02-01-launch.md"), "---\ntitulo: Launch\ncanal: linkedin\naprobado: true\npublicado: 2026-03-05\n---\nBody\n");
  assert.match((await run("import", "--from", rich)).lines.join("\n"), /actualizados 1,/);
  assert.equal((await repos.content.get(rid, "2026-02-01-launch")).value.publishedAt, "2026-03-05T00:00:00.000Z");
  assert.deepEqual(await verifyBrand(repos, rich, undefined, env), [], "nothing differs after the date moved");

  // An interrupted pass (the second save throws) re-runs as `updated`, then settles as `unchanged`, with history intact.
  writeFileSync(join(car, "versions", "2026-01-04T00-00-00-000Z.json"), doc("Sixth", "draft"));
  writeFileSync(join(car, "versions", "2026-01-05T00-00-00-000Z.json"), doc("Seventh", "draft"));
  let saves = 0;
  const flaky = { ...spied, carousels: { ...repos.carousels, save: (async (...args: Parameters<typeof repos.carousels.save>) => {
    if (++saves === 2) throw new Error("interrupted");
    return repos.carousels.save(...args);
  }) as typeof repos.carousels.save } };
  const titles = async () => (await repos.revisions.list("carousel", carousel.id)).map((r) => (r.body as { document: { title: string } }).document.title);
  const flakyRun = await runCli(["import", "--from", rich], env, flaky);
  assert.equal(flakyRun.exitCode, 1);
  assert.equal((await titles()).includes("Sixth"), true, "the first snapshot was stored before the interruption");
  assert.match((await run("import", "--from", rich)).lines.join("\n"), /actualizados 1,/);
  assert.match((await run("import", "--from", rich)).lines.join("\n"), /actualizados 0, sin cambios 16/);
  const all = await titles();
  assert.deepEqual([all.filter((t) => t === "Sixth").length, all.filter((t) => t === "Seventh").length], [1, 1], "no snapshot is stored twice");

  // An item edited in storage between classify and write is a conflict, and the row keeps that edit.
  writeFileSync(join(car, "carousel.json"), doc("Fifth", "exported"));
  let reads = 0;
  const editRace = { ...spied, carousels: { ...repos.carousels, get: (async <T,>(brandId: string, slug: string, validate: (b: unknown) => T) => {
    const row = await repos.carousels.get(brandId, slug, validate);
    if (++reads === 1) await repos.carousels.save(row.id, { title: "Edited in the app", document: { json: { ...(row.value.document as object), title: "Edited in the app" }, schemaVersion: 1 } }, { expectedVersion: row.version, author: "app", source: "editor", reason: "save" });
    return row;
  }) as typeof repos.carousels.get } };
  const editRaced = await runCli(["import", "--from", rich], env, editRace);
  assert.equal(editRaced.exitCode, 3);
  assert.match(editRaced.lines.join("\n"), /conflictos 1/);
  assert.equal((await repos.carousels.get(rid, "intro", identity)).value.title, "Edited in the app");

  // A row the repository refuses to move (an idea that would become published) is a conflict with its reason; the pass goes on.
  const mover = fixture(label, "example-mover-shop");
  writeFileSync(join(mover, "ideas", "backlog.md"), "- Promote me\n");
  assert.equal((await run("import", "--from", mover)).exitCode, 0);
  writeFileSync(join(mover, "ideas", "backlog.md"), "- Other\n");
  mkdirSync(join(mover, "content", "published"), { recursive: true });
  writeFileSync(join(mover, "content", "published", "idea-promote-me.md"), "---\npublicado: 2026-04-01\n---\nBody\n");
  const moved = await run("import", "--from", mover);
  assert.equal(moved.exitCode, 3, moved.lines.join("\n"));
  assert.match(moved.lines.join("\n"), /conflictos 1/);
  assert.match(moved.lines.join("\n"), /Conflictos: content:idea-promote-me \(cannot publish from idea/);
  assert.doesNotMatch(moved.lines.join("\n"), /Omitidos:.*idea-promote-me/, "a refused move is a conflict with its reason, not a skipped entry");
  const kept = (await repos.content.get((await repos.brands.getBySlug("example-mover-shop")).id, "idea-promote-me")).value;
  assert.deepEqual([kept.stage, kept.title, kept.bodyMd], ["idea", "Promote me", ""], "the refused move wrote nothing");

  // Assets: bytes become blobs, rows get the folder library's classification, and every blob is re-downloaded to verify.
  const lib = fixture(label, "example-assets-shop");
  const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const put = (rel: string, data: Buffer | string) => {
    mkdirSync(dirname(join(lib, "assets", rel)), { recursive: true });
    writeFileSync(join(lib, "assets", rel), data);
  };
  const [logo, gen] = [png("logo"), png("generated")];
  const [logoId, genId] = [sha(logo).slice(0, 16), sha(gen).slice(0, 16)];
  put("copy/logo-again.png", logo);
  put("logo.png", logo);
  put("generated/piece.png", gen);
  put(`generated/${genId}.json`, JSON.stringify({ prompt: "a prompt", model: "m" }));
  put("fonts/Sample-Regular.woff2", "font-a");
  put("fonts/Other-Bold.woff2", "font-b");
  put("fonts/Other-Bold.meta.json", JSON.stringify({ family: "Other Family" }));
  put(`meta/${logoId}.json`, JSON.stringify({ kind: "logo", tags: ["ink:dark"], status: "approved" }));
  put("index.json", JSON.stringify({ entries: [{ id: logoId, w: 120, h: 40 }] }));
  put("notes.json", "{}");
  put("raw.bin", "plain");
  symlinkSync(join(work, "outside.yaml"), join(lib, "assets", "linked.png"));
  const libRun = await run("import", "--from", lib);
  assert.equal(libRun.exitCode, 0, libRun.lines.join("\n"));
  assert.match(libRun.lines.join("\n"), /Creados 20,/);
  for (const reason of [/assets\/logo\.png \(same content as assets\/copy\/logo-again\.png\)/, /assets\/linked\.png \(not a regular file\)/, /assets\/notes\.json \(not an asset/]) assert.match(libRun.lines.join("\n"), reason);
  const lid = (await repos.brands.getBySlug("example-assets-shop")).id;
  const asset = async (id: string) => (await repos.assets.get(lid, id)).value;
  assert.deepEqual(await asset(logoId).then((a) => [a.kind, a.tags, a.status, a.origin, a.mime, a.width, a.height]), ["logo", ["ink:dark"], "approved", "manual", "image/png", 120, 40], "the user's meta sidecar wins; the index only lends its size");
  assert.deepEqual(await asset(genId).then((a) => [a.origin, a.status, a.generation]), ["ai", "candidate", { prompt: "a prompt", model: "m" }]);
  const fonts = (await repos.assets.list(lid, { kind: "font" })).map((a) => [a.value.family, a.value.mime]).sort();
  assert.deepEqual(fonts, [["Other Family", "font/woff2"], ["Sample", "font/woff2"]]);
  assert.deepEqual((await blobs.get(blobKey(lid, sha(logo)))).body, logo);
  assert.deepEqual(await verifyBrand(repos, lib, blobs, env), []);
  const bare = await verifyBrand(repos, lib, new FakeObjectStore(), env);
  assert.equal(bare.filter((k) => k.startsWith("asset:")).length, 8);
  assert.ok(bare.every((k) => /^(asset:[0-9a-f]{16}|legacy:.+) \(blob\)$/.test(k)), "a missing blob is a dirty verification, legacy files included");
  assert.match((await run("import", "--from", lib)).lines.join("\n"), /Creados 0, actualizados 0, sin cambios 20, conflictos 0/);

  put(`meta/${logoId}.json`, JSON.stringify({ kind: "logo", tags: ["ink:light"], status: "approved" }));
  assert.match((await run("import", "--from", lib)).lines.join("\n"), /actualizados 1,/);
  assert.deepEqual((await asset(logoId)).tags, ["ink:light"]);
  assert.deepEqual(await verifyBrand(repos, lib, blobs, env), [], "a re-imported reclassification verifies clean");
  const logoRow = await repos.assets.get(lid, logoId);
  await repos.assets.update(lid, logoId, { status: "hidden" }, { expectedVersion: logoRow.version, author: "editor", source: "editor", reason: "save" });
  put(`meta/${logoId}.json`, JSON.stringify({ kind: "logo", tags: [], status: "approved" }));
  const hidden = await run("import", "--from", lib);
  assert.equal(hidden.exitCode, 3);
  assert.match(hidden.lines.join("\n"), new RegExp(`Conflictos: asset:${logoId} \\(storage changed since the last import\\)`));
  assert.equal((await asset(logoId)).status, "hidden", "a reclassification made in storage is never overwritten");

  // The folder library's scan rules apply anywhere in the path; a bad font sidecar falls back to the file name; orphan sidecars are reported.
  const [nested, late] = [png("nested"), png("late")];
  put("generated/refs/nested.png", nested);
  put("references/generated/both.png", png("both"));
  put("fonts/Fallback-Bold.woff2", "font-c");
  put("fonts/Fallback-Bold.meta.json", JSON.stringify({ family: 42 }));
  put("meta/0123456789abcdef.json", "{}");
  put("late.png", late);
  const lateId = sha(late).slice(0, 16);
  const scan = await run("import", "--from", lib);
  assert.match(scan.lines.join("\n"), /assets\/meta\/0123456789abcdef\.json \(sidecar without an asset\)/);
  assert.deepEqual(await asset(sha(nested).slice(0, 16)).then((a) => [a.origin, a.status]), ["ai", "candidate"]);
  assert.deepEqual(await asset(sha(png("both")).slice(0, 16)).then((a) => [a.origin, a.status]), ["reference", "candidate"], "references wins over generated");
  assert.ok((await repos.assets.list(lid, { kind: "font" })).some((a) => a.value.family === "Fallback"));
  assert.deepEqual(await asset(lateId).then((a) => [a.width, a.height]), [null, null]);
  // The index is a cache: size drift never conflicts, and a malformed or wrongly-shaped one is ignored and reported.
  put("index.json", JSON.stringify({ entries: [{ id: logoId, w: 99, h: 99 }, { id: lateId, w: 64, h: 32 }, null, "x"] }));
  const resized = await run("import", "--from", lib);
  assert.equal(resized.exitCode, 3, "only the earlier reclassification conflict remains");
  assert.match(resized.lines.join("\n"), /conflictos 1\b/);
  assert.doesNotMatch(resized.lines.join("\n"), new RegExp(`${lateId}.*changed in the folder`));
  assert.deepEqual(await asset(lateId).then((a) => [a.width, a.height]), [null, null], "a size is only borrowed at registration");
  assert.deepEqual(await asset(logoId).then((a) => [a.width, a.height]), [120, 40]);
  assert.deepEqual(await verifyBrand(repos, lib, blobs, env), [`asset:${logoId}`], "cache drift adds nothing to the dirty list (the hidden logo is the earlier, deliberate conflict)");
  for (const bad of ["{not json", JSON.stringify({ entries: { a: 1 } }), JSON.stringify([1])]) {
    put("index.json", bad);
    const broken = await run("import", "--from", lib);
    assert.equal(broken.exitCode, 3, "the earlier conflict remains, nothing new");
    assert.match(broken.lines.join("\n"), /assets\/index\.json \(unreadable cache: ignored\)/);
  }
  assert.deepEqual(await verifyBrand(repos, lib, blobs, env), [`asset:${logoId}`]);

  // A font family edited in its sidecar is a reclassification: it updates, and nothing new turns dirty.
  put("fonts/Other-Bold.meta.json", JSON.stringify({ family: "Renamed Family" }));
  assert.match((await run("import", "--from", lib)).lines.join("\n"), /actualizados 1,/);
  assert.ok((await repos.assets.list(lid, { kind: "font" })).some((a) => a.value.family === "Renamed Family"));
  assert.deepEqual(await verifyBrand(repos, lib, blobs, env), [`asset:${logoId}`], "only the conflicted, user-hidden logo is dirty");

  // Runs: the recipe and period are derived (never named by the files) and recorded on the run; the TTS cache is imported only
  // when its hash can be recomputed; undated or multi-week inputs get no run.
  const runShop = fixture(label, "example-runs-shop");
  const [folder, audioDir] = [join(runShop, "reels", "2026-08-10"), join(runShop, "reels", "2026-08-10", "audio")];
  mkdirSync(audioDir, { recursive: true });
  const sb = parseYaml(readFileSync(join(folder, "storyboard.yaml"), "utf-8")) as { cards: Array<{ id: string; narration: string }> };
  const voice = (parseYaml(readFileSync(join(runShop, "recipes", "reel-week.yaml"), "utf-8")) as { voice: { voice_id: string } }).voice;
  const hashes = sb.cards.map((c) => narrationCacheKey(c.narration, voice));
  sb.cards.forEach((c, i) => {
    writeFileSync(join(audioDir, `${c.id}.mp3`), `audio-${c.id}`);
    writeFileSync(join(audioDir, `${c.id}.json`), JSON.stringify({ hash: i === 1 ? "0".repeat(64) : hashes[i], seconds: 2.5 }));
  });
  writeFileSync(join(runShop, "carousels", "undated.json"), JSON.stringify({ slides: [{ title: "x" }] }));
  writeFileSync(join(runShop, "carousels", "two-weeks.json"), JSON.stringify({ slides: [{ date: "2026-07-31" }, { date: "2026-08-03" }] }));
  const runOut = await run("import", "--from", runShop);
  assert.equal(runOut.exitCode, 0, runOut.lines.join("\n"));
  assert.match(runOut.lines.join("\n"), /carousels\/two-weeks\.json \(no run: .*carousels\/undated\.json \(no run:/);
  assert.match(runOut.lines.join("\n"), new RegExp(`reels/2026-08-10/audio/${sb.cards[1].id}\\.mp3 \\(narration hash cannot be recomputed`));
  const runBrand = (await repos.brands.getBySlug("example-runs-shop")).id;
  const runs = await repos.runs.list(runBrand);
  assert.deepEqual(runs.map((r) => [r.value.recipe, r.value.periodStart, r.value.periodEnd]), [["reel-week", "2026-08-10", "2026-08-16"], ["weekly-roundup", "2026-07-27", "2026-08-02"]]);
  const reel = await repos.runs.get(runs[0].id, (b) => b as Record<string, unknown>);
  assert.deepEqual((reel.value.input._imported as { from: string }).from, "reels/2026-08-10/storyboard.yaml");
  assert.equal((reel.value.storyboard as { storyboard: string }).storyboard, "reel");
  assert.equal((reel.value.input.items as unknown[]).length, 3, "the reel run's input is the root week input");
  const audio = await repos.runArtifacts.current(reel.id, { kind: "audio" });
  assert.deepEqual(audio.map((a) => a.cardId), sb.cards.filter((_, i) => i !== 1).map((c) => c.id), "the card whose hash does not match is not imported");
  assert.equal((await repos.tts.get(runBrand, hashes[0])).seconds, 2.5);
  assert.deepEqual((await blobs.get(blobKey(runBrand, audio[0].sha256))).body, Buffer.from(`audio-${sb.cards[0].id}`));
  assert.deepEqual(await verifyBrand(repos, runShop, blobs, env), []);
  assert.match((await run("import", "--from", runShop)).lines.join("\n"), /Creados 0, actualizados 0, sin cambios 15, conflictos 0/);
  assert.equal((await repos.runs.list(runBrand)).length, 2, "a re-import never creates another run");
  writeFileSync(join(folder, "storyboard.yaml"), readFileSync(join(folder, "storyboard.yaml"), "utf-8").replace("min_seconds: 6", "min_seconds: 7"));
  assert.match((await run("import", "--from", runShop)).lines.join("\n"), /actualizados 1,/);
  assert.equal((await repos.runs.get(runs[0].id, identity)).version, 3, "a changed storyboard updates the same run (the first import took two writes: document, then the item hash after the artifacts)");
  // Several period folders: the root input goes only to the run of its own week, and a week without a folder is reported.
  const twoWeeks = fixture(label, "example-two-weeks-shop");
  cpSync(join(twoWeeks, "reels", "2026-08-10"), join(twoWeeks, "reels", "2026-08-17"), { recursive: true });
  rmSync(join(twoWeeks, "reels", "2026-08-17", "audio"), { recursive: true, force: true });
  assert.equal((await run("import", "--from", twoWeeks)).exitCode, 0);
  const twoRuns = await repos.runs.list((await repos.brands.getBySlug("example-two-weeks-shop")).id);
  const byStart = new Map(await Promise.all(twoRuns.filter((r) => r.value.recipe === "reel-week").map(async (r) => [r.value.periodStart, (await repos.runs.get(r.id, identity)).value.input as Record<string, unknown>] as const)));
  assert.equal((byStart.get("2026-08-10")!.items as unknown[]).length, 3, "the run of the input's week carries it");
  assert.equal(byStart.get("2026-08-17")!.items, undefined, "another week's run does not get this week's items");
  const gap = fixture(label, "example-gap-shop");
  cpSync(join(gap, "reels", "2026-08-10"), join(gap, "reels", "2026-08-17"), { recursive: true });
  rmSync(join(gap, "reels", "2026-08-10"), { recursive: true });
  assert.match((await run("import", "--from", gap)).lines.join("\n"), /reels\/week-input\.json \(no run: its week starting 2026-08-10 has no period folder\)/);

  const inputOnly = fixture(label, "example-input-shop");
  rmSync(join(inputOnly, "reels", "2026-08-10"), { recursive: true });
  assert.match((await run("import", "--from", inputOnly)).lines.join("\n"), /created run:reels\/week-input\.json/);
  assert.deepEqual((await repos.runs.list((await repos.brands.getBySlug("example-input-shop")).id)).map((r) => [r.value.recipe, r.value.periodStart]), [["reel-week", "2026-08-10"], ["weekly-roundup", "2026-07-27"]]);
  assert.ok((await verifyBrand(repos, runShop, new FakeObjectStore(), env)).includes("run:reels/2026-08-10/storyboard.yaml (blob)"), "a run whose audio blob is missing is a dirty verification");

  // A foreign take in a slot (neither the planned nor the last imported one) is never overwritten: the run is a conflict.
  const foreign = "f".repeat(64);
  await repos.runArtifacts.record(reel.id, { kind: "audio", cardIndex: 0, cardId: sb.cards[0].id, sha256: foreign, inputsHash: hashes[0] });
  writeFileSync(join(audioDir, `${sb.cards[0].id}.mp3`), "audio-changed");
  const clash = (await run("import", "--from", runShop)).lines.join("\n");
  assert.match(clash, /conflictos 1/);
  assert.match(clash, /audio of card .* was changed in storage since the last import; not overwritten/);
  assert.equal((await repos.runArtifacts.current(reel.id, { kind: "audio" })).find((a) => a.cardIndex === 0)!.sha256, foreign, "the foreign take stays current");
  writeFileSync(join(audioDir, `${sb.cards[0].id}.mp3`), `audio-${sb.cards[0].id}`);

  // A card already imported that later leaves the plan (narration edited after synthesis, or its mp3 removed) is released, never
  // deleted: the next import reports it, the one after is a no-op, verification is clean and the old take stays in history.
  for (const [name, change] of [
    ["example-edited-narration-shop", (f: string) => writeFileSync(join(f, "reels", "2026-08-10", "storyboard.yaml"), readFileSync(join(f, "reels", "2026-08-10", "storyboard.yaml"), "utf-8").replace(sb.cards[0].narration, `${sb.cards[0].narration} Edited.`))],
    ["example-removed-mp3-shop", (f: string) => rmSync(join(f, "reels", "2026-08-10", "audio", `${sb.cards[0].id}.mp3`))],
  ] as const) {
    const shop = fixture(label, name);
    cpSync(join(runShop, "reels"), join(shop, "reels"), { recursive: true });
    writeFileSync(join(shop, "reels", "2026-08-10", "audio", `${sb.cards[0].id}.mp3`), `audio-${sb.cards[0].id}`);
    assert.equal((await run("import", "--from", shop)).exitCode, 0);
    const shopBrand = (await repos.brands.getBySlug(name)).id;
    const shopRun = (await repos.runs.list(shopBrand, { recipe: "reel-week" }))[0];
    const before = (await repos.runArtifacts.current(shopRun.id, { kind: "audio" })).find((a) => a.cardIndex === 0)!;
    change(shop);
    const dropped = await run("import", "--from", shop);
    assert.equal(dropped.exitCode, 0, dropped.lines.join("\n"));
    assert.match(dropped.lines.join("\n"), new RegExp(`audio of card ${sb.cards[0].id} is no longer in the source; its stored take is kept in history`), name);
    assert.match((await run("import", "--from", shop)).lines.join("\n"), /actualizados 0,.*conflictos 0/, `${name}: the following import is a no-op`);
    assert.deepEqual(await verifyBrand(repos, shop, blobs, env), [], name);
    assert.deepEqual((await repos.runArtifacts.history(shopRun.id, "audio", 0)).map((a) => a.sha256), [before.sha256], `${name}: the old take is kept in history`);
    assert.ok(await blobs.get(blobKey(shopBrand, before.sha256)), "its blob is kept");
    assert.match(dropped.lines.join("\n"), /Avisos: /, `${name}: told as a notice`);
  }
  // An `audio` that is a regular file is reported, not a crash.
  const fileAudio = fixture(label, "example-file-audio-shop");
  cpSync(join(runShop, "reels"), join(fileAudio, "reels"), { recursive: true });
  rmSync(join(fileAudio, "reels", "2026-08-10", "audio"), { recursive: true });
  writeFileSync(join(fileAudio, "reels", "2026-08-10", "audio"), "not a directory");
  const fileOut = await run("import", "--from", fileAudio);
  assert.equal(fileOut.exitCode, 0, fileOut.lines.join("\n"));
  assert.match(fileOut.lines.join("\n"), /reels\/2026-08-10\/audio \(not a directory\)/);

  // B2: only known content is kept. Proven secrets (dotfiles, key files, secret content) are refused and reported; guesses (unknown
  // types, suspicious names) are reported apart. Neither reaches the bucket, in the brand folder. Only the guesses
  // are left-behind data, so only they block a cutover.
  const refShop = fixture(label, "example-refusal-shop");
  const secrets: Record<string, string> = {
    ".env": "A=1", ".env.local": "B=2", ".hidden-note.txt": "dot", ".git/config": "git", "cert.pem": "pem", "server.key": "key", "id_rsa": "rsa",
    "node_modules/x.js": "js", "pgp.txt": "-----BEGIN PGP PRIVATE KEY BLOCK-----", "dburl.txt": "postgres://u:p4ss@db/x", "extras/deep.p12": "p12",
    "extras/config.local.yaml": "nested machine config",
  };
  const guesses: Record<string, string> = { "leaky.md": "api_key: abcdefgh12345678", "tokens-ref.json": "{\"accentToken\": \"var(--brand-accent)\"}", ".archive/photo.png": "archived", "extras/.cache/c.png": "cache", "credentials.json": "{}", "deploy-token.txt": "tok", "blob.bin": "bin", "slide.html": "<p>slide</p>", "extras/styles.css": "a{}" };
  const seed = (root: string, files: Record<string, string>) => Object.entries(files).forEach(([rel, data]) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), data)));
  const allowed: Record<string, string> = { "extras/keep.png": "keep-me", "tokens.json": "{\"color\":1}", "design-tokens/colors.json": "{\"c\":2}", "extras/id_123.png": "id-png", "ideas/foto (1).png": "paren-name" };
  seed(refShop, { ...secrets, ...guesses, ...allowed });
  const refRun = await run("import", "--from", refShop);
  assert.equal(refRun.exitCode, 0, refRun.lines.join("\n"));
  const refBrand = (await repos.brands.getBySlug("example-refusal-shop")).id;
  const refusedLine = refRun.lines.find((l) => l.startsWith("Rechazados"))!;
  const unimportedLine = refRun.lines.find((l) => l.startsWith("Sin importar"))!;
  const refusedSecrets = [".env (", ".env.local (", ".hidden-note.txt (", ".git/ (", "cert.pem (", "server.key (", "id_rsa (", "node_modules/ (", "pgp.txt (secret-like: secret pattern", "dburl.txt (secret-like: secret pattern", "extras/deep.p12 (",
    "extras/config.local.yaml (secret-like"];
  for (const entry of refusedSecrets) assert.ok(refusedLine.includes(entry), `${entry} is in the refusal report`);
  for (const entry of ["leaky.md (suspicious content", "tokens-ref.json (suspicious content", ".archive/ (dot-directory", "extras/.cache/ (dot-directory", "credentials.json (suspicious name", "deploy-token.txt (suspicious name", "blob.bin (not a known", "slide.html (not a known", "extras/styles.css (not a known"]) assert.ok(unimportedLine.includes(entry), `${entry} is reported as not imported`);
  for (const data of [...Object.values(secrets), ...Object.values(guesses)]) await assert.rejects(() => blobs.get(blobKey(refBrand, sha(Buffer.from(data)))), `refused content ${data} was not uploaded`);
  const refManifest = Object.keys(((await repos.importRuns.list(refBrand))[0].report.legacy as { manifest: Record<string, string> }).manifest);
  for (const kept of Object.keys(allowed)) assert.ok(refManifest.includes(kept), `${kept} is allowed and kept: brand tokens and numbered ids are not secrets`);
  assert.equal(refManifest.some((k) => /\.env|\.git|\.pem|\.key|id_rsa|id_ed|node_modules|credentials|deploy-token|leaky|tokens-ref|archive|blob\.bin|\.xyz|\.p12|\.html|\.css|pgp|dburl|config\.local/.test(k)), false, "no refused path reaches the manifest");
  const blocked = await run("cutover", "example-refusal-shop", "--confirm", "example-refusal-shop", "--from", refShop);
  assert.equal(blocked.exitCode, 6, "a suspicious name or an unknown type blocks a cutover without --partial");
  assert.match(blocked.lines[0], /slide\.html \(not a known content type\)/);
  assert.match(blocked.lines[0], /deploy-token\.txt \(suspicious name\)/);
  assert.match(blocked.lines[0], /leaky\.md/);
  assert.match(blocked.lines[0], /tokens-ref\.json/);
  assert.match(blocked.lines[0], /\.archive\//);
  assert.doesNotMatch(blocked.lines[0], /\.env|id_rsa|cert\.pem/, "proven secrets are not left-behind data");
  // Proven secrets alone never block.
  const secretOnly = fixture(label, "example-secret-only-shop");
  seed(secretOnly, { ".env": "A=1", "server.key": "key", "leaky.pem.txt": "-----BEGIN RSA PRIVATE KEY-----\nPLACEHOLDER\n-----END RSA PRIVATE KEY-----" });
  assert.equal((await run("cutover", "example-secret-only-shop", "--confirm", "example-secret-only-shop", "--from", secretOnly)).exitCode, 0, "dotfiles, key files and secret content do not block a cutover");
  // A linked directory with no extension is a link to report, not a refusal to hide.
  const linkDir = fixture(label, "example-linked-dir-shop");
  symlinkSync(join(work), join(linkDir, "linked-dir"));
  const linked = await run("cutover", "example-linked-dir-shop", "--confirm", "example-linked-dir-shop", "--from", linkDir);
  assert.equal(linked.exitCode, 6);
  assert.match(linked.lines[0], /linked-dir \(not a regular file\)/);

  // Outputs root (S7b2b3a): `outputs.base_dir` is a second root, confined by realpath. Clips become `clip` artifacts of their card; the
  // rest goes through the same allowlist and two-class policy as the folder, so secrets there are refused and never uploaded.
  const outShop = fixture(label, "example-outputs-shop");
  cpSync(join(runShop, "reels"), join(outShop, "reels"), { recursive: true });
  const outRoot = join(work, label, "outputs-second-root");
  writeFileSync(join(outShop, "config.local.yaml"), `outputs:\n  base_dir: ${outRoot}\n`);
  const fakeSecrets: Record<string, string> = {
    ".env": "A=1", ".env.local": "B=2", ".hidden.txt": "dot", ".git/config": "git", "node_modules/x.js": "js", "cert.pem": "pem", "keys/server.key": "key", "keys/id_rsa": "rsa",
    "stripe.txt": `sk_live_${"0".repeat(24)}`, "restricted.md": `rk_live_${"1".repeat(24)}`, "slack.txt": `xoxb-${"2".repeat(12)}`, "google.json": `{"k":"AIza${"A".repeat(35)}"}`,
    "jwt.txt": `eyJ${"a".repeat(10)}.eyJ${"b".repeat(10)}.${"c".repeat(10)}`, "openssh.txt": "-----BEGIN OPENSSH PRIVATE KEY-----\nPLACEHOLDER", "wide.txt": "-----BEGIN RSA PRIVATE KEY-----",
  };
  const outGuesses: Record<string, string | Buffer> = {
    "credentials.json": "{}", "deploy-token.txt": "tok", "padded.txt": Buffer.from("\ufeff-----BEGIN RSA PRIVATE KEY-----", "utf16le"), "nul.txt": Buffer.from("ok\0data"),
  };
  // With three cards the engine writes unpadded indexes, so `01-<id>.mp4` is not a clip name; a second file for a card is not either.
  const clipNames = [`0-${sb.cards[0].id}.mp4`, `1-${sb.cards[1].id}.mp4`, `01-${sb.cards[1].id}.mp4`];
  const outFiles: Record<string, string | Buffer> = { ...fakeSecrets, ...outGuesses, "reels/2026-08-10/clips/other.mp4": "loose", "2026/slide.png": "slide", "ok.json": "{\"a\":1}" };
  clipNames.forEach((n, i) => (outFiles[`reels/2026-08-10/clips/${n}`] = `clip-${i}`));
  const seedOut = (root: string, files: Record<string, string | Buffer>) => Object.entries(files).forEach(([rel, data]) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), data)));
  seedOut(outRoot, outFiles);
  symlinkSync(join(work, "outside-guard.txt"), join(outRoot, "linked.txt"));
  const outRun = await run("import", "--from", outShop);
  assert.equal(outRun.exitCode, 0, outRun.lines.join("\n"));
  assert.ok(outRun.lines.includes(`Carpeta de salidas leída (fuera de la marca): ${realpathSync(outRoot)}.`), "the resolved outputs path is printed");
  const outBrand = (await repos.brands.getBySlug("example-outputs-shop")).id;
  const outRunRow = (await repos.runs.list(outBrand, { recipe: "reel-week" }))[0];
  const clips = await repos.runArtifacts.current(outRunRow.id, { kind: "clip" });
  assert.deepEqual(clips.map((c) => [c.cardIndex, c.cardId, c.inputsHash === `import:sha256:${c.sha256}`]), [[0, sb.cards[0].id, true], [1, sb.cards[1].id, true]], "only the names the engine writes are clips");
  assert.deepEqual((await blobs.get(blobKey(outBrand, clips[0].sha256))).body, Buffer.from("clip-0"));
  const outRefused = outRun.lines.find((l) => l.startsWith("Rechazados"))!;
  for (const rel of Object.keys(fakeSecrets).map((k) => (k.includes("/") && /^(\.git|node_modules)\//.test(k) ? `${k.split("/")[0]}/` : k))) assert.ok(outRefused.includes(`@outputs/${rel} (`), `@outputs/${rel} is refused`);
  const outUnimported = outRun.lines.find((l) => l.startsWith("Sin importar"))!;
  for (const rel of ["padded.txt", "nul.txt"]) assert.ok(outUnimported.includes(`@outputs/${rel} (suspicious content: not plain UTF-8 text)`), `${rel} (UTF-16 or NUL) is a guess, never uploaded`);
  assert.ok(outUnimported.includes("@outputs/credentials.json (suspicious name)") && outUnimported.includes("@outputs/deploy-token.txt (suspicious name)"), "suspicious names in the second root are guesses");
  assert.match(outRun.lines.join("\n"), /@outputs\/linked\.txt \(not a regular file\)/, "a link in the second root is reported, never read");
  const outManifest = Object.keys(((await repos.importRuns.list(outBrand))[0].report.legacy as { manifest: Record<string, string> }).manifest).filter((k) => k.startsWith("@outputs/")).sort();
  assert.deepEqual(outManifest, ["@outputs/2026/slide.png", "@outputs/ok.json", `@outputs/reels/2026-08-10/clips/${clipNames[2]}`, "@outputs/reels/2026-08-10/clips/other.mp4"], "what no collector claimed and the allowlist accepts is kept, with its path");
  for (const data of [...Object.values(fakeSecrets), ...Object.values(outGuesses)]) await assert.rejects(() => blobs.get(blobKey(outBrand, sha(Buffer.from(data)))), "no refused content was uploaded");
  assert.deepEqual(await verifyBrand(repos, outShop, blobs, env), [], "verify reads the same second root");
  const outCut = await run("cutover", "example-outputs-shop", "--confirm", "example-outputs-shop", "--from", outShop);
  assert.equal(outCut.exitCode, 6, "the guesses and the link in the second root block a cutover");
  for (const reason of ["@outputs/credentials.json (suspicious name)", "@outputs/deploy-token.txt (suspicious name)", "@outputs/padded.txt (suspicious content", "@outputs/nul.txt (suspicious content", "@outputs/linked.txt (not a regular file)"]) assert.ok(outCut.lines[0].includes(reason), `${reason} blocks the cutover`);
  assert.doesNotMatch(outCut.lines[0], /\.env|cert\.pem|id_rsa|stripe|jwt/, "proven secrets in the second root do not block");
  // Clips: a re-import is a no-op; a re-rendered clip is an update that keeps the old take in history; a foreign clip in storage is a conflict.
  assert.match((await run("import", "--from", outShop)).lines.join("\n"), /Creados 0, actualizados 0, sin cambios \d+, conflictos 0\./);
  writeFileSync(join(outRoot, "reels", "2026-08-10", "clips", clipNames[0]), "clip-0-rerendered");
  assert.match((await run("import", "--from", outShop)).lines.join("\n"), /Creados 0, actualizados 1,/);
  assert.deepEqual((await repos.runArtifacts.history(outRunRow.id, "clip", 0)).map((a) => a.sha256).sort(), [sha(Buffer.from("clip-0")), sha(Buffer.from("clip-0-rerendered"))].sort(), "the old take stays in history");
  await repos.runArtifacts.record(outRunRow.id, { kind: "clip", cardIndex: 1, cardId: sb.cards[1].id, sha256: "f".repeat(64), inputsHash: `import:sha256:${"f".repeat(64)}` });
  writeFileSync(join(outRoot, "reels", "2026-08-10", "clips", clipNames[1]), "clip-1-rerendered");
  const clipClash = await run("import", "--from", outShop);
  assert.match(clipClash.lines.join("\n"), /conflictos 1/);
  assert.equal((await repos.runArtifacts.current(outRunRow.id, { kind: "clip" })).find((a) => a.cardIndex === 1)!.sha256, "f".repeat(64), "the foreign clip stays current");

  // The engine pads clip indexes to the width of the last index (11+ cards): padded names are clips there, unpadded ones are legacy.
  const wide = fixture(label, "example-wide-shop");
  cpSync(join(runShop, "reels"), join(wide, "reels"), { recursive: true });
  rmSync(join(wide, "reels", "2026-08-10", "audio"), { recursive: true });
  const wideSb = parseYaml(readFileSync(join(wide, "reels", "2026-08-10", "storyboard.yaml"), "utf-8")) as { cards: Array<Record<string, unknown>> };
  wideSb.cards = Array.from({ length: 11 }, (_, i) => ({ ...wideSb.cards[0], id: `card-${i}` }));
  writeFileSync(join(wide, "reels", "2026-08-10", "storyboard.yaml"), stringifyYaml(wideSb));
  const wideRoot = join(work, label, "outputs-wide");
  writeFileSync(join(wide, "config.local.yaml"), `outputs:\n  base_dir: ${wideRoot}\n`);
  seedOut(wideRoot, { "reels/2026-08-10/clips/01-card-1.mp4": "w1", "reels/2026-08-10/clips/2-card-2.mp4": "w2", "reels/2026-08-10/clips/10-card-10.mp4": "w10" });
  assert.equal((await run("import", "--from", wide)).exitCode, 0);
  const wideBrand = (await repos.brands.getBySlug("example-wide-shop")).id;
  const wideClips = await repos.runArtifacts.current((await repos.runs.list(wideBrand, { recipe: "reel-week" }))[0].id, { kind: "clip" });
  assert.deepEqual(wideClips.map((c) => [c.cardIndex, c.cardId]), [[1, "card-1"], [10, "card-10"]], "padded names are the clips of an 11-card storyboard");
  assert.deepEqual(Object.keys(((await repos.importRuns.list(wideBrand))[0].report.legacy as { manifest: Record<string, string> }).manifest).filter((k) => k.startsWith("@outputs/")), ["@outputs/reels/2026-08-10/clips/2-card-2.mp4"], "an unpadded name is not a clip there");

  // A brand-folder entry named `@...` could be mistaken for the second root's label, so it is a guess; the report's `@outputs/` skips
  // are never re-walked against the brand folder.
  const atShop = fixture(label, "example-at-shop");
  seedOut(atShop, { "@outputs/linked.txt": "in the folder" });
  const atRoot = join(work, label, "outputs-at");
  mkdirSync(atRoot, { recursive: true });
  symlinkSync(join(work, "outside-guard.txt"), join(atRoot, "linked.txt"));
  writeFileSync(join(atShop, "config.local.yaml"), `outputs:\n  base_dir: ${atRoot}\n`);
  const atOut = (await run("import", "--from", atShop)).lines.join("\n");
  assert.match(atOut, /Sin importar .*: @outputs\/ \(name starts with @/);
  assert.match(atOut, /@outputs\/linked\.txt \(not a regular file\)/);
  const atManifest = Object.keys(((await repos.importRuns.list((await repos.brands.getBySlug("example-at-shop")).id))[0].report.legacy as { manifest: Record<string, string> }).manifest);
  assert.equal(atManifest.some((k) => k.startsWith("@")), false, "nothing under the folder's `@outputs` reaches the manifest");

  // Outputs-root problems are reported, never dropped: a missing configured root is a notice; "/", an ancestor of the folder, or an
  // `outputs.reels` leaving the root are unusable and block a cutover; without a blob store an outside root is left behind whole.
  const problem = (name: string, config: string) => {
    const shop = fixture(label, name);
    writeFileSync(join(shop, "config.local.yaml"), config);
    return shop;
  };
  const missing = await run("import", "--from", problem("example-missing-out-shop", `outputs:\n  base_dir: ${join(work, label, "no-such-outputs")}\n`), "--dry-run");
  assert.match(missing.lines.join("\n"), /Avisos: .*outputs root .*no-such-outputs does not exist/);
  for (const [name, config, why] of [
    ["example-slash-out-shop", "outputs:\n  base_dir: /\n", "is \"/\" or an ancestor of the brand folder"],
    ["example-parent-out-shop", `outputs:\n  base_dir: ${join(work, label)}\n`, "is \"/\" or an ancestor of the brand folder"],
    ["example-escape-out-shop", `outputs:\n  base_dir: ${outRoot}\n  reels: ../elsewhere\n`, "leaves the outputs root"],
  ] as const) {
    const shop = problem(name, config);
    const out = (await run("import", "--from", shop, "--dry-run")).lines.join("\n");
    assert.ok(out.includes("@outputs/ (outputs") && out.includes(why), `${name} is reported as skipped`);
    const cut = await run("cutover", name, "--confirm", name, "--from", shop);
    assert.equal(cut.exitCode, 6, `${name} blocks a cutover`);
    assert.match(cut.lines[0], /@outputs\/ \(outputs/);
  }
  assert.match((await runCli(["import", "--from", outShop, "--dry-run"], env, spied)).lines.join("\n"), /Omitidos: .*@outputs\/ \(no blob store\)/);
  // A root that cannot be resolved for any reason but "not there" (here EACCES: its parent is not searchable) is unusable, so it blocks
  // a cutover. Skipped as root: root ignores the mode bits.
  if (process.getuid?.() !== 0) {
    const sealed = join(work, label, "sealed-outputs");
    mkdirSync(join(sealed, "inner"), { recursive: true });
    const sealedShop = problem("example-sealed-out-shop", `outputs:\n  base_dir: ${join(sealed, "inner")}\n`);
    chmodSync(sealed, 0o000);
    try {
      const cut = await run("cutover", "example-sealed-out-shop", "--confirm", "example-sealed-out-shop", "--from", sealedShop);
      assert.equal(cut.exitCode, 6);
      assert.match(cut.lines[0], /@outputs\/ \(outputs root .* cannot be resolved \(EACCES\)/);
    } finally {
      chmodSync(sealed, 0o755);
    }
  }

  // `outputs` in the folder linking to the outputs root is that root, not a link to report; BRAND_OUTPUTS_ROOT/<slug> replaces the
  // configured folder and its files are imported.
  const linkedOut = fixture(label, "example-linked-out-shop");
  const linkedRoot = join(work, label, "outputs-linked");
  seedOut(linkedRoot, { "kept.png": "kept" });
  symlinkSync(linkedRoot, join(linkedOut, "outputs"));
  const linkedRun = (await run("import", "--from", linkedOut)).lines.join("\n");
  assert.doesNotMatch(linkedRun, /outputs \(not a regular file\)/);
  assert.match(linkedRun, /Guardados como legado/);
  const envShop = fixture(label, "example-env-root-shop");
  const envOutputs = { ...env, BRAND_OUTPUTS_ROOT: join(work, label, "env-outputs") };
  seedOut(join(envOutputs.BRAND_OUTPUTS_ROOT, "example-env-root-shop"), { "keep.json": "{\"a\":1}" });
  const envRun = await runCli(["import", "--from", envShop], envOutputs, spied, blobs);
  assert.ok(envRun.lines.includes(`Carpeta de salidas leída (fuera de la marca): ${realpathSync(join(envOutputs.BRAND_OUTPUTS_ROOT, "example-env-root-shop"))}.`));
  const envManifest = Object.keys(((await repos.importRuns.list((await repos.brands.getBySlug("example-env-root-shop")).id))[0].report.legacy as { manifest: Record<string, string> }).manifest);
  assert.ok(envManifest.includes("@outputs/keep.json"), "a file in the env root is imported");
  assert.deepEqual(await verifyBrand(repos, envShop, blobs, envOutputs), []);
  assert.equal(contentRefusal("a.json", Buffer.from("{\"eyJ\":\"a.b.c\",\"sk_live\":\"x\"}")), null);
  // The importer and `asset add` share these: signatures over the raw bytes of every type, docker auth, SVG active content.
  assert.equal(contentRefusal("a.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from(`AKIA${"A".repeat(16)}`)]))?.kind, "unknown", "a token inside a binary is a guess, not a proof");
  assert.equal(contentRefusal("f.ttf", Buffer.concat([Buffer.from([0, 1, 0, 0, 0]), Buffer.from("name table http://x.commailto:y@z.example")])), null, "a font name table is not a URL credential");
  const started = Date.now();
  assert.equal(contentRefusal("a.txt", Buffer.from("a-".repeat(100_000))), null);
  assert.ok(Date.now() - started < 1000, "a long a-a-a- input is scanned in linear time");
  assert.equal(contentRefusal("a.woff", Buffer.from([0x77, 0x4f, 0x46, 0x46, 0, 1, 2, 3])), null);
  assert.equal(contentRefusal("c.json", Buffer.from('{"auth": "dXNlcjpwYXNzd29yZDEyMw=="}'))?.kind, "secret");
  assert.equal(contentRefusal("c.json", Buffer.from('{"auth": "short"}')), null);
  const hostile = [
    "<svg><script>x()</script></svg>", '<svg onclick = "x()"/>', "<svg><foreignObject/></svg>", '<svg><a href="//example.test/x"/></svg>', '<svg><a href="javascript:x()"/></svg>',
    '<svg><use href="&#106;avascript:x()"/></svg>', '<svg><use href="java\nscript:x()"/></svg>', "<svg:svg><svg:script>x()</svg:script></svg:svg>",
    "<svg><a.b:script>x()</a.b:script></svg>", "<svg><é:script>x()</é:script></svg>", "<svg><svg:foreignObject/></svg>",
    '<svg><animate attributeName="href" values="//evil"/></svg>', '<svg><set attributeName="href" to="//evil"/></svg>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///x">]><svg>&xxe;</svg>', '<?xml-stylesheet href="a.css"?><svg/>', "<svg><![CDATA[x]]></svg>", "<svg><?php x ?></svg>",
    "<svg><style>@import url(https://example.test/a.css);</style></svg>", '<svg><rect style="fill:url(//example.test/a)"/></svg>',
    '<svg><rect style="fill:url(&#x68;ttps://example.test/a)"/></svg>', '<svg><rect style="&#64;import"/></svg>', '<svg><rect style="fill:url(\\68ttps://example.test/a)"/></svg>',
    '<svg><rect style="@\\69mport"/></svg>', "<!--> <script>alert(1)</script> --><svg/>", "<!---> <script>alert(1)</script> --><svg/>", "<!-- --!> <script>alert(1)</script> --><svg/>",
    "<!--><img src=x onerror=alert(1)>--><svg/>", "<svg><!-- never closed", '<svg><rect fill="image-set(url(#a) 1x)"/></svg>', '<svg><rect style="background:-webkit-image-set(x 1x)"/></svg>',
    '<svg><rect style="fill:cross-fade(a, b)"/></svg>', '<svg><rect style="fill:element(#a)"/></svg>', '<svg><rect style="fill:src(x)"/></svg>', '<svg><rect xlink:onload="x()"/></svg>',
    '<rect a="<!--" onmouseover="alert(1)" b="-->" width="1"/>', '<svg a="<!--" onload="alert(1)" b="-->"/>', '<rect a="<!--" style="fill:url(https://example.test/a)" b="-->"/>',
    '<svg xmlns="https://example.test/ns"/>', '<svg xml:base="https://example.test/"/>', '<svg><rect title=">" onload="x()"/></svg>', "<svg><rect fill=red/></svg>", '<svg><image href="https://example.test/a.png"/></svg>',
  ];
  for (const svg of hostile) assert.equal(contentRefusal("a.svg", Buffer.from(svg))?.kind, "unknown", svg);
  const svgLogo = '<?xml version="1.0"?><!-- logo --><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="g"><stop offset="0" stop-color="#111"/></linearGradient></defs><rect fill="url(#g)" width="4" height="4"/><text>Prices from 10:00 &amp; up</text></svg>';
  assert.equal(contentRefusal("a.svg", Buffer.from(svgLogo)), null, "a normal logo, and text with a colon, are accepted");
  // Linear time on 2 MB hostile inputs: each must finish well inside a second (they take milliseconds when linear, minutes when quadratic).
  const MB2 = 2 * 1024 * 1024;
  for (const [file, body] of [["a.svg", "url(" + " ".repeat(MB2) + "x"], ["a.svg", `<svg style="fill:url(${" ".repeat(MB2)}x"/>`], ["a.svg", "<svg" + " ".repeat(MB2) + "x"], ["a.svg", "<!--".repeat(MB2 / 4)],
    ["a.svg", `<svg fill="${"a".repeat(MB2)}"/>`], ["a.png", "eyJ-".repeat(MB2 / 4)], ["a.txt", "eyJ-".repeat(MB2 / 4)], ["a.txt", "a-".repeat(MB2 / 2)]] as const) {
    const t0 = Date.now();
    contentRefusal(file, Buffer.from(body));
    assert.ok(Date.now() - t0 < 1000, `${file} ${body.slice(0, 12)}: scanned in linear time`);
  }
  // Runs of ~6 MB must not overflow the regex stack (a RangeError would abort an import): refused or accepted, never thrown.
  const MB6 = 6 * 1024 * 1024;
  for (const [file, body] of [["a.txt", `ghp_${"a".repeat(MB6)}`], ["a.txt", `"auth": "${"A".repeat(MB6)}`], ["a.txt", "-----BEGIN " + "A".repeat(MB6)], ["a.txt", "eyJ" + "a".repeat(MB6) + ".eyJ"],
    ["a.txt", "sk-" + "a".repeat(MB6)], ["a.txt", "password:" + "a".repeat(MB6)], ["a.svg", "<svg" + ' a="b"'.repeat(MB6 / 6) + "/>"], ["a.png", `AKIA${"A".repeat(MB6)}`], ["a.png", "-----BEGIN " + "A".repeat(MB6)]] as const) {
    // contentRefusal catches a throw and answers "could not be scanned": that answer means a regex overflowed.
    assert.notEqual(contentRefusal(file, Buffer.from(body))?.why, "suspicious content: could not be scanned", `${file} ${body.slice(0, 12)}`);
  }
  // A binary is searched by literal and only a window is decoded: a secret deep inside a large file is found without a string of the whole file.
  const big = Buffer.alloc(32 * 1024 * 1024);
  Buffer.from(`\n${`AKIA${"A".repeat(16)}`}\n`).copy(big, 20 * 1024 * 1024);
  const originalToString = Buffer.prototype.toString;
  let longest = 0;
  Buffer.prototype.toString = function (this: Buffer, ...a: Parameters<Buffer["toString"]>) { longest = Math.max(longest, this.length); return originalToString.apply(this, a); };
  try {
    assert.equal(contentRefusal("big.mp4", big)?.kind, "unknown", "a token deep inside a large binary is found");
    assert.equal(contentRefusal("clean.mp4", Buffer.alloc(32 * 1024 * 1024)), null);
  } finally {
    Buffer.prototype.toString = originalToString;
  }
  assert.ok(longest > 0 && longest < 64 * 1024, `only a window was decoded (${longest} bytes)`);
  const jwt = `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`;
  assert.equal(contentRefusal("a.txt", Buffer.from(`x ${jwt}`))?.kind, "secret", "a real JWT still matches");
  assert.equal(contentRefusal("a.png", Buffer.concat([Buffer.from([0x89, 0x50]), Buffer.from(` ${jwt}`)]))?.kind, "unknown");
  assert.equal(contentRefusal("a.svg", Buffer.from('<svg><image xlink:href="data:image/png;base64,iVBORw0KGgo="/></svg>')), null, "an inline raster image is allowed");
  assert.equal(contentRefusal("a.svg", Buffer.from('<svg><use href="#a"/><path d="M0 0"/></svg>')), null, "an internal reference is not active content");

  // B3: a file that cannot be read inside a skipped folder is reported, so it counts as left behind at cutover.
  const strayShop = fixture(label, "example-stray-reel-shop");
  cpSync(join(runShop, "reels"), join(strayShop, "reels"), { recursive: true });
  mkdirSync(join(strayShop, "reels", "stray"));
  symlinkSync(join(work, "outside-guard.txt"), join(strayShop, "reels", "stray", "link.txt"));
  const strayCut = await run("cutover", "example-stray-reel-shop", "--confirm", "example-stray-reel-shop", "--from", strayShop);
  assert.equal(strayCut.exitCode, 6);
  assert.match(strayCut.lines.join("\n"), /reels\/stray\/link\.txt \(not a regular file\)/);

  // W2: "no longer in the source" is a notice, not left-behind data: a cutover right after is not refused.
  const noticeShop = fixture(label, "example-notice-shop");
  cpSync(join(runShop, "reels"), join(noticeShop, "reels"), { recursive: true });
  writeFileSync(join(noticeShop, "reels", "2026-08-10", "audio", `${sb.cards[0].id}.mp3`), `audio-${sb.cards[0].id}`);
  assert.equal((await run("import", "--from", noticeShop)).exitCode, 0);
  rmSync(join(noticeShop, "reels", "2026-08-10", "audio", `${sb.cards[0].id}.mp3`));
  const noticeCut = await run("cutover", "example-notice-shop", "--confirm", "example-notice-shop", "--from", noticeShop);
  assert.equal(noticeCut.exitCode, 0, noticeCut.lines.join("\n"));

  // A pass interrupted between the run's first write and its artifacts is not "unchanged" next time: it completes, then is a no-op.
  const crashShop = fixture(label, "example-run-crash-shop");
  cpSync(join(runShop, "reels"), join(crashShop, "reels"), { recursive: true });
  let armed = true;
  const interrupting = { ...spied, runArtifacts: { ...repos.runArtifacts, record: async (...a: Parameters<typeof repos.runArtifacts.record>) => {
    if (armed) {
      armed = false;
      throw new Error("interrupted before the artifacts");
    }
    return repos.runArtifacts.record(...a);
  } } } as MemoryRepositories;
  const crashed = await runCli(["import", "--from", crashShop], env, interrupting, blobs).catch((e: Error) => ({ exitCode: 1, lines: [e.message] }));
  assert.match(crashed.lines.join("\n"), /interrupted before the artifacts/);
  const crashBrand = (await repos.brands.getBySlug("example-run-crash-shop")).id;
  const crashRun = (await repos.runs.list(crashBrand, { recipe: "reel-week" }))[0];
  assert.equal((await repos.runArtifacts.current(crashRun.id, { kind: "audio" })).length, 0, "the interruption left the run without its artifacts");
  const healedRun = (await run("import", "--from", crashShop)).lines.join("\n");
  assert.match(healedRun, /updated run:reels\/2026-08-10\/storyboard\.yaml/);
  assert.equal((await repos.runArtifacts.current(crashRun.id, { kind: "audio" })).length, sb.cards.length - 1, "the next pass records the missing artifacts");
  assert.match((await run("import", "--from", crashShop)).lines.join("\n"), /actualizados 0,.*conflictos 0/, "and the pass after that is a no-op");
  assert.deepEqual(await verifyBrand(repos, crashShop, blobs, env), []);

  // A week input that is not JSON, with no period folder, is reported as such (not as undated items).
  const badInput = fixture(label, "example-bad-input-shop");
  rmSync(join(badInput, "reels", "2026-08-10"), { recursive: true });
  writeFileSync(join(badInput, "reels", "week-input.json"), "{not json");
  assert.match((await run("import", "--from", badInput)).lines.join("\n"), /reels\/week-input\.json \(not a JSON object\)/);

  // Editor exports (S7b2b3b): one `exports` row per `v<N>` folder with a manifest, taken in NUMERIC order (v10 after v2), the gaps reserved
  // as failed so each keeps its number; a stored export is never rewritten; a version without a manifest and a carousel the folder lacks stay legacy.
  const expShop = fixture(label, "example-exports-shop");
  mkdirSync(join(expShop, "carousels", "launch"));
  writeFileSync(join(expShop, "carousels", "launch", "carousel.json"), JSON.stringify({ schemaVersion: 1, title: "Launch", slides: [] }));
  const expRoot = join(work, label, "outputs-exports");
  writeFileSync(join(expShop, "config.local.yaml"), `outputs:\n  base_dir: ${expRoot}\n`);
  seedOut(expRoot, {
    "editor/launch/v10/manifest.json": JSON.stringify({ version: 10 }), "editor/launch/v10/01.png": "png-10",
    // Refused files of a version are never claimed (so never uploaded under an export key); a manifest holding a secret leaves its whole version.
    "editor/launch/v1/.env": "A=1", "editor/launch/v1/token.txt": "tok", "editor/launch/v1/id_rsa": "rsa", "editor/launch/v1/x.pem": "pem", "editor/launch/v1/01.png": "png-1",
    "editor/launch/v12/manifest.json": JSON.stringify({ version: 12, k: `sk-${"a".repeat(24)}` }), "editor/launch/v12/01.png": "png-12",
    "editor/launch/v2/manifest.json": JSON.stringify({ version: 2 }), "editor/launch/v2/01.png": "png-2", "editor/launch/v2/.reserved": "",
    "editor/launch/v1/manifest.json": JSON.stringify({ version: 1 }),
    "editor/launch/v11/01.png": "no manifest", "editor/ghost/v1/manifest.json": JSON.stringify({ version: 1 }),
  });
  const expRun = await run("import", "--from", expShop);
  assert.equal(expRun.exitCode, 0, expRun.lines.join("\n"));
  const expBrand = (await repos.brands.getBySlug("example-exports-shop")).id;
  const launched = await repos.carousels.get(expBrand, "launch", identity);
  assert.deepEqual((await repos.exports.list(launched.id)).map((e) => [e.versionNo, e.status]), [[1, "done"], [2, "done"], ...[3, 4, 5, 6, 7, 8, 9].map((n) => [n, "failed"]), [10, "done"]], "v2 comes before v10, and the gap keeps its numbers");
  assert.deepEqual((await repos.exports.list(launched.id)).map((e) => e.manifest).filter(Boolean), [{ version: 1 }, { version: 2 }, { version: 10 }]);
  assert.deepEqual((await blobs.get(carouselExportKey(expBrand, launched.id, 10, "01.png"))).body, Buffer.from("png-10"));
  assert.deepEqual(Object.keys(((await repos.importRuns.list(expBrand))[0].report.legacy as { manifest: Record<string, string> }).manifest).filter((k) => k.startsWith("@outputs/")).sort(), ["@outputs/editor/ghost/v1/manifest.json", "@outputs/editor/launch/v11/01.png", "@outputs/editor/launch/v12/01.png"], "what is not an export stays legacy, under the normal policy");
  const expRefused = expRun.lines.find((l) => l.startsWith("Rechazados"))!;
  for (const f of ["v1/.env", "v1/id_rsa", "v1/x.pem", "v12/manifest.json"]) assert.ok(expRefused.includes(`@outputs/editor/launch/${f} (`), `${f} is refused`);
  assert.ok(expRun.lines.find((l) => l.startsWith("Sin importar"))!.includes("@outputs/editor/launch/v1/token.txt (suspicious name)"));
  const exportKeys = (await blobs.list(`brands/${expBrand}/exports/carousels/${launched.id}/`)).map((e) => e.key).sort();
  assert.deepEqual(exportKeys, [1, 2, 10].flatMap((n) => ["01.png", "manifest.json"].map((f) => carouselExportKey(expBrand, launched.id, n, f))).sort(), "only allowlisted files of accepted versions are under an export key");
  assert.deepEqual(await verifyBrand(repos, expShop, blobs, env), []);
  assert.match((await run("import", "--from", expShop)).lines.join("\n"), /Creados 0, actualizados 0, sin cambios \d+, conflictos 0\./);
  writeFileSync(join(expRoot, "editor", "launch", "v10", "manifest.json"), JSON.stringify({ version: 10, edited: true }));
  const expClash = await run("import", "--from", expShop);
  assert.equal(expClash.exitCode, 3);
  assert.match(expClash.lines.join("\n"), /Conflictos: export:launch\/v10 \(differs from storage; never rewritten\)/);
  assert.deepEqual((await repos.exports.list(launched.id)).at(-1)!.manifest, { version: 10 }, "a stored export is never rewritten");

  // An export interrupted after its number was reserved resumes (never a duplicate or a permanent conflict); a changed file is a conflict, both
  // when the stored row is done (seen by the classification) and when a stored file would be overwritten with other bytes.
  const resumeShop = fixture(label, "example-export-resume-shop");
  mkdirSync(join(resumeShop, "carousels", "launch"));
  writeFileSync(join(resumeShop, "carousels", "launch", "carousel.json"), JSON.stringify({ schemaVersion: 1, title: "Launch", slides: [] }));
  const resumeRoot = join(work, label, "outputs-resume");
  writeFileSync(join(resumeShop, "config.local.yaml"), `outputs:\n  base_dir: ${resumeRoot}\n`);
  seedOut(resumeRoot, { "editor/launch/v1/manifest.json": JSON.stringify({ version: 1 }), "editor/launch/v1/01.png": "png-a" });
  let exportCut = true;
  const breaking = { ...spied, exports: { ...repos.exports, complete: async (...a: Parameters<typeof repos.exports.complete>) => {
    if (exportCut) {
      exportCut = false;
      throw new Error("interrupted before the export completed");
    }
    return repos.exports.complete(...a);
  } } } as MemoryRepositories;
  assert.match((await runCli(["import", "--from", resumeShop], env, breaking, blobs).catch((e: Error) => ({ exitCode: 1, lines: [e.message] }))).lines.join("\n"), /interrupted before the export completed/);
  const resumeBrand = (await repos.brands.getBySlug("example-export-resume-shop")).id;
  const resumeCarousel = await repos.carousels.get(resumeBrand, "launch", identity);
  assert.deepEqual((await repos.exports.list(resumeCarousel.id)).map((e) => [e.versionNo, e.status]), [[1, "running"]]);
  writeFileSync(join(resumeRoot, "editor", "launch", "v1", "01.png"), "png-b");
  const changedFile = await run("import", "--from", resumeShop);
  assert.equal(changedFile.exitCode, 3);
  assert.match(changedFile.lines.join("\n"), /Conflictos: export:launch\/v1 \(.*already exists with different content/, "different bytes under a stored key are a reported conflict, not an aborted pass");
  writeFileSync(join(resumeRoot, "editor", "launch", "v1", "01.png"), "png-a");
  const resumed = await run("import", "--from", resumeShop);
  assert.equal(resumed.exitCode, 0, resumed.lines.join("\n"));
  assert.deepEqual((await repos.exports.list(resumeCarousel.id)).map((e) => [e.versionNo, e.status]), [[1, "done"]], "the interrupted export is completed, not duplicated");
  assert.deepEqual(await verifyBrand(repos, resumeShop, blobs, env), []);
  writeFileSync(join(resumeRoot, "editor", "launch", "v1", "01.png"), "png-c");
  assert.match((await run("import", "--from", resumeShop)).lines.join("\n"), /Conflictos: export:launch\/v1 \(differs from storage; never rewritten\)/, "a changed file under the same manifest is not unchanged");

  // Export numbering under conflict: a lower version that conflicts keeps its own number (a higher one never takes it) and resumes once the
  // folder matches storage; a pass never sweeps reserved exports as stale; a writer that got ahead leaves no `running` row; stray stored objects are told.
  const gapShop = fixture(label, "example-export-gap-shop");
  mkdirSync(join(gapShop, "carousels", "launch"));
  writeFileSync(join(gapShop, "carousels", "launch", "carousel.json"), JSON.stringify({ schemaVersion: 1, title: "Launch", slides: [] }));
  const gapRoot = join(work, label, "outputs-gap");
  writeFileSync(join(gapShop, "config.local.yaml"), `outputs:\n  base_dir: ${gapRoot}\n`);
  seedOut(gapRoot, { "editor/launch/v1/manifest.json": JSON.stringify({ version: 1 }), "editor/launch/v1/01.png": "png-1" });
  assert.equal((await run("import", "--from", gapShop)).exitCode, 0);
  const gapBrand = (await repos.brands.getBySlug("example-export-gap-shop")).id;
  const gapCarousel = await repos.carousels.get(gapBrand, "launch", identity);
  const exportStates = async () => (await repos.exports.list(gapCarousel.id)).map((e) => [e.versionNo, e.status]);
  await blobs.put(carouselExportKey(gapBrand, gapCarousel.id, 2, "01.png"), Buffer.from("other"), { metadata: { sha256: sha256(Buffer.from("other")) } });
  await blobs.put(carouselExportKey(gapBrand, gapCarousel.id, 1, "extra.bin"), Buffer.from("x"));
  seedOut(gapRoot, { "editor/launch/v2/manifest.json": JSON.stringify({ version: 2 }), "editor/launch/v2/01.png": "png-2", "editor/launch/v4/manifest.json": JSON.stringify({ version: 4 }), "editor/launch/v4/01.png": "png-4" });
  const staleAfter: Array<number | undefined> = [];
  const counting = { ...spied, exports: { ...repos.exports, reserveNextVersion: (...a: Parameters<typeof repos.exports.reserveNextVersion>) => (staleAfter.push(a[2]?.staleAfterMs), repos.exports.reserveNextVersion(...a)) } } as MemoryRepositories;
  const gapRun = await runCli(["import", "--from", gapShop], env, counting, blobs);
  assert.match(gapRun.lines.join("\n"), /Conflictos: export:launch\/v2 \(.*already exists with different content/);
  assert.match(gapRun.lines.join("\n"), /Avisos: .*launch\/v1: 1 object\(s\) in storage are not in the folder \(kept\): extra\.bin/, "a stray stored object is told, never deleted");
  assert.deepEqual(await exportStates(), [[1, "done"], [2, "running"], [3, "failed"], [4, "done"]], "v4 does not take the number of the conflicted v2, and the real gap is failed");
  assert.ok(staleAfter.length > 0 && staleAfter.every((ms) => ms !== undefined && ms > 24 * 3600 * 1000), "the import never lets a reservation mark other reserved exports stale");
  writeFileSync(join(gapRoot, "editor", "launch", "v2", "01.png"), "other");
  assert.equal((await run("import", "--from", gapShop)).exitCode, 0);
  assert.deepEqual(await exportStates(), [[1, "done"], [2, "done"], [3, "failed"], [4, "done"]], "the conflicted version completes under its own number once the folder matches storage");

  // A writer that reserved a number meanwhile: the import's own over-reserved row is failed, never left `running`.
  seedOut(gapRoot, { "editor/launch/v5/manifest.json": JSON.stringify({ version: 5 }), "editor/launch/v5/01.png": "png-5" });
  const ahead = { ...spied, exports: { ...repos.exports, reserveNextVersion: async (...a: Parameters<typeof repos.exports.reserveNextVersion>) => (await repos.exports.reserveNextVersion(...a), repos.exports.reserveNextVersion(...a)) } } as MemoryRepositories;
  assert.match((await runCli(["import", "--from", gapShop], env, ahead, blobs)).lines.join("\n"), /Conflictos: export:launch\/v5 \(.*storage already holds newer versions/);
  assert.deepEqual((await exportStates()).slice(4), [[5, "running"], [6, "failed"]], "the other writer's row is untouched and the import's own over-reserved row is failed");

  // A reserved number below the one being written is failed only when it is old: a fresh `running` row may be a concurrent editor's.
  await repos.exports.reserveNextVersion(gapCarousel.id, gapCarousel.version);
  seedOut(gapRoot, { "editor/launch/v8/manifest.json": JSON.stringify({ version: 8 }), "editor/launch/v8/01.png": "png-8" });
  assert.equal((await run("import", "--from", gapShop)).exitCode, 0);
  assert.deepEqual((await exportStates()).slice(4), [[5, "done"], [6, "failed"], [7, "running"], [8, "done"]], "a fresh running row below the written version is left untouched");

  // The same row, once old enough, is an abandoned reservation: the next pass (clock moved past the stale window) fails it.
  seedOut(gapRoot, { "editor/launch/v9/manifest.json": JSON.stringify({ version: 9 }), "editor/launch/v9/01.png": "png-9" });
  await importBrand(spied, { from: gapShop, dryRun: false, author: "test", blobs, env, now: () => new Date(Date.now() + DEFAULT_EXPORT_STALE_MS + 60_000) });
  assert.deepEqual((await exportStates()).slice(6), [[7, "failed"], [8, "done"], [9, "done"]], "an old running row below the written version is failed");

  // A version folder without a usable manifest is not an export, so its number is a plain gap: failed, never kept `running`.
  const bareShop = fixture(label, "example-export-bare-shop");
  mkdirSync(join(bareShop, "carousels", "launch"));
  writeFileSync(join(bareShop, "carousels", "launch", "carousel.json"), JSON.stringify({ schemaVersion: 1, title: "Launch", slides: [] }));
  const bareRoot = join(work, label, "outputs-bare");
  writeFileSync(join(bareShop, "config.local.yaml"), `outputs:\n  base_dir: ${bareRoot}\n`);
  seedOut(bareRoot, { "editor/launch/v2/01.png": "png-2", "editor/launch/v4/manifest.json": JSON.stringify({ version: 4 }), "editor/launch/v4/01.png": "png-4" });
  assert.equal((await run("import", "--from", bareShop)).exitCode, 0);
  const bareBrand = (await repos.brands.getBySlug("example-export-bare-shop")).id;
  assert.deepEqual((await repos.exports.list((await repos.carousels.get(bareBrand, "launch", identity)).id)).map((e) => [e.versionNo, e.status]), [[1, "failed"], [2, "failed"], [3, "failed"], [4, "done"]], "a version without a manifest keeps no reservation");

  // A file that changes between planning and upload is not uploaded and is reported (the pass goes on and says so).
  const raceExp = fixture(label, "example-export-race-shop");
  mkdirSync(join(raceExp, "carousels", "launch"));
  writeFileSync(join(raceExp, "carousels", "launch", "carousel.json"), JSON.stringify({ schemaVersion: 1, title: "Launch", slides: [] }));
  const raceRoot = join(work, label, "outputs-race");
  writeFileSync(join(raceExp, "config.local.yaml"), `outputs:\n  base_dir: ${raceRoot}\n`);
  seedOut(raceRoot, { "editor/launch/v1/manifest.json": JSON.stringify({ version: 1 }), "editor/launch/v1/01.png": "png-a", "editor/launch/v1/02.png": "png-b" });
  const uploaded: string[] = [];
  const edits: BlobStore = {
    get: (k) => blobs.get(k), getStream: (k) => blobs.getStream(k), head: (k) => blobs.head(k), list: (p) => blobs.list(p),
    put: async (k, body, o) => {
      uploaded.push(k);
      writeFileSync(join(raceRoot, "editor", "launch", "v1", "02.png"), `png-edited-${uploaded.length}`); // after the first upload, before the second file is read again
      return blobs.put(k, body, o);
    },
  };
  const exportRaced = await runCli(["import", "--from", raceExp], env, spied, edits);
  assert.match(exportRaced.lines.join("\n"), /Conflictos: export:launch\/v1 \(@outputs\/editor\/launch\/v1\/02\.png changed while the import was running/);
  assert.equal(uploaded.filter((k) => k.endsWith("/02.png")).length, 0, "the changed file is never uploaded");
  const raceBrand = (await repos.brands.getBySlug("example-export-race-shop")).id;
  assert.deepEqual(await repos.exports.list((await repos.carousels.get(raceBrand, "launch", identity)).id), [], "no export row is reserved for the changed version");
  assert.equal((await runCli(["cutover", "example-export-race-shop", "--confirm", "example-export-race-shop", "--from", raceExp], env, spied, edits)).exitCode, 6, "a cutover is refused while the export is a conflict");

  // A take whose card left the plan and came back with a new mp3 is the import's own (`_imported.released`), not "changed in storage".
  const backShop = fixture(label, "example-returning-take-shop");
  cpSync(join(runShop, "reels"), join(backShop, "reels"), { recursive: true });
  const backMp3 = join(backShop, "reels", "2026-08-10", "audio", `${sb.cards[0].id}.mp3`);
  assert.equal((await run("import", "--from", backShop)).exitCode, 0);
  rmSync(backMp3);
  assert.match((await run("import", "--from", backShop)).lines.join("\n"), /no longer in the source/);
  writeFileSync(backMp3, "audio-returned");
  const back = await run("import", "--from", backShop);
  assert.equal(back.exitCode, 0, back.lines.join("\n"));
  assert.match(back.lines.join("\n"), /actualizados 1,.*conflictos 0/);
  const backBrand = (await repos.brands.getBySlug("example-returning-take-shop")).id;
  const backRun = (await repos.runs.list(backBrand, { recipe: "reel-week" }))[0];
  assert.equal((await repos.runArtifacts.current(backRun.id, { kind: "audio" })).find((a) => a.cardIndex === 0)!.sha256, sha(Buffer.from("audio-returned")));
  assert.deepEqual(await verifyBrand(repos, backShop, blobs, env), []);
  assert.match((await run("import", "--from", backShop)).lines.join("\n"), /actualizados 0,.*conflictos 0/);

  // A run written under the old `_imported.audio` key (no kind) still claims its slots: a changed mp3 updates it cleanly.
  const oldShop = fixture(label, "example-legacy-audio-shop");
  cpSync(join(runShop, "reels"), join(oldShop, "reels"), { recursive: true });
  assert.equal((await run("import", "--from", oldShop)).exitCode, 0);
  const oldBrand = (await repos.brands.getBySlug("example-legacy-audio-shop")).id;
  const oldRow = (await repos.runs.list(oldBrand, { recipe: "reel-week" }))[0];
  const oldStored = await repos.runs.get(oldRow.id, identity);
  const { artifacts: oldTakes, ...oldImported } = (oldStored.value.input as { _imported: { artifacts: Array<{ cardIndex: number; sha256: string }> } })._imported;
  const asOldJson = { ...(oldStored.value.input as object), _imported: { ...oldImported, audio: oldTakes.map(({ cardIndex, sha256 }) => ({ cardIndex, sha256 })) } };
  await repos.runs.save(oldRow.id, { input: { json: asOldJson, schemaVersion: 1 }, storyboard: oldStored.value.storyboard }, { expectedVersion: oldStored.version, author: "tester", source: "import", reason: "import", sourceHash: "old-format" });
  assert.deepEqual(await verifyBrand(repos, oldShop, blobs, env), [], "an old-format run reads back as the source says");
  writeFileSync(join(oldShop, "reels", "2026-08-10", "audio", `${sb.cards[0].id}.mp3`), "audio-new-take");
  const oldAgain = await run("import", "--from", oldShop);
  assert.equal(oldAgain.exitCode, 0, oldAgain.lines.join("\n"));
  assert.match(oldAgain.lines.join("\n"), /conflictos 0/);
  assert.equal((await repos.runArtifacts.current(oldRow.id, { kind: "audio" })).find((a) => a.cardIndex === 0)!.sha256, sha(Buffer.from("audio-new-take")));

  // A file a collector skipped that the legacy pass refuses as a proven secret does not block a cutover (it is still reported).
  const skipSecret = fixture(label, "example-skipped-secret-shop");
  mkdirSync(join(skipSecret, "reels", "stray"), { recursive: true });
  writeFileSync(join(skipSecret, "reels", "stray", ".env"), "A=1");
  const skipCut = await run("cutover", "example-skipped-secret-shop", "--confirm", "example-skipped-secret-shop", "--from", skipSecret);
  assert.equal(skipCut.exitCode, 0, skipCut.lines.join("\n"));
  assert.match(skipCut.lines.join("\n"), /Rechazados, nunca importados: .*reels\/stray\/\.env/);

  // An outputs root that is too broad is unusable: `~` is the home directory (faked here, never the real one), a folder that holds
  // another brand's folder likewise; a folder inside the home is fine.
  const fakeHome = join(work, label, "fake-home");
  seedOut(fakeHome, { "notes.md": "private", "outputs/ok.json": "{}" });
  const atHome = { ...env, HOME: fakeHome };
  const homeShop = problem("example-home-out-shop", 'outputs:\n  base_dir: "~"\n');
  const homeOut = (await runCli(["import", "--from", homeShop, "--dry-run"], atHome, spied, blobs)).lines.join("\n");
  assert.match(homeOut, /@outputs\/ \(outputs root .* is the home directory or holds it/);
  assert.equal((await runCli(["cutover", "example-home-out-shop", "--confirm", "example-home-out-shop", "--from", homeShop], atHome, spied, blobs)).exitCode, 6);
  const homeSub = problem("example-home-sub-shop", "outputs:\n  base_dir: ~/outputs\n");
  assert.match((await runCli(["import", "--from", homeSub, "--dry-run"], atHome, spied, blobs)).lines.join("\n"), /Carpeta de salidas leída/, "a folder inside the home is a usable root");
  const holder = join(work, `${label}-holder`);
  mkdirSync(join(holder, "other-brand"), { recursive: true });
  symlinkSync(join(holder, "other-brand"), join(work, label, "example-linked-brand"));
  const holdShop = problem("example-holder-out-shop", `outputs:\n  base_dir: ${holder}\n`);
  assert.match((await run("import", "--from", holdShop, "--dry-run")).lines.join("\n"), /@outputs\/ \(outputs root .* holds another brand's folder: not read/);

  const insideBrand = join(work, label, "example-neighbour-brand");
  seedOut(insideBrand, { "brand.json": "{}", "outputs/ok.json": "{}" });
  const insideShop = problem("example-inside-brand-out-shop", `outputs:\n  base_dir: ${join(insideBrand, "outputs")}\n`);
  assert.match((await run("import", "--from", insideShop, "--dry-run")).lines.join("\n"), /@outputs\/ \(outputs root .* lies inside another brand's folder/, "a root inside another brand's folder is unusable");

  const exactShop = problem("example-exact-brand-out-shop", `outputs:\n  base_dir: ${insideBrand}\n`);
  assert.match((await run("import", "--from", exactShop, "--dry-run")).lines.join("\n"), /@outputs\/ \(outputs root .* lies inside another brand's folder/, "a root that is exactly another brand's folder is unusable");

  // A `clips` path that is a file, or a folder that cannot be listed, is reported, never a crash.
  const clipFile = fixture(label, "example-clips-file-shop");
  cpSync(join(runShop, "reels"), join(clipFile, "reels"), { recursive: true });
  const clipFileRoot = join(work, label, "outputs-clips-file");
  seedOut(clipFileRoot, { "reels/2026-08-10/clips": "not a folder" });
  writeFileSync(join(clipFile, "config.local.yaml"), `outputs:\n  base_dir: ${clipFileRoot}\n`);
  const clipFileOut = await run("import", "--from", clipFile, "--dry-run");
  assert.equal(clipFileOut.exitCode, 0, clipFileOut.lines.join("\n"));
  assert.match(clipFileOut.lines.join("\n"), /@outputs\/reels\/2026-08-10\/clips \(not a readable directory\)/);
  if (process.getuid?.() !== 0) {
    const clipsPath = join(clipFileRoot, "reels", "2026-08-10", "clips");
    rmSync(clipsPath);
    mkdirSync(clipsPath);
    chmodSync(clipsPath, 0o000);
    try {
      const sealedClips = await run("import", "--from", clipFile, "--dry-run");
      assert.equal(sealedClips.exitCode, 0, sealedClips.lines.join("\n"));
      assert.match(sealedClips.lines.join("\n"), /@outputs\/reels\/2026-08-10\/clips \(not a readable directory\)/);
    } finally {
      chmodSync(clipsPath, 0o755);
    }
  }

  // Clips of an outputs root INSIDE the brand folder (the default `outputs` folder) are artifacts and are not kept a second time as legacy blobs.
  const innerShop = fixture(label, "example-inner-outputs-shop");
  cpSync(join(runShop, "reels"), join(innerShop, "reels"), { recursive: true });
  seedOut(innerShop, { [`outputs/reels/2026-08-10/clips/${clipNames[0]}`]: "inner-clip-0", "outputs/reels/2026-08-10/clips/other.mp4": "loose" });
  const innerRun = await run("import", "--from", innerShop);
  assert.equal(innerRun.exitCode, 0, innerRun.lines.join("\n"));
  assert.doesNotMatch(innerRun.lines.join("\n"), /Carpeta de salidas leída/, "an inner root is not a second root");
  const innerBrand = (await repos.brands.getBySlug("example-inner-outputs-shop")).id;
  assert.deepEqual((await repos.runArtifacts.current((await repos.runs.list(innerBrand, { recipe: "reel-week" }))[0].id, { kind: "clip" })).map((c) => c.cardIndex), [0]);
  const innerManifest = Object.keys(((await repos.importRuns.list(innerBrand))[0].report.legacy as { manifest: Record<string, string> }).manifest).filter((k) => k.startsWith("outputs/"));
  assert.deepEqual(innerManifest, ["outputs/reels/2026-08-10/clips/other.mp4"], "the claimed clip is not also a legacy blob");

  // An unreadable or unparseable config file is a notice, not silence; a file that changed after it was hashed is not uploaded.
  const badConfig = problem("example-bad-config-shop", "outputs: [unclosed\n");
  assert.match((await run("import", "--from", badConfig, "--dry-run")).lines.join("\n"), /Omitidos: .*@outputs\/ \(config\.local\.yaml could not be parsed: outputs root unknown\)/);
  assert.equal((await run("cutover", "example-bad-config-shop", "--confirm", "example-bad-config-shop", "--from", badConfig)).exitCode, 6, "an unknown outputs root blocks a cutover");
  assert.throws(() => rereadChecked(innerShop, join(innerShop, "profile.md"), "profile.md", "0".repeat(64)), /changed while the import was running/);

  // An example cuts over without --partial: everything is imported, or kept as a legacy blob, and blobs are verified.
  const whole = fixture(label, "example-whole-shop");
  const wholeCut = await run("cutover", "example-whole-shop", "--confirm", "example-whole-shop", "--from", whole);
  assert.equal(wholeCut.exitCode, 0, wholeCut.lines.join("\n"));
  assert.equal((await repos.assets.list((await repos.brands.getBySlug("example-whole-shop")).id)).length, 3);
  assert.equal(((await repos.importRuns.list((await repos.brands.getBySlug("example-whole-shop")).id))[0].report.legacy as { count: number }).count, 2, "the two folder READMEs are kept as legacy blobs");

  // A row created between classify and write is a conflict with its reason, not an aborted pass.
  for (const [what, name] of [["content", "example-race-content-shop"], ["carousels", "example-race-carousel-shop"]] as const) {
    const shop = fixture(label, name);
    mkdirSync(join(shop, "carousels", "raced"), { recursive: true });
    writeFileSync(join(shop, "carousels", "raced", "carousel.json"), JSON.stringify({ schemaVersion: 1, title: "Raced", slides: [] }));
    let raced = false;
    const competing = { ...spied, content: { ...repos.content }, carousels: { ...repos.carousels } } as MemoryRepositories;
    const real = repos[what].create.bind(repos[what]) as (...a: unknown[]) => Promise<unknown>;
    (competing[what] as { create: unknown }).create = async (...a: unknown[]) => {
      if (!raced) {
        raced = true;
        const input = a[1] as Record<string, unknown>;
        await real(a[0], { ...input, title: "Created elsewhere" }, { expectedVersion: null, author: "editor", source: "editor", reason: "save" });
      }
      return real(...a);
    };
    const out = await runCli(["import", "--from", shop], env, competing, blobs);
    assert.equal(out.exitCode, 3, out.lines.join("\n"));
    assert.match(out.lines.join("\n"), /Conflictos: \S+ \(created in storage during the pass\)/);
    assert.equal((await repos.importRuns.list((await repos.brands.getBySlug(name)).id))[0].report.aborted, undefined, "the pass finished");
  }

  // Carousel write paths: a new draft with chat, a new non-draft without, a diverged chat log, and symlinked history.
  const wr = fixture(label, "example-writes-shop");
  const cdoc = (title: string, status: string) => JSON.stringify({ schemaVersion: 1, title, status, slides: [] });
  const addCarousel = (id: string, document: string, chat?: string) => {
    mkdirSync(join(wr, "carousels", id), { recursive: true });
    writeFileSync(join(wr, "carousels", id, "carousel.json"), document);
    if (chat) writeFileSync(join(wr, "carousels", id, "chat.jsonl"), chat);
  };
  addCarousel("with-chat", cdoc("Chatty", "draft"), '{"role":"user","text":"one"}\n{"role":"user","text":"two"}\n');
  addCarousel("scheduled", cdoc("Plain", "scheduled"));
  addCarousel("linked", cdoc("Linked", "draft"));
  mkdirSync(join(wr, "carousels", "linked", "versions"));
  writeFileSync(join(work, "outside.json"), cdoc("Outside", "draft"));
  symlinkSync(join(work, "outside.json"), join(wr, "carousels", "linked", "versions", "a.json"));
  mkdirSync(join(work, "outside-versions"), { recursive: true });
  writeFileSync(join(work, "outside-versions", "b.json"), cdoc("Outside", "draft"));
  addCarousel("linked-dir", cdoc("Linked dir", "draft"));
  symlinkSync(join(work, "outside-versions"), join(wr, "carousels", "linked-dir", "versions"));
  const wrRun = await run("import", "--from", wr);
  assert.equal(wrRun.exitCode, 0, wrRun.lines.join("\n"));
  assert.match(wrRun.lines.join("\n"), /carousels\/linked\/versions\/a\.json \(not a regular file\)/);
  assert.match(wrRun.lines.join("\n"), /carousels\/linked-dir\/versions\/b\.json \(outside the folder\)/);
  const wid = (await repos.brands.getBySlug("example-writes-shop")).id;
  const chatty = await repos.carousels.get(wid, "with-chat", identity);
  assert.equal((await repos.revisions.list("carousel", chatty.id)).length, 2, "a new draft with chat is created once, then closed by one status write (no second copy of the document)");
  assert.equal((await repos.chat.list(chatty.id)).length, 2);
  const plain = await repos.carousels.get(wid, "scheduled", identity);
  assert.deepEqual([plain.value.status, (await repos.revisions.list("carousel", plain.id)).length], ["scheduled", 1], "a new carousel is created straight in its status");
  writeFileSync(join(wr, "carousels", "with-chat", "chat.jsonl"), '{"role":"user","text":"other"}\n{"role":"user","text":"two"}\n');
  writeFileSync(join(wr, "carousels", "with-chat", "carousel.json"), cdoc("Chatty 2", "draft"));
  const diverged = await run("import", "--from", wr);
  assert.equal(diverged.exitCode, 3);
  assert.match(diverged.lines.join("\n"), /Conflictos: carousel:with-chat \(chat log diverged from storage\)/);
  assert.deepEqual([(await repos.carousels.get(wid, "with-chat", identity)).value.title, (await repos.chat.list(chatty.id)).map((m) => m.body.text)], ["Chatty", ["one", "two"]], "a diverged chat log is never rewritten");

  // A marker that names another brand is never trusted or overwritten.
  const wrong = fixture(label, "example-wrong-shop");
  assert.equal((await run("cutover", "example-wrong-shop", "--confirm", "example-wrong-shop", "--partial", "--from", wrong)).exitCode, 0);
  writeFileSync(join(wrong, ".storage-cutover"), JSON.stringify({ brandId: "someone-else" }));
  const mismatched = await run("cutover", "example-wrong-shop", "--confirm", "example-wrong-shop", "--from", wrong);
  assert.deepEqual([mismatched.exitCode, /no corresponde a la marca/.test(mismatched.lines[0])], [6, true]);
  assert.match(readFileSync(join(wrong, ".storage-cutover"), "utf-8"), /someone-else/);

  // Owner guard: a brand that is not an example is refused (dry run included) before any repository call or folder read.
  // Cutover without --from resolves under BRAND_PROFILES_DIR, which is always a temp dir here.
  const untouchable = new Proxy({}, { get: () => { throw new Error("repository touched"); } }) as MemoryRepositories;
  const profilesDir = join(work, label);
  const real = join(profilesDir, "acme-demo"); // does not exist: a folder read would say so instead of refusing
  const withOptIn = (flag?: string, envValue?: string, inline = false) => [
    { BRAND_PROFILES_DIR: profilesDir, USER: "tester", ...(envValue === undefined ? {} : { BRAND_OWNER_OPT_IN: envValue }) },
    flag === undefined ? [] : inline ? [`--owner-opt-in=${flag}`] : ["--owner-opt-in", flag],
  ] as const;
  const refusedBy = async (argv: string[], [env, extra]: ReturnType<typeof withOptIn>, repo = untouchable) => {
    const out = await runCli([...argv, ...extra], env, repo);
    assert.deepEqual([out.exitCode, /aprobación explícita del dueño/.test(out.lines[0])], [6, true], `${argv.join(" ")} ${JSON.stringify(extra)} ${JSON.stringify(env)}`);
  };
  const forBrand = (slug: string, dir = join(profilesDir, slug)) => [["import", "--from", dir], ["import", "--from", dir, "--dry-run"], ["cutover", slug, "--confirm", slug, "--from", dir], ["cutover", slug, "--confirm", slug]];
  for (const opt of [withOptIn(), withOptIn("acme-demo"), withOptIn(undefined, "acme-demo"), withOptIn("other", "acme-demo"), withOptIn("*", "*"), withOptIn("acme-demo", "other"), withOptIn("acme-demo", "acme-demo ", true)]) {
    for (const argv of forBrand("acme-demo", real)) await refusedBy(argv, opt);
  }
  // Names that look like an example but are not: case, whitespace and an empty suffix do not match the rule.
  for (const odd of ["Example", "example ", "EXAMPLE-x", "example-", "examples", "my-example"]) {
    for (const argv of forBrand(odd)) await refusedBy(argv, withOptIn());
  }
  // A symlink called like an example that points at a real brand is judged by the real name too.
  const target = fixture(label, "acme-real");
  symlinkSync(target, join(profilesDir, "example-alias"));
  for (const argv of forBrand("example-alias")) await refusedBy(argv, withOptIn());
  for (const argv of forBrand("example-alias")) await refusedBy(argv, withOptIn("example-alias", "example-alias"));

  // Several blocked names are listed with the plural verb.
  const two = join(profilesDir, "acme-two");
  cpSync(target, two, { recursive: true });
  symlinkSync(two, join(profilesDir, "acme-one"));
  const plural = await runCli(["import", "--from", join(profilesDir, "acme-one")], { USER: "tester" }, untouchable);
  assert.deepEqual(plural.lines, ['Las marcas "acme-one", "acme-two" no son de ejemplo: requieren la aprobación explícita del dueño (BRAND_OWNER_OPT_IN=<marca> y --owner-opt-in <marca>). No se hizo nada.']);

  const approved = fixture(label, "acme-demo");
  const both = { USER: "tester", BRAND_OWNER_OPT_IN: "acme-demo", BRAND_PROFILES_DIR: profilesDir };
  const passed = await runCli(["import", "--from", approved, "--dry-run", "--owner-opt-in", "acme-demo"], both, repos);
  assert.equal(passed.exitCode, 0, passed.lines.join("\n"));
  const inline = await runCli(["import", "--from", approved, "--dry-run", "--owner-opt-in=acme-demo"], both, repos);
  assert.equal(inline.exitCode, 0, "the --owner-opt-in=<slug> form works too");
  const cutOver = await runCli(["cutover", "acme-demo", "--confirm", "acme-demo", "--partial", "--owner-opt-in", "acme-demo"], both, repos);
  assert.equal(cutOver.exitCode, 0, cutOver.lines.join("\n"));
  assert.equal(existsSync(join(approved, ".storage-cutover")), true);
  assert.equal((await run("frobnicate")).exitCode, 2, "an unknown verb prints usage");

  // Remaining CLI error branches.
  const missingDir = await run("import", "--from", join(work, label, "example-nope"));
  assert.deepEqual([missingDir.exitCode, /No existe la carpeta/.test(missingDir.lines[0])], [4, true], "a missing --from folder is not found");
  const empty = join(work, label, "example-empty-shop");
  mkdirSync(empty);
  assert.deepEqual((await run("import", "--from", empty)).lines, [`Error: Nothing to import under ${empty}`]);

  console.log(`  ok - ${label}: import, no-op re-run, conflict, cutover`);
}

// The bucket is configured only when all three required S3_* variables are set.
assert.equal(blobStoreFromEnv({ S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k" }), undefined);
assert.ok(blobStoreFromEnv({ S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }));

// Hosts the backup gate treats as local, and everything else (lookalikes, multi-host, sockets, `?host=`, short IPv4) as remote.
for (const url of ["postgres://u:p@localhost:5442/db", "postgres://u@127.0.0.1/db", "postgres://u@[::1]:5432/db"]) assert.equal(isLocalDatabase(url), true, url);
for (const url of ["postgres://u@localhost.evil.com/db", "postgres://localhost,evil.com/db", "postgres://localhost:1,evil.com:2/db", "postgres:///db", "postgres://%2Fvar%2Frun%2Fpostgresql/db", "postgres://u@127.1/db", "postgres://localhost/db?host=evil.com", "not a url"]) {
  assert.equal(isLocalDatabase(url), false, url);
}

try {
  await scenario("memory", createMemoryRepositories());
  const url = process.env.DATABASE_URL;
  if (!url) console.log("SKIP postgres brand cli - DATABASE_URL not set");
  else {
    const admin = postgres(url, { connect_timeout: 3, onnotice: () => {} });
    const schema = `test_${randomBytes(6).toString("hex")}`;
    try {
      await migrate(admin, { schema });
      const u = new URL(url);
      u.username = "brand_owner";
      u.password = "local-dev-only";
      const [role] = await admin`SELECT 1 FROM pg_roles WHERE rolname = 'brand_owner'`;
      const sql = postgres(role ? u.toString() : url, { connection: { search_path: schema }, onnotice: () => {} });
      try {
        await scenario("postgres", createPgRepositories(sql) as MemoryRepositories);
      } finally {
        await sql.end({ timeout: 1 });
      }
    } finally {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log("brand cli: ok");
