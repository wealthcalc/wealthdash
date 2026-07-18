import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileLedgerDates } from "../core/rsu.mjs";

const GRANTS = [{ id: "g1", ticker: "WFC" }];
const EVENTS = [
  { grantId: "g1", type: "vest", date: "2024-01-23", shares: 258 },
  { grantId: "g1", type: "vest", date: "2025-01-28", shares: 998 },
  { grantId: "g1", type: "sale", date: "2025-01-28", shares: 469 }, // sales are not vest dates
];

test("flags BUYs outside tolerance with the nearest vest suggested; matches pass", () => {
  const flags = reconcileLedgerDates({
    txns: [
      { id: "a", ticker: "WFC", side: "BUY", date: "2024-02-05", quantity: 222, gbpAmount: 8695 }, // 13d late — flag
      { id: "b", ticker: "WFC", side: "BUY", date: "2025-01-30", quantity: 500, gbpAmount: 19000 }, // 2d — fine
      { id: "c", ticker: "WFC", side: "SELL", date: "2024-02-15", quantity: 222, gbpAmount: 9000 }, // sells ignored
      { id: "d", ticker: "VWRL", side: "BUY", date: "2024-06-01", quantity: 10, gbpAmount: 1000 },  // not an RSU ticker
    ],
    grants: GRANTS, events: EVENTS,
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].txnId, "a");
  assert.equal(flags[0].nearestVest, "2024-01-23");
  assert.equal(flags[0].daysFromVest, 13);
  assert.equal(flags[0].likelyDrip, false);
});

test("annual-cadence market buys far from any vest are marked likely DRIPs", () => {
  const flags = reconcileLedgerDates({
    txns: [{ id: "drip", ticker: "WFC", side: "BUY", date: "2025-01-16", quantity: 37.12, gbpAmount: 1383 }],
    grants: GRANTS,
    events: [{ grantId: "g1", type: "vest", date: "2024-01-23", shares: 258 }],
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].likelyDrip, true); // 359 days from the only vest
});

test("no grants, no vests, or empty ledger -> no flags, no crash", () => {
  assert.deepEqual(reconcileLedgerDates({}), []);
  assert.deepEqual(reconcileLedgerDates({ txns: [{ ticker: "WFC", side: "BUY", date: "2024-01-01" }], grants: GRANTS, events: [] }), []);
});
