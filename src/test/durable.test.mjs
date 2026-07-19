import { test } from "node:test";
import assert from "node:assert/strict";
import { PERSIST_KEYS, SNAPSHOT_KEEP, snapshotDatesToPrune, shouldRestore, LARGE_KEYS, keysWhereDurableIsAhead } from "../state/durable.js";

test("PERSIST_KEYS covers every localStorage key the app has ever used", () => {
  const expected = [
    "cgt.dark", "cgt.txns", "cgt.tab", "cgt.income", "cgt.carried", "cgt.cash",
    "cgt.pensioncf", "cgt.dmoreportdate", "cgt.valuations", "cgt.networthsnapshots", "cgt.incomeEntries",
    "cgt.eriEntries", "cgt.prices", "cgt.avkey", "cgt.avmeta", "cgt.pricemeta", "cgt.secmeta",
    "cgt.properties", "cgt.mortgages", "cgt.otherliabilities", "cgt.cashaccounts",
    "cgt.allowanceoverrides", "cgt.planinputs", "cgt.privateholdings", "cgt.privateevents",
    "cgt.rsugrants", "cgt.rsuevents", "cgt.deferredcashawards", "cgt.deferredcashvests",
    "cgt.ibkrqueryid", "cgt.ibkrtoken", "cgt.creditcards",
    "cgt.scenarios",
    "cgt.budgetcategories", "cgt.budgetrules", "cgt.spendtxns",
  ];
  assert.deepEqual(Object.values(PERSIST_KEYS).sort(), expected.sort());
});

test("snapshot pruning keeps the newest N dates", () => {
  const dates = Array.from({ length: 35 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
  const prune = snapshotDatesToPrune(dates, 30);
  assert.equal(prune.length, 5);
  assert.deepEqual(prune, dates.slice(0, 5)); // oldest five go
  assert.deepEqual(snapshotDatesToPrune(["2026-01-01"], 30), []); // under the cap
  assert.ok(SNAPSHOT_KEEP >= 7);
});

test("shouldRestore: only when localStorage lost the data keys AND the mirror has them", () => {
  const mirrorFull = ["cgt.txns", "cgt.prices", "cgt.valuations"];
  // fresh browser, no mirror -> no restore
  assert.equal(shouldRestore([], []), false);
  // healthy: localStorage intact -> never overwrite from mirror
  assert.equal(shouldRestore(["cgt.txns", "cgt.prices"], mirrorFull), false);
  // evicted: data keys gone, mirror has them -> restore
  assert.equal(shouldRestore([], mirrorFull), true);
  // settings-only residue (dark mode survived) still counts as evicted
  assert.equal(shouldRestore(["cgt.dark", "cgt.tab"], mirrorFull), true);
  // mirror holds only settings, no real data -> nothing worth restoring
  assert.equal(shouldRestore([], ["cgt.dark"]), false);
});

test("LARGE_KEYS are all real, unbounded-over-time state keys", () => {
  for (const k of LARGE_KEYS) assert.ok(k in PERSIST_KEYS, `${k} must be a real PERSIST_KEYS entry`);
  // settings-shaped keys must never be treated as "large" (their whole point
  // is that they're small and bounded, unlike a decade of transactions)
  assert.ok(!LARGE_KEYS.includes("dark"));
  assert.ok(!LARGE_KEYS.includes("planInputs"));
});

test("keysWhereDurableIsAhead: IndexedDB-primary reconciliation is strictly one-directional", () => {
  // localStorage has 3 txns, mirror has 3000 -> localStorage fell behind (quota exceeded mid-write)
  const lsBehind = { [PERSIST_KEYS.txns]: [1, 2, 3] };
  const mirrorAhead = { [PERSIST_KEYS.txns]: Array.from({ length: 3000 }) };
  assert.deepEqual(keysWhereDurableIsAhead(lsBehind, mirrorAhead), ["txns"]);

  // equal size -> never "ahead", nothing to reconcile
  const same = { [PERSIST_KEYS.txns]: [1, 2, 3] };
  assert.deepEqual(keysWhereDurableIsAhead(lsBehind, same), []);

  // mirror SMALLER than localStorage (e.g. user just deleted rows this
  // session, before the debounced mirror caught up) must never be adopted —
  // that would resurrect deleted data.
  const mirrorSmaller = { [PERSIST_KEYS.txns]: [1] };
  assert.deepEqual(keysWhereDurableIsAhead(lsBehind, mirrorSmaller), []);

  // missing keys on either side are treated as empty, not a crash
  assert.deepEqual(keysWhereDurableIsAhead({}, {}), []);
  assert.deepEqual(keysWhereDurableIsAhead({}, mirrorAhead), ["txns"]);

  // multiple large keys can be ahead simultaneously
  const lsMulti = { [PERSIST_KEYS.txns]: [1, 2], [PERSIST_KEYS.valuations]: [1, 2, 3] };
  const mirrorMulti = { [PERSIST_KEYS.txns]: [1, 2, 3, 4], [PERSIST_KEYS.valuations]: [1, 2, 3] };
  assert.deepEqual(keysWhereDurableIsAhead(lsMulti, mirrorMulti), ["txns"]);
});
