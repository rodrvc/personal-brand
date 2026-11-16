import assert from "node:assert/strict";

import { weekContentDay } from "./week.js";

// Every day of the week of Mon 2026-11-30 .. Sun 2026-12-06 has the Monday as its content date, across a month boundary.
for (const day of [30, 31, 32, 33, 34, 35, 36]) assert.equal(weekContentDay(new Date(2026, 10, day, 12)), "2026-11-30", `day ${day}`);
assert.equal(weekContentDay(new Date(2026, 11, 7, 12)), "2026-12-07", "the next Monday starts the next week");
console.log("week: ok");
