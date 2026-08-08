import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeBrokerPositions, reconcilePositions, balancingDraft } from "../core/position-reconcile.mjs";

// IBKR OpenPosition attribute rows, as api/ibkr-flex.mjs extracts them.
const OPEN = [
  { symbol: "VOD", isin: "GB00BH4HKS39", currency: "GBP", listingExchange: "LSE", position: "1000" },
  { symbol: "WFC", isin: "US9497461015", currency: "USD", listingExchange: "NYSE", position: "327" },
  { symbol: "VWRL", isin: "IE00B3RBWM25", currency: "GBP", listingExchange: "LSE", position: "100" },
];

test("broker rows resolve to the SAME tickers the trade importer uses", () => {
  // Naming must agree or every line looks like a mismatch: LSE/GBP lines get
  // the .L suffix, and an ISIN seed overrides the raw symbol entirely.
  const rows = shapeBrokerPositions(OPEN, { seedByIsin: { GB00BH4HKS39: "VOD.L" } });
  const byTicker = Object.fromEntries(rows.map((r) => [r.ticker, r.qty]));
  assert.equal(byTicker["VOD.L"], 1000);
  assert.equal(byTicker["VWRL.L"], 100, "LSE/GBP line gets .L even without a seed");
  assert.equal(byTicker.WFC, 327, "US line keeps its bare symbol");
});

test("broker rows: one holding split across lots is summed; closed lines are dropped", () => {
  const rows = shapeBrokerPositions([
    { symbol: "WFC", currency: "USD", position: "200" },
    { symbol: "WFC", currency: "USD", position: "127" },
    { symbol: "GONE", currency: "USD", position: "0" },       // closed
    { symbol: "BAD", currency: "USD", position: "not a number" },
    { symbol: "", currency: "USD", position: "5" },            // no symbol
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, "WFC");
  assert.equal(rows[0].qty, 327);
});

test("a clean account reconciles with no mismatches", () => {
  const positions = [
    { ticker: "VOD.L", wrapper: "GIA", qty: 1000 },
    { ticker: "WFC", wrapper: "GIA", qty: 327 },
    { ticker: "VWRL.L", wrapper: "GIA", qty: 100 },
  ];
  const broker = shapeBrokerPositions(OPEN, { seedByIsin: { GB00BH4HKS39: "VOD.L" } });
  const { summary, rows } = reconcilePositions({ broker, positions });
  assert.equal(summary.clean, true);
  assert.equal(summary.mismatched, 0);
  assert.ok(rows.every((r) => r.status === "match"));
});

test("the dangerous case: broker holds MORE than the ledger explains", () => {
  // The real-world bug this exists for — vested shares that never reached the
  // ledger, so cost basis and every downstream CGT figure are wrong.
  const positions = [{ ticker: "WFC", wrapper: "GIA", qty: 0 }];
  const broker = [{ ticker: "WFC", qty: 327 }];
  const { rows, summary } = reconcilePositions({ broker, positions });
  assert.equal(rows[0].status, "missing-in-ledger");
  assert.equal(rows[0].diff, 327);
  assert.equal(summary.missingInLedger, 1);
  assert.equal(summary.clean, false);
});

test("ledger ahead of broker, and holdings the broker doesn't report at all", () => {
  const positions = [
    { ticker: "VOD.L", wrapper: "GIA", qty: 1500 },   // 500 more than broker
    { ticker: "SMT.L", wrapper: "GIA", qty: 50 },     // broker says nothing
  ];
  const broker = [{ ticker: "VOD.L", qty: 1000 }];
  const { rows, summary } = reconcilePositions({ broker, positions });
  const byTicker = Object.fromEntries(rows.map((r) => [r.ticker, r]));
  assert.equal(byTicker["VOD.L"].status, "extra-in-ledger");
  assert.equal(byTicker["VOD.L"].diff, -500);
  assert.equal(byTicker["SMT.L"].status, "not-at-broker");
  assert.equal(summary.extraInLedger, 1);
  assert.equal(summary.notAtBroker, 1);
});

test("only the wrappers the broker covers are judged — an ISA isn't 'missing'", () => {
  const positions = [
    { ticker: "WFC", wrapper: "GIA", qty: 327 },
    { ticker: "VWRL.L", wrapper: "ISA", qty: 100 },   // different account entirely
  ];
  const { rows } = reconcilePositions({ broker: [{ ticker: "WFC", qty: 327 }], positions, wrappers: ["GIA"] });
  assert.equal(rows.length, 1, "the ISA holding is out of scope, not a discrepancy");
  assert.equal(rows[0].status, "match");
});

test("the same ticker across two in-scope wrappers is aggregated before comparing", () => {
  const positions = [
    { ticker: "WFC", wrapper: "GIA", qty: 200 },
    { ticker: "WFC", wrapper: "SIPP", qty: 127 },
  ];
  const { rows } = reconcilePositions({ broker: [{ ticker: "WFC", qty: 327 }], positions, wrappers: ["GIA", "SIPP"] });
  assert.equal(rows[0].status, "match");
  assert.equal(rows[0].ledgerQty, 327);
  assert.equal(rows[0].wrapper, "GIA/SIPP");
});

test("fractional rounding is tolerated; a real difference is not", () => {
  const near = reconcilePositions({ broker: [{ ticker: "X", qty: 100.0005 }], positions: [{ ticker: "X", wrapper: "GIA", qty: 100 }] });
  assert.equal(near.rows[0].status, "match");
  const real = reconcilePositions({ broker: [{ ticker: "X", qty: 101 }], positions: [{ ticker: "X", wrapper: "GIA", qty: 100 }] });
  assert.equal(real.rows[0].status, "missing-in-ledger");
});

test("mismatches sort above matches, biggest discrepancy first", () => {
  const { rows } = reconcilePositions({
    broker: [{ ticker: "OK", qty: 10 }, { ticker: "SMALL", qty: 11 }, { ticker: "BIG", qty: 500 }],
    positions: [
      { ticker: "OK", wrapper: "GIA", qty: 10 },
      { ticker: "SMALL", wrapper: "GIA", qty: 10 },
      { ticker: "BIG", wrapper: "GIA", qty: 100 },
    ],
  });
  assert.deepEqual(rows.map((r) => r.ticker), ["BIG", "SMALL", "OK"]);
});

test("balancing draft states the quantity but never invents a price or date", () => {
  const short = balancingDraft({ ticker: "WFC", diff: 327, brokerQty: 327, ledgerQty: 0, status: "missing-in-ledger" });
  assert.equal(short.side, "BUY");
  assert.equal(short.quantity, 327);
  assert.equal(short.gbpAmount, null, "a fabricated cost would corrupt the CGT pool");
  assert.equal(short.date, null);
  assert.match(short.note, /broker reports 327/);

  const over = balancingDraft({ ticker: "VOD.L", diff: -500, brokerQty: 1000, ledgerQty: 1500, status: "extra-in-ledger" });
  assert.equal(over.side, "SELL");
  assert.equal(over.quantity, 500);

  assert.equal(balancingDraft({ status: "match" }), null);
  assert.equal(balancingDraft(null), null);
});

test("empty inputs are safe", () => {
  assert.deepEqual(shapeBrokerPositions([]), []);
  const { rows, summary } = reconcilePositions({});
  assert.deepEqual(rows, []);
  assert.equal(summary.clean, true);
  assert.equal(summary.checked, 0);
});

test("data health ranks a broker mismatch as high severity", async () => {
  const { dataHealth } = await import("../core/data-health.mjs");
  const clean = dataHealth({ today: "2026-08-08", positionDrift: { mismatched: 0 } });
  assert.ok(!clean.issues.some((i) => i.id === "position-drift"));

  const drifted = dataHealth({ today: "2026-08-08", positionDrift: { mismatched: 1, missingInLedger: 1 } });
  const issue = drifted.issues.find((i) => i.id === "position-drift");
  assert.ok(issue, "a mismatch must surface");
  assert.equal(issue.severity, "high");
  assert.match(issue.detail, /cost basis and CGT/);
});
