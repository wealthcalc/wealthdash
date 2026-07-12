import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVisibleRange } from "../core/virtual-rows.mjs";

test("at scrollTop 0, renders from row 0 with overscan-sized lead only clamped by 0", () => {
  const r = computeVisibleRange({ scrollTop: 0, clientHeight: 400, rowHeight: 40, rowCount: 5000, overscan: 8 });
  assert.equal(r.start, 0); // floor(0/40) - 8 clamped to 0
  // visibleCount = ceil(400/40) = 10; end = 0 + 10 + 16 = 26
  assert.equal(r.end, 26);
  assert.equal(r.topPad, 0);
  assert.equal(r.bottomPad, (5000 - 26) * 40);
});

test("scrolling down moves the window and produces a non-zero top spacer", () => {
  const r = computeVisibleRange({ scrollTop: 4000, clientHeight: 400, rowHeight: 40, rowCount: 5000, overscan: 8 });
  // floor(4000/40) = 100, minus overscan 8 = 92
  assert.equal(r.start, 92);
  assert.equal(r.topPad, 92 * 40);
  assert.ok(r.end > r.start);
});

test("clamps the end at rowCount near the bottom of the list", () => {
  const r = computeVisibleRange({ scrollTop: 200000, clientHeight: 400, rowHeight: 40, rowCount: 5000, overscan: 8 });
  assert.equal(r.end, 5000);
  assert.equal(r.bottomPad, 0);
});

test("zero rows renders nothing and never throws", () => {
  const r = computeVisibleRange({ scrollTop: 0, clientHeight: 400, rowHeight: 40, rowCount: 0, overscan: 8 });
  assert.deepEqual(r, { start: 0, end: 0, topPad: 0, bottomPad: 0 });
});

test("zero row height is treated as not-yet-measured and never divides by zero", () => {
  const r = computeVisibleRange({ scrollTop: 100, clientHeight: 400, rowHeight: 0, rowCount: 100, overscan: 8 });
  assert.deepEqual(r, { start: 0, end: 0, topPad: 0, bottomPad: 0 });
});

test("a clientHeight of 0 (not yet laid out) still returns a valid, non-negative range", () => {
  const r = computeVisibleRange({ scrollTop: 0, clientHeight: 0, rowHeight: 40, rowCount: 100, overscan: 8 });
  assert.equal(r.start, 0);
  assert.ok(r.end >= r.start);
});

test("overscan of 0 still yields a sane, non-overlapping-negative range", () => {
  const r = computeVisibleRange({ scrollTop: 0, clientHeight: 400, rowHeight: 40, rowCount: 20, overscan: 0 });
  assert.equal(r.start, 0);
  assert.equal(r.end, 10); // ceil(400/40) = 10, clamped to rowCount
});

test("negative/garbage scrollTop is clamped rather than producing a negative start", () => {
  const r = computeVisibleRange({ scrollTop: -500, clientHeight: 400, rowHeight: 40, rowCount: 100, overscan: 8 });
  assert.equal(r.start, 0);
});

test("small rowCount below overscan window still returns a valid, fully-covering range", () => {
  const r = computeVisibleRange({ scrollTop: 0, clientHeight: 400, rowHeight: 40, rowCount: 3, overscan: 8 });
  assert.equal(r.start, 0);
  assert.equal(r.end, 3);
  assert.equal(r.bottomPad, 0);
});
