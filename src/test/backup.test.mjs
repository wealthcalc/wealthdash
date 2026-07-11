import { test } from "node:test";
import assert from "node:assert/strict";
import { PERSIST_KEYS } from "../state/durable.js";
import {
  buildBackup, restorePlan, exportedKeys, BACKUP_VERSION,
  EXPORT_EXCLUDED, RESTORE_ONLY, ID_ARRAYS, MERGE_KEYS,
} from "../core/backup.mjs";

test("every persisted key is either exported or deliberately excluded — a new key can't silently fall out of backups", () => {
  const all = Object.keys(PERSIST_KEYS);
  const covered = new Set([...exportedKeys(), ...EXPORT_EXCLUDED]);
  for (const k of all) assert.ok(covered.has(k), `${k} is neither exported nor in EXPORT_EXCLUDED — decide and add it`);
  // and every exported/restore-only key has a validation type (restorePlan
  // silently skips typeless keys, which would be a quiet data loss)
  const sample = Object.fromEntries([...exportedKeys(), ...RESTORE_ONLY].map((k) => [k, []]));
  const plan = restorePlan({ __cgtBackup: true, ...sample });
  for (const k of exportedKeys()) {
    const handled = k in plan.updates || k in plan.merges || plan.skipped.includes(k);
    assert.ok(handled, `${k} has no TYPES entry`);
  }
});

test("secrets and UI state are excluded from export but secrets restore from old files", () => {
  const state = { txns: [], avKey: "SECRET", ibkrToken: "TOKEN", dark: true, tab: "cgt", income: 1 };
  const backup = buildBackup(state);
  assert.equal(backup.avKey, undefined);
  assert.equal(backup.ibkrToken, undefined);
  assert.equal(backup.dark, undefined);
  assert.equal(backup.tab, undefined);
  assert.equal(backup.version, BACKUP_VERSION);
  // v12-era file WITH secrets still restores them
  const plan = restorePlan({ __cgtBackup: true, version: 12, avKey: "OLD", ibkrToken: "OLDTOK" });
  assert.equal(plan.updates.avKey, "OLD");
  assert.equal(plan.updates.ibkrToken, "OLDTOK");
});

test("roundtrip: build -> restore reproduces every exported value (fees/account riding inside txns)", () => {
  const state = {};
  for (const k of exportedKeys()) {
    const t = { array: [], object: { a: 1 }, number: 7, string: "x" };
    state[k] = Array.isArray([]) && ID_ARRAYS.includes(k)
      ? [{ id: "1", note: k }]
      : ({ txns: [], valuations: [{ date: "2026-01-01", value: 1 }], netWorthSnapshots: [{ date: "2026-01-01", value: 1 }] }[k]
        ?? ({ income: 100, carried: 5, ibkrQueryId: "q" }[k] ?? { a: 1 }));
  }
  state.txns = [{ id: "t1", side: "BUY", ticker: "ABC", quantity: 1, gbpAmount: 100, fees: 2.5, account: "HL ISA" }];
  const plan = restorePlan(buildBackup(state));
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.skipped, []);
  for (const k of exportedKeys()) {
    const got = MERGE_KEYS.includes(k) ? plan.merges[k] : plan.updates[k];
    assert.deepEqual(got, state[k], k);
  }
  assert.equal(plan.updates.txns[0].fees, 2.5);
  assert.equal(plan.updates.txns[0].account, "HL ISA");
});

test("type mismatches are skipped, not applied", () => {
  const plan = restorePlan({ __cgtBackup: true, txns: { not: "an array" }, income: "not a number", prices: [1, 2] });
  assert.deepEqual(plan.skipped.sort(), ["income", "prices", "txns"]);
  assert.deepEqual(plan.updates, {});
});

test("legacy bare-array import becomes txns with refilled ids", () => {
  const plan = restorePlan([{ ticker: "ABC" }, { id: "keep", ticker: "DEF" }], { uid: () => "new" });
  assert.equal(plan.legacy, true);
  assert.equal(plan.updates.txns[0].id, "new");
  assert.equal(plan.updates.txns[1].id, "keep");
});

test("id refill applies to id-arrays only; junk input errors politely", () => {
  const plan = restorePlan({ __cgtBackup: true, properties: [{ label: "flat" }], valuations: [{ date: "2026-01-01", value: 1 }] }, { uid: () => "new" });
  assert.equal(plan.updates.properties[0].id, "new");
  assert.equal(plan.updates.valuations[0].id, undefined); // snapshots have no ids
  assert.ok(restorePlan("garbage").error);
  assert.ok(restorePlan(null).error);
  assert.ok(restorePlan({ random: true }).error);
});
