import assert from "node:assert/strict";

import { ApiError, createCarousel, getCarousel, putCarousel } from "./client";
import type { CarouselDocument } from "./types";

/** The version tag the client keeps per carousel: read from GET, sent as If-Match, renewed by the save, tolerated absent. */
type Call = { method: string; ifMatch: string | null; keepalive: boolean };
const calls: Call[] = [];
let reply: (call: Call) => { status: number; etag?: string; body: unknown } = () => ({ status: 200, body: {} });

globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  const call = { method: init?.method ?? "GET", ifMatch: headers.get("If-Match"), keepalive: init?.keepalive === true };
  calls.push(call);
  const r = reply(call);
  return new Response(JSON.stringify(r.body), { status: r.status, headers: r.etag ? { ETag: r.etag } : {} });
}) as typeof fetch;

const doc = { id: "week-one" } as CarouselDocument;

reply = () => ({ status: 200, etag: '"3"', body: doc });
await getCarousel("stored-brand", "week-one");

reply = () => ({ status: 200, etag: '"4"', body: doc });
await putCarousel("stored-brand", doc);
assert.equal(calls.at(-1)!.ifMatch, '"3"', "the save names the version the GET returned");

await putCarousel("stored-brand", doc, { keepalive: true });
assert.deepEqual(calls.at(-1), { method: "PUT", ifMatch: '"4"', keepalive: true }, "a pagehide save sends the tag the last save returned");

reply = () => ({ status: 409, etag: '"9"', body: { error: "conflict" } });
await assert.rejects(putCarousel("stored-brand", doc), (error: unknown) => error instanceof ApiError && error.status === 409);
await putCarousel("stored-brand", doc).catch(() => {});
assert.equal(calls.at(-1)!.ifMatch, '"4"', "a 409's tag is not adopted: a later save still names the copy this tab edited");
reply = () => ({ status: 200, etag: '"9"', body: doc });
await getCarousel("stored-brand", "week-one");
await putCarousel("stored-brand", doc);
assert.equal(calls.at(-1)!.ifMatch, '"9"', "the reload GET brings the tag of the winner's copy");

reply = () => ({ status: 200, body: doc });
await getCarousel("folder-brand", "week-one");
await putCarousel("folder-brand", doc);
assert.equal(calls.at(-1)!.ifMatch, null, "a folder brand sends no If-Match");

reply = () => ({ status: 201, etag: '"1"', body: { document: { id: "fresh-one" } } });
await createCarousel("stored-brand", { title: "New", blank: true });
reply = () => ({ status: 200, etag: '"2"', body: doc });
await putCarousel("stored-brand", { id: "fresh-one" } as CarouselDocument);
assert.equal(calls.at(-1)!.ifMatch, '"1"', "the first save of a created carousel names the version the create returned");

console.log("client: 7 passed");
