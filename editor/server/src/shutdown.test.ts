import assert from "node:assert/strict";

import { runShutdown } from "./shutdown.js";

const never = () => new Promise<void>(() => {});
const tests: Array<[string, () => Promise<void>]> = [
  ["every step closes, in order, and the code is 0", async () => {
    const order: string[] = [];
    const code = await runShutdown([{ name: "a", close: () => void order.push("a") }, { name: "b", close: async () => void order.push("b") }], { stepMs: 50 });
    assert.deepEqual([code, order], [0, ["a", "b"]]);
  }],
  ["a hung close is abandoned after its bound, a failing one is reported, and the next step still runs", async () => {
    const logs: string[] = [];
    let poolClosed = false;
    const started = Date.now();
    const failing = { name: "failing", close: () => { throw new Error("boom"); } };
    const code = await runShutdown([{ name: "browser", close: never }, failing, { name: "pool", close: () => void (poolClosed = true) }], { stepMs: 30, log: (m) => logs.push(m) });
    assert.equal(code, 1);
    assert.ok(poolClosed);
    assert.match(logs[1]!, /"failing" failed: boom/);
    assert.ok(Date.now() - started < 1000);
    assert.match(logs[0]!, /"browser" did not close within 30 ms/);
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
