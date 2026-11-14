import assert from "node:assert/strict";

import type { Page } from "playwright";

import { loadStoredSlide, type LoadWithResolver } from "./stored-load.js";
import { StorageFailure } from "./stored-read.js";

/** The load/check closure of a stored slide, with a fake `loadWithResolver`: no browser. */
const page = {} as Page;
const outage = new StorageFailure(new Error("bucket down"));

/** Asks the resolver for one asset; if it fails, refuses either at load or only in the late check, like the real one. */
const fakeLoad = (late: boolean): LoadWithResolver => async (_page, _html, resolve) => {
  const failure = await resolve("a1").then(() => undefined, (error: unknown) => error);
  if (failure && !late) throw new Error("request refused");
  return () => {
    if (failure) throw new Error("request refused");
  };
};

const tests: Array<[string, () => Promise<void>]> = [
  ["a resolver outage during the load, or seen only by the late check, surfaces as the StorageFailure", async () => {
    const fail = async () => { throw outage; };
    await assert.rejects(loadStoredSlide(page, "<p/>", fail, fakeLoad(false)), (e) => e === outage);
    assert.throws(await loadStoredSlide(page, "<p/>", fail, fakeLoad(true)), (e) => e === outage);
  }],
  ["a refusal that is not a storage outage stays a render error", async () => {
    const fail = async () => { throw new Error("asset hidden"); };
    await assert.rejects(loadStoredSlide(page, "<p/>", fail, fakeLoad(false)), /request refused/);
    assert.throws(await loadStoredSlide(page, "<p/>", fail, fakeLoad(true)), /request refused/);
  }],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(error as Error).message.split("\n").slice(0, 6).join(" | ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
