import { test } from "node:test";
import assert from "node:assert/strict";
import { newBatchId, stampBatch, recordImport, latestUndoable, removeBatch, dropLogEntry, importAges, IMPORT_LOG_KEEP } from "../core/import-log.mjs";

test("batch ids are unique within a burst", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newBatchId(1700000000000)));
  assert.equal(ids.size, 50);
});

test("stamping marks NEW rows only and leaves the originals untouched", () => {
  const rows = [{ id: "a" }, { id: "b" }];
  const stamped = stampBatch(rows, "b1");
  assert.ok(stamped.every((r) => r.batchId === "b1"));
  assert.equal(rows[0].batchId, undefined, "input rows are not mutated");
  assert.deepEqual(stampBatch(rows, null), rows, "no id, no stamp");
});

test("the log records what an import was, newest first, and caps its length", () => {
  let log = recordImport([], { batchId: "b1", source: "IBKR", account: "IBKR GIA", wrapper: "GIA", txns: 14, income: 1 }, { now: "2026-09-01T10:00:00Z" });
  log = recordImport(log, { batchId: "b2", source: "Fidelity", txns: 3 }, { now: "2026-09-02T10:00:00Z" });
  assert.equal(log[0].batchId, "b2", "latest first");
  assert.equal(log[1].account, "IBKR GIA");
  assert.throws(() => recordImport(log, { source: "x" }), /batchId/);

  let big = [];
  for (let i = 0; i < IMPORT_LOG_KEEP + 20; i++) big = recordImport(big, { batchId: `x${i}`, source: "s", txns: 1 });
  assert.equal(big.length, IMPORT_LOG_KEEP);
});

test("'undo last import' means the last one that ADDED something", () => {
  // An import where every row was deduped away isn't what the user wants
  // to undo — that would undo the real one before it… or nothing at all.
  let log = recordImport([], { batchId: "real", source: "IBKR", txns: 14 }, { now: "2026-09-01T10:00:00Z" });
  log = recordImport(log, { batchId: "empty", source: "IBKR", txns: 0, income: 0, skipped: 20 }, { now: "2026-09-02T10:00:00Z" });
  assert.equal(latestUndoable(log).batchId, "real");
  assert.equal(latestUndoable([]), null);
});

test("removing a batch takes exactly its rows and hands them back for re-undo", () => {
  const txns = [
    { id: "1", ticker: "TG30", batchId: "b1" },
    { id: "2", ticker: "TG36", batchId: "b2" },
    { id: "3", ticker: "VWRL" },                       // manual, no batch
    { id: "4", ticker: "TG36", batchId: "b2" },
  ];
  const { kept, removed } = removeBatch(txns, "b2");
  assert.deepEqual(kept.map((t) => t.id), ["1", "3"]);
  assert.deepEqual(removed.map((t) => t.id), ["2", "4"]);
  assert.equal(removeBatch(txns, "nope").removed.length, 0);
  assert.deepEqual(dropLogEntry([{ batchId: "b1" }, { batchId: "b2" }], "b2"), [{ batchId: "b1" }]);
});

test("import ages come from the log, per source, ignoring empty imports", () => {
  const log = [
    { batchId: "c", source: "IBKR", at: "2026-09-10T09:00:00Z", txns: 0, income: 0 },   // empty, ignored
    { batchId: "b", source: "IBKR", at: "2026-08-20T09:00:00Z", txns: 5 },
    { batchId: "a", source: "Fidelity", at: "2026-06-01T09:00:00Z", txns: 2 },
  ];
  const ages = Object.fromEntries(importAges(log, "2026-09-18").map((a) => [a.source, a.days]));
  assert.equal(ages.IBKR, 29, "the last import that delivered rows, not the empty one");
  assert.equal(ages.Fidelity, 109);
  assert.deepEqual(importAges([], "2026-09-18"), []);
});
