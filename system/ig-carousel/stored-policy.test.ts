import assert from "node:assert/strict";

import { createMemoryRepositories } from "@personal-brand/storage/memory";

import { loadStoredVerifyPolicy } from "./stored-policy.js";
import type { CarouselInput, Slide } from "./types.js";
import { verifyOrThrow } from "./verify-slides.js";

const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "save" as const };
const slide = (over: Partial<Slide> = {}): Slide => ({
  title: "Event",
  subtitle: "Detail",
  meta: "Sat · Venue",
  image: "https://api.example.com/media/photo.jpg",
  ...over,
});
const input = (over: Partial<CarouselInput> = {}): CarouselInput => ({ sourceImageHosts: ["api.example.com"], slides: [], ...over });

async function setup(rules: Array<{ kind: "forbidden_terms" | "max_length" | "slide_count" | "image_hosts" | "date_window"; params: Record<string, unknown>; severity?: "error" | "warning"; appliesTo?: Array<"carousel" | "caption"> }>) {
  const repos = createMemoryRepositories();
  const brand = await repos.brands.create({ slug: "acme-coffee", displayName: "Acme" }, meta);
  for (const r of rules) {
    await repos.rules.create(brand.id, { kind: r.kind, params: r.params, severity: r.severity ?? "error", appliesTo: r.appliesTo ?? ["carousel"], message: `${r.kind} rule` }, meta);
  }
  return loadStoredVerifyPolicy(repos.rules, brand.id);
}
const run = (policy: Awaited<ReturnType<typeof setup>>, slides: Slide[], over: Partial<CarouselInput> = {}) =>
  verifyOrThrow({ slides, input: input(over), inputPath: "in.json", policy });

const HOSTS = { kind: "image_hosts" as const, params: { hosts: ["api.example.com"] } };
const NO_BAD_WORDS = { kind: "forbidden_terms" as const, params: { terms: ["bargain"], fields: ["title"], slides: "all" } };

const tests: Array<[string, () => Promise<void>]> = [
  ["stored rules pass a compliant carousel", async () => {
    const policy = await setup([HOSTS, NO_BAD_WORDS, { kind: "max_length", params: { field: "title", max: 20, slides: "all" } }]);
    assert.equal(run(policy, [slide()]).length, 1);
  }],
  ["an error-severity forbidden term refuses the render, naming the slide and field", async () => {
    const policy = await setup([HOSTS, NO_BAD_WORDS]);
    assert.throws(() => run(policy, [slide(), slide({ title: "Big bargain" })]), /forbidden_terms rule \(rendered slide 2, title\): contains "bargain"/);
  }],
  ["a warning-severity rule is reported, not fatal", async () => {
    const policy = await setup([HOSTS, { ...NO_BAD_WORDS, severity: "warning" }]);
    const warn = console.warn;
    const seen: string[] = [];
    console.warn = (m: string) => void seen.push(m);
    try {
      assert.equal(run(policy, [slide({ title: "Big bargain" })]).length, 1);
    } finally {
      console.warn = warn;
    }
    assert.match(seen.join("\n"), /contains "bargain"/);
  }],
  ["a stored max_length and slide_count are enforced", async () => {
    const policy = await setup([HOSTS, { kind: "max_length", params: { field: "title", max: 3, slides: "cover" } }, { kind: "slide_count", params: { min: 2 } }]);
    assert.throws(() => run(policy, [slide()]), /max_length rule[\s\S]*slide_count rule/);
  }],
  ["stored image_hosts rules are the ceiling for the input's own hosts", async () => {
    const policy = await setup([HOSTS]);
    assert.throws(() => run(policy, [slide()], { sourceImageHosts: ["api.example.com", "evil.example.net"] }), /never declared: evil\.example\.net/);
    assert.throws(() => run(policy, [slide()], { sourceImageHosts: undefined }), /carries no "sourceImageHosts"/);
  }],
  ["the structural date check still runs under a stored policy", async () => {
    const policy = await setup([HOSTS]);
    const period = { start: new Date(2026, 7, 17), end: new Date(2026, 7, 23) };
    assert.throws(() => verifyOrThrow({ slides: [slide()], input: input(), inputPath: "in.json", policy, period }), /never checked/);
    const kept = verifyOrThrow({ slides: [slide({ date: "2026-08-20" })], input: input(), inputPath: "in.json", policy, period });
    assert.equal(kept.length, 1);
  }],
  ["slide_count is judged after drops, and a forbidden term on a dropped slide does not block", async () => {
    const policy = await setup([HOSTS, NO_BAD_WORDS, { kind: "slide_count", params: { min: 2 } }]);
    const period = { start: new Date(2026, 7, 17), end: new Date(2026, 7, 23) };
    const dated = (over: Partial<Slide>) => slide({ date: "2026-08-20", ...over });
    const verify = (slides: Slide[]) => verifyOrThrow({ slides, input: input(), inputPath: "in.json", policy, period, onWarning: () => {} });
    assert.equal(verify([dated({}), dated({}), dated({ title: "Old bargain", date: "2026-01-01" })]).length, 2);
    assert.throws(() => verify([dated({}), dated({ date: "2026-01-01" })]), /slide_count rule: 1 slides, expected 2/);
  }],
  ["finding positions count rendered slides", async () => {
    const policy = await setup([HOSTS, NO_BAD_WORDS]);
    const period = { start: new Date(2026, 7, 17), end: new Date(2026, 7, 23) };
    const slides = [slide({ date: "2026-01-01" }), slide({ date: "2026-08-20", title: "bargain" })];
    assert.throws(() => verifyOrThrow({ slides, input: input(), inputPath: "in.json", policy, period, onWarning: () => {} }), /rendered slide 1, title/);
  }],
  ["a warning-severity image_hosts rule still enforces; a caption-only one is ignored", async () => {
    const warned = await setup([{ ...HOSTS, severity: "warning" }]);
    assert.throws(() => run(warned, [slide()], { sourceImageHosts: ["api.example.com", "evil.example.net"] }), /never declared/);
    const captionOnly = await setup([{ ...HOSTS, appliesTo: ["caption"] }]);
    assert.equal(captionOnly.imagePolicy.declaredHosts, undefined);
    assert.equal(run(captionOnly, [slide({ image: "https://other.example.net/a.jpg" })], { sourceImageHosts: ["other.example.net"] }).length, 1);
  }],
  ["a brand with no image_hosts rule allows any host", async () => {
    const policy = await setup([NO_BAD_WORDS]);
    assert.equal(run(policy, [slide({ image: "https://cdn.example.net/x.jpg" })], { sourceImageHosts: undefined }).length, 1);
  }],
  ["a stored date_window with require_dates false cannot relax the engine's date floor", async () => {
    const policy = await setup([HOSTS, { kind: "date_window", params: { require_dates: false } }]);
    const period = { start: new Date(2026, 7, 17), end: new Date(2026, 7, 23) };
    assert.throws(() => verifyOrThrow({ slides: [slide()], input: input(), inputPath: "in.json", policy, period }), /never checked/);
  }],
  ["the drop report and rule warnings go to onWarning", async () => {
    const policy = await setup([HOSTS, { ...NO_BAD_WORDS, severity: "warning" }]);
    const lines: string[][] = [];
    verifyOrThrow({ slides: [slide({ title: "bargain" }), slide({ image: "https://x.example.net/a.jpg" })], input: input(), inputPath: "in.json", policy, onWarning: (l) => void lines.push(l) });
    assert.equal(lines.length, 2);
    assert.match(lines.flat().join("\n"), /Rule warnings[\s\S]*Dropped 1 of 2/);
  }],
  ["without a policy or a profile folder the call is refused", async () => {
    assert.throws(() => verifyOrThrow({ slides: [slide()], input: input(), inputPath: "in.json" } as never), /needs either a policy or both/);
  }],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}\n`, error);
  }
}
if (failed) process.exit(1);
console.log(`stored-policy: ${tests.length} ok`);
