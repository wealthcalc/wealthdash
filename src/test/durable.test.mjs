import { test } from "node:test";
import assert from "node:assert/strict";
import { PERSIST_KEYS, SNAPSHOT_KEEP, snapshotDatesToPrune, shouldRestore } from "../state/durable.js";

test("PERSIST_KEYS covers every localStorage key the app has ever used", () => {
  const expected = [
    "cgt.dark", "cgt.txns", "cgt.tab", "cgt.income", "cgt.carried", "cgt.cash",
    "cgt.pensioncf", "cgt.dmoreportdate", "cgt.valuations", "cgt.incomeEntries",
    "cgt.eriEntries", "cgt.prices", "cgt.avkey", "cgt.avmeta", "cgt.pricemeta", "cgt.secmeta",
    "cgt.properties", "cgt.mortgages", "cgt.otherliabilities", "cgt.cashaccounts",
    "cgt.allowanceoverrides", "cgt.planinputs",
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
