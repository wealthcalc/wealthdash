import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeAgainstExisting } from "../core/dedupe.mjs";

const byId = (r) => r.id ?? null;
const byContent = (r) => `${r.date}|${r.amount}`;

test("dedupeAgainstExisting: single key function — drops rows matching an existing key", () => {
  const existing = [{ date: "2026-01-01", amount: 10 }];
  const incoming = [{ date: "2026-01-01", amount: 10 }, { date: "2026-01-02", amount: 20 }];
  const r = dedupeAgainstExisting(incoming, existing, byContent);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].date, "2026-01-02");
  assert.equal(r.skipped, 1);
});

test("dedupeAgainstExisting: single key function — also drops repeats within the same incoming batch", () => {
  const incoming = [{ date: "2026-01-01", amount: 10 }, { date: "2026-01-01", amount: 10 }];
  const r = dedupeAgainstExisting(incoming, [], byContent);
  assert.equal(r.rows.length, 1);
  assert.equal(r.skipped, 1);
});

test("dedupeAgainstExisting: array of key functions — a match on ANY function counts as a duplicate", () => {
  const existing = [{ id: "T1", date: "2026-01-01", amount: 10 }];
  // Different content (amount drifted slightly) but the same id — should
  // still be caught, which is exactly why an id-based key is preferred
  // when available (e.g. IBKR tradeID) over a content key alone.
  const incoming = [{ id: "T1", date: "2026-01-01", amount: 10.004 }];
  const r = dedupeAgainstExisting(incoming, existing, [byId, byContent]);
  assert.equal(r.rows.length, 0);
  assert.equal(r.skipped, 1);
});

test("dedupeAgainstExisting: array of key functions — falls back to content key when id is null on both sides", () => {
  const existing = [{ id: null, date: "2026-01-01", amount: 10 }];
  const incoming = [{ id: null, date: "2026-01-01", amount: 10 }];
  const r = dedupeAgainstExisting(incoming, existing, [byId, byContent]);
  assert.equal(r.rows.length, 0); // caught by content key even though id is null on both
  assert.equal(r.skipped, 1);
});

test("dedupeAgainstExisting: array of key functions — two different no-id rows never collide with each other on the id key", () => {
  const existing = [{ id: null, date: "2026-01-01", amount: 10 }];
  const incoming = [{ id: null, date: "2026-02-01", amount: 99 }]; // different content, both ids null
  const r = dedupeAgainstExisting(incoming, existing, [byId, byContent]);
  assert.equal(r.rows.length, 1); // not a duplicate — content differs, and null ids don't match each other
  assert.equal(r.skipped, 0);
});

test("dedupeAgainstExisting: array of key functions — a genuinely new id with matching content is still imported once, then dedupes on re-run", () => {
  const existing = [];
  const first = [{ id: "T2", date: "2026-03-01", amount: 50 }];
  const r1 = dedupeAgainstExisting(first, existing, [byId, byContent]);
  assert.equal(r1.rows.length, 1);
  const r2 = dedupeAgainstExisting(first, [...existing, ...r1.rows], [byId, byContent]);
  assert.equal(r2.rows.length, 0);
  assert.equal(r2.skipped, 1);
});

test("dedupeAgainstExisting: empty inputs don't throw", () => {
  assert.deepEqual(dedupeAgainstExisting([], [], byContent), { rows: [], skipped: 0 });
  assert.deepEqual(dedupeAgainstExisting([], [], [byId, byContent]), { rows: [], skipped: 0 });
});
