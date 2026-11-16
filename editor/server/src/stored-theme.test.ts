import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMemoryRepositories } from "@personal-brand/storage/memory";

import { storedBrandTokens, storedCarouselRaw, storedRenderParts, type EditorStorage } from "./stored-read.js";

// A stored carousel is themed by its own `scheduledFor` day, else by the brand's today. Fictional example brand, memory storage.
const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "profiles", "example");
const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "save" as const };
const repos = createMemoryRepositories();
const brand = await repos.brands.create({ slug: "stored-example", displayName: "Stored Example" }, meta);
await repos.documents.put(brand.id, "tokens", "", { json: JSON.parse(readFileSync(join(EXAMPLE, "brand.json"), "utf-8")), schemaVersion: 1 }, meta);
await repos.themes.put(brand.id, "winter-sale", { startsOn: "2020-12-01", endsOn: "2020-12-31", tokenOverrides: { colors: { ink: "#abcdef" } }, guidance: "" }, meta);
const s = { storage: { ...repos, blobs: () => ({ read: async () => "" }) } as unknown as EditorStorage, brandId: brand.id, slug: "stored-example" };
const original = (await storedBrandTokens(s)).colors.ink;
assert.notEqual(original, "#abcdef", "today is outside the theme's range");

const doc = { schemaVersion: 1, id: "c", title: "t", createdAt: "x", updatedAt: "x", canvas: { w: 1080, h: 1350 }, prompt: { text: "x", createdAt: "x" }, slides: [] };
const make = async (slug: string, scheduledFor: string | null) => {
  const c = await repos.carousels.create(brand.id, { slug, title: slug, document: { json: doc, schemaVersion: 1 } }, meta);
  if (scheduledFor) await repos.carousels.setStatus(c.id, { status: "scheduled", scheduledFor }, { ...meta, expectedVersion: c.version });
};
await make("inside", "2020-12-15T09:00:00.000Z");
await make("outside", "2021-02-01");
await make("draft", null);

const inks = async (slug: string) => (await storedRenderParts(s, doc as never, (await storedCarouselRaw(s, slug)).scheduledFor)).brand.colors.ink;
assert.equal(await inks("inside"), "#abcdef", "scheduled inside the range: themed (preview and export share storedRenderParts)");
assert.equal(await inks("outside"), original);
assert.equal(await inks("draft"), original, "no date: the brand's today");

// A timestamp is read in the brand's zone: 22:00 in Honolulu on the last day is already the next day in UTC.
await repos.documents.put(brand.id, "config", "", { json: { timezone: "Pacific/Honolulu" }, schemaVersion: 1 }, meta);
await make("late-last-day", "2020-12-31T22:00:00-10:00");
await make("next-local-day", "2021-01-01T00:30:00-10:00");
assert.equal(await inks("late-last-day"), "#abcdef", "22:00 local on the theme's last day: still themed");
assert.equal(await inks("next-local-day"), original, "the next local day: not themed");
console.log("stored-theme: ok");
