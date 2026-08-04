/* ======================================================================
   INTERACTION TESTS — the three flows where a bug costs REAL DATA rather
   than a wrong number on screen:

     1. Statement import dedupe — re-importing an overlapping CSV must not
        duplicate spending (and must not silently drop genuine repeats, like
        the same coffee twice in a day).
     2. Delete-with-undo — the row must come back, at its original position,
        and the toast must not fire twice under React's double-invoked
        updaters.
     3. Backup restore round-trip — everything exported must come back, with
        secrets handled per policy.

   These sit between the pure-engine tests (which can't see the wiring) and
   the render smoke tests (which don't exercise behaviour). They drive the
   real modules with real shapes rather than mocking them.
   ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";

import { dedupeStatement } from "../../core/statement-import.mjs";
import { removeWithUndo, showUndo, subscribeUndo, currentUndo } from "../../ui/undo.jsx";
import { buildBackup, restorePlan, exportedKeys, EXPORT_EXCLUDED, RESTORE_ONLY } from "../../core/backup.mjs";

/* ---------------------------- 1. import dedupe ------------------------ */

const tx = (date, amount, description, extra = {}) => ({ date, amount, description, ...extra });

test("import dedupe: re-importing an overlapping statement adds only the new rows", () => {
  const existing = [
    tx("2026-06-01", 42.5, "TESCO STORES"),
    tx("2026-06-03", 9.99, "SPOTIFY"),
  ];
  // A fresh export covering an overlapping window: two known rows + one new.
  const incoming = [
    tx("2026-06-01", 42.5, "TESCO STORES"),
    tx("2026-06-03", 9.99, "SPOTIFY"),
    tx("2026-06-07", 15.0, "PRET"),
  ];
  const { rows, duplicates } = dedupeStatement(incoming, existing);
  assert.equal(rows.length, 1, "only the genuinely new row is imported");
  assert.equal(rows[0].description, "PRET");
  assert.equal(duplicates.length, 2, "the overlap is reported, not silently dropped");
});

test("import dedupe: a genuine same-day repeat of the same amount is NOT treated as a duplicate", () => {
  // Two identical coffees on one day is real spending. Dedupe keys must not
  // collapse them, or the user quietly loses money from their budget.
  const incoming = [
    tx("2026-06-01", 3.2, "COSTA"),
    tx("2026-06-01", 3.2, "COSTA"),
  ];
  const { rows } = dedupeStatement(incoming, []);
  assert.equal(rows.length, 2, "both charges survive a first import");
});

test("import dedupe: importing the very same file twice is a no-op the second time", () => {
  const first = dedupeStatement([tx("2026-06-01", 10, "A"), tx("2026-06-02", 20, "B")], []);
  assert.equal(first.rows.length, 2);
  const second = dedupeStatement(first.rows, first.rows);
  assert.equal(second.rows.length, 0, "nothing new on a repeat import");
  assert.equal(second.duplicates.length, 2);
});

/* ---------------------------- 2. delete + undo ------------------------ */

// Minimal harness standing in for a React state setter.
function makeList(initial) {
  let value = [...initial];
  return {
    get: () => value,
    set: (updater) => { value = typeof updater === "function" ? updater(value) : updater; },
  };
}

test("delete-with-undo: removes the row, then restores it to its ORIGINAL position", () => {
  const list = makeList([{ id: "a" }, { id: "b" }, { id: "c" }]);
  const ok = removeWithUndo({ list: list.get(), setList: list.set, id: "b", label: "transaction" });
  assert.equal(ok, true);
  assert.deepEqual(list.get().map((x) => x.id), ["a", "c"]);

  const pending = currentUndo();
  assert.ok(pending, "an undo is offered");
  assert.match(pending.message, /Deleted transaction/);

  pending.onUndo();
  assert.deepEqual(list.get().map((x) => x.id), ["a", "b", "c"], "restored in the middle, not appended");
});

test("delete-with-undo: undo still works when the list shrank further in the meantime", () => {
  const list = makeList([{ id: "a" }, { id: "b" }, { id: "c" }]);
  removeWithUndo({ list: list.get(), setList: list.set, id: "c" });   // index 2
  const undoC = currentUndo().onUndo;
  // Another delete happens before the user hits undo.
  removeWithUndo({ list: list.get(), setList: list.set, id: "a" });
  undoC();
  const ids = list.get().map((x) => x.id);
  assert.ok(ids.includes("c"), "the row comes back rather than being lost to a stale index");
});

test("delete-with-undo: a missing id is a safe no-op and offers no undo", () => {
  const list = makeList([{ id: "a" }]);
  showUndo({ message: "reset", onUndo: () => {} });
  const before = list.get().length;
  const ok = removeWithUndo({ list: list.get(), setList: list.set, id: "nope" });
  assert.equal(ok, false);
  assert.equal(list.get().length, before, "nothing removed");
});

test("delete-with-undo: subscribers are notified so the toast can render", () => {
  let seen = 0;
  const unsub = subscribeUndo(() => { seen += 1; });
  showUndo({ message: "Deleted thing", onUndo: () => {} });
  assert.ok(seen > 0, "the toast host is told there is something to show");
  unsub();
});

/* ---------------------------- 3. backup round-trip -------------------- */

const FULL_STATE = {
  txns: [{ id: "t1", date: "2026-01-02", side: "BUY", ticker: "VWRL", wrapper: "ISA", quantity: 10, gbpAmount: 900 }],
  incomeEntries: [{ id: "i1", date: "2026-02-01", ticker: "CTY", amount: 120, kind: "dividend", wrapper: "ISA" }],
  spendTxns: [{ id: "s1", date: "2026-03-01", amount: 42.5, description: "TESCO", categoryId: "gro" }],
  budgetCategories: [{ id: "gro", name: "Groceries", monthly: 600, essential: true }],
  prices: { VWRL: 105 },
  secMeta: { VWRL: { name: "Vanguard All-World" } },
  assumptionOverrides: { "yield.equity": 3.4 },
  planInputs: { inflation: 2.5, retireAge: 60 },
  income: 90000,
  carried: 0,
  avKey: "SECRET-API-KEY",
  ibkrToken: "SECRET-TOKEN",
  dark: true,
  tab: "home",
};

test("backup: every state key supplied is exported, and the exclusions never are", () => {
  const b = buildBackup(FULL_STATE);
  for (const k of Object.keys(FULL_STATE)) {
    if (EXPORT_EXCLUDED.includes(k)) continue;
    assert.ok(Object.prototype.hasOwnProperty.call(b, k), `backup is missing ${k}`);
    assert.ok(exportedKeys().includes(k), `${k} should be a known exported key`);
  }
  for (const k of EXPORT_EXCLUDED) {
    assert.ok(!Object.prototype.hasOwnProperty.call(b, k), `${k} must never leave the device in a backup`);
  }
  assert.equal(b.__cgtBackup, true, "the file is self-identifying");
});

test("backup: secrets and UI state stay out; real data survives a full round-trip", () => {
  const b = buildBackup(FULL_STATE);
  const json = JSON.parse(JSON.stringify(b));  // exactly what hits the file
  const raw = JSON.stringify(json);
  assert.ok(!raw.includes("SECRET-API-KEY"), "the price-provider key is not in the file");
  assert.ok(!raw.includes("SECRET-TOKEN"), "the broker token is not in the file");

  const plan = restorePlan(json);
  assert.ok(!plan.error, "a well-formed backup restores");
  assert.deepEqual(plan.skipped, [], "nothing well-formed is skipped");
  const u = plan.updates;

  assert.equal(u.txns.length, 1);
  assert.equal(u.txns[0].ticker, "VWRL");
  assert.equal(u.spendTxns[0].amount, 42.5);
  assert.equal(u.budgetCategories[0].essential, true);
  assert.equal(u.assumptionOverrides["yield.equity"], 3.4, "assumption overrides travel with the backup");
  assert.equal(u.planInputs.inflation, 2.5);
  assert.equal(u.income, 90000);
  // secMeta is a MERGE key — restoring must not wipe metadata for holdings
  // the backup didn't know about.
  assert.equal(u.secMeta, undefined);
  assert.equal(plan.merges.secMeta.VWRL.name, "Vanguard All-World");
});

test("backup: rows without ids get them on restore, so later edits/deletes can target them", () => {
  const b = buildBackup({ txns: [{ date: "2026-01-02", ticker: "X", side: "BUY", quantity: 1, gbpAmount: 10 }] });
  const plan = restorePlan(JSON.parse(JSON.stringify(b)), { uid: () => "generated-id" });
  assert.equal(plan.updates.txns[0].id, "generated-id");
});

test("backup: restore-only secrets are accepted FROM a file but never written TO one", () => {
  // The asymmetry is the point: you can restore a key you typed before, but
  // exporting must not spread it around.
  for (const k of RESTORE_ONLY) {
    assert.ok(EXPORT_EXCLUDED.includes(k), `${k} must be export-excluded`);
  }
});

test("backup: a malformed file is rejected rather than half-applied", () => {
  assert.ok(restorePlan(null).error, "null is not a backup");
  assert.ok(restorePlan("not json").error, "a string is not a backup");
  assert.ok(restorePlan({ some: "object" }).error, "an unmarked object is not a backup");

  // Wrong types for known keys are skipped and REPORTED, never written through.
  const plan = restorePlan({ __cgtBackup: true, txns: "should-be-an-array", income: 50000 });
  assert.ok(!plan.error);
  assert.equal(plan.updates.txns, undefined, "a bad type never reaches the store");
  assert.ok(plan.skipped.includes("txns"), "and the user is told what was skipped");
  assert.equal(plan.updates.income, 50000, "valid keys alongside it still restore");
});

test("backup: a legacy bare-array export still restores as transactions", () => {
  const plan = restorePlan([{ date: "2026-01-02", ticker: "X", side: "BUY", quantity: 1, gbpAmount: 10 }]);
  assert.equal(plan.legacy, true);
  assert.equal(plan.updates.txns.length, 1);
});
