import { test } from "node:test";
import assert from "node:assert/strict";
import { niceTicks } from "../core/chart-scale.mjs";

/* The contract isn't "every label is a round number in isolation" — 850,000
   is a perfectly good gridline. It's that all labels are multiples of a
   round STEP, which is what makes an axis countable. */
const stepIsNice = (ticks) => {
  if (ticks.length < 2) return true;
  const step = ticks[1] - ticks[0];
  const mag = 10 ** Math.floor(Math.log10(Math.abs(step)));
  const norm = Math.abs(step) / mag;
  return [1, 2, 2.5, 5, 10].some((n) => Math.abs(norm - n) < 1e-6);
};
const allMultiplesOfStep = (ticks) => {
  if (ticks.length < 2) return true;
  const step = ticks[1] - ticks[0];
  return ticks.every((v) => Math.abs(v / step - Math.round(v / step)) < 1e-6);
};

test("ticks are round numbers a person would count in, not evenly-sliced raw values", () => {
  // An axis reading 847,213 / 903,559 is arithmetically even and unreadable.
  const t = niceTicks(847213, 1015900, 4);
  assert.ok(t.length >= 2, "a usable axis needs several gridlines");
  assert.ok(stepIsNice(t), `step ${t[1] - t[0]} isn't a round interval`);
  assert.ok(allMultiplesOfStep(t), "labels must all sit on the same round grid");
});

test("ticks stay strictly inside the data range — a gridline can't imply unseen values", () => {
  const lo = 12345, hi = 98765;
  for (const v of niceTicks(lo, hi, 4)) {
    assert.ok(v >= lo && v <= hi, `${v} escapes [${lo}, ${hi}]`);
  }
});

test("spacing is uniform, so equal screen distance means equal money", () => {
  const t = niceTicks(0, 1000, 4);
  const gaps = t.slice(1).map((v, i) => v - t[i]);
  for (const g of gaps) assert.ok(Math.abs(g - gaps[0]) < 1e-6, "uneven gridlines misrepresent the scale");
});

test("works across the magnitudes this app actually spans", () => {
  for (const [lo, hi] of [[0, 500], [900, 1100], [50000, 250000], [900000, 1300000], [0.5, 2.5]]) {
    const t = niceTicks(lo, hi, 4);
    assert.ok(t.length >= 1, `no ticks for [${lo}, ${hi}]`);
    for (const v of t) assert.ok(v >= lo && v <= hi, `tick ${v} escapes [${lo}, ${hi}]`);
    assert.ok(stepIsNice(t) && allMultiplesOfStep(t), `ungrid-like ticks for [${lo}, ${hi}]`);
  }
});

test("a flat or invalid range degrades safely instead of looping forever", () => {
  assert.deepEqual(niceTicks(100, 100), [100]);
  assert.deepEqual(niceTicks(100, 50), [100], "inverted range doesn't hang");
  assert.deepEqual(niceTicks(NaN, 10), [], "no finite anchor at all -> no axis");
  assert.deepEqual(niceTicks(0, Infinity), [0], "degrades to the one value it can trust");
});
