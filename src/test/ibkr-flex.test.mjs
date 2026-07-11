import { test } from "node:test";
import assert from "node:assert/strict";
import { extractElements } from "../../api/_lib/ibkr-flex-xml.mjs";
import { shapeFlexPull, shapeCashReport } from "../core/ibkr-flex.mjs";

const SAMPLE_STATEMENT = `<?xml version="1.0"?>
<FlexQueryResponse queryName="Test" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U1234567" fromDate="20250101" toDate="20260101">
<Trades>
<Trade accountId="U1234567" symbol="WFC" isin="US9497461015" currency="USD" fxRateToBase="0.7854" assetCategory="STK" tradeID="1001" tradeDate="20250315" quantity="50" tradePrice="45.23" proceeds="-2261.50" ibCommission="-1.00" buySell="BUY" netCash="-2262.50"/>
<Trade accountId="U1234567" symbol="WFC" isin="US9497461015" currency="USD" fxRateToBase="0.79" assetCategory="STK" tradeID="1002" tradeDate="20250601" quantity="20" tradePrice="50.00" proceeds="1000.00" ibCommission="-1.00" buySell="SELL" netCash="999.00"/>
<Trade accountId="U1234567" symbol="CASH.USD.GBP" currency="USD" fxRateToBase="0.79" assetCategory="CASH" tradeID="1003" tradeDate="20250601" quantity="100" tradePrice="0.79" proceeds="-79" buySell="BUY"/>
</Trades>
<CashTransactions>
<CashTransaction accountId="U1234567" symbol="WFC" isin="US9497461015" currency="USD" fxRateToBase="0.785" type="Dividends" amount="35.00" settleDate="20250601"/>
<CashTransaction accountId="U1234567" symbol="" isin="" currency="GBP" fxRateToBase="1" type="Broker Interest Received" amount="12.34" settleDate="20250701"/>
<CashTransaction accountId="U1234567" symbol="WFC" isin="US9497461015" currency="USD" fxRateToBase="0.785" type="Withholding Tax" amount="-5.25" settleDate="20250601"/>
</CashTransactions>
<CashReport>
<CashReportCurrency accountId="U1234567" currency="USD" endingCash="500.25" endingSettledCash="500.25"/>
<CashReportCurrency accountId="U1234567" currency="GBP" endingCash="120.00" endingSettledCash="120.00"/>
<CashReportCurrency accountId="U1234567" currency="BASE_SUMMARY" endingCash="900.00" endingSettledCash="900.00"/>
</CashReport>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>`;

function rawFromXml(xml) {
  return {
    trades: extractElements(xml, "Trade"),
    cashTransactions: extractElements(xml, "CashTransaction"),
    interestAccruals: extractElements(xml, "InterestAccrualsCurrency"),
    cashReport: extractElements(xml, "CashReportCurrency"),
  };
}

// A real-shaped statement pulled from an all-GBP account with only
// Interest Accruals enabled (no Cash Transactions) and a Trades section
// present but empty for the (very short) date range — the exact situation
// that originally produced an unhelpfully generic "no rows found" message.
const SPARSE_STATEMENT = `<?xml version="1.0"?>
<FlexQueryResponse queryName="Sparse" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U9999999" fromDate="20260708" toDate="20260708" period="LastBusinessDay">
<Trades>
</Trades>
<InterestAccruals>
<InterestAccrualsCurrency currency="BASE_SUMMARY" fromDate="20260708" toDate="20260708" interestAccrued="8.23" />
</InterestAccruals>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>`;

/* -------------------------------- shapeFlexPull ------------------------------- */

test("shapeFlexPull: end-to-end XML -> shaped trades, matching the CSV importer's shape exactly", () => {
  const raw = rawFromXml(SAMPLE_STATEMENT);
  const r = shapeFlexPull(raw, { defaultWrapper: "GIA", baseCurrency: "GBP" });
  // 2 STK trades pass through; the CASH pseudo-trade (FX conversion, not a
  // real security) is filtered out by the same asset-class check the CSV
  // path already applies.
  assert.equal(r.trades.length, 2);
  assert.equal(r.format, "flex");

  const buy = r.trades.find((t) => t.side === "BUY");
  assert.equal(buy.ticker, "WFC");
  assert.equal(buy.date, "2025-03-15");
  assert.equal(buy.quantity, 50);
  assert.equal(buy.nativeCurrency, "USD");
  assert.equal(buy.nativeAmount, 2262.5);
  assert.equal(buy.fxRate, 0.7854);
  assert.equal(buy.gbpAmount, Math.round(2262.5 * 0.7854 * 100) / 100);
  assert.equal(buy.wrapper, "GIA");
  assert.equal(buy.needsFx, false);

  const sell = r.trades.find((t) => t.side === "SELL");
  assert.equal(sell.quantity, 20);
  assert.equal(sell.nativeAmount, 999);
});

test("shapeFlexPull: a live pull carries IBKR's own tradeID/transactionID through as the hidden ibkrId field", () => {
  const raw = rawFromXml(SAMPLE_STATEMENT);
  const r = shapeFlexPull(raw);
  const buy = r.trades.find((t) => t.side === "BUY");
  assert.equal(buy.ibkrId, "1001"); // tradeID="1001" on that <Trade> in SAMPLE_STATEMENT
  const div = r.income.find((i) => i.kind === "dividend");
  assert.equal(div.ibkrId, null); // SAMPLE_STATEMENT's CashTransaction rows carry no transactionID — null, not fabricated
});

test("shapeFlexPull: cash transactions become dividend/interest income, withholding tax rows are dropped", () => {
  const raw = rawFromXml(SAMPLE_STATEMENT);
  const r = shapeFlexPull(raw);
  assert.equal(r.income.length, 2); // Withholding Tax row excluded entirely
  const div = r.income.find((i) => i.kind === "dividend");
  assert.equal(div.ticker, "WFC");
  assert.equal(div.date, "2025-06-01");
  assert.equal(div.amount, Math.round(35 * 0.785 * 100) / 100);
  const interest = r.income.find((i) => i.kind === "interest");
  assert.equal(interest.nativeCurrency, "GBP");
  assert.equal(interest.amount, 12.34); // already GBP, no conversion needed
});

test("shapeFlexPull: respects a non-GIA wrapper override, same as the pasted-CSV path", () => {
  const raw = rawFromXml(SAMPLE_STATEMENT);
  const r = shapeFlexPull(raw, { defaultWrapper: "ISA" });
  assert.ok(r.trades.every((t) => t.wrapper === "ISA"));
  assert.ok(r.income.every((i) => i.wrapper === "ISA"));
});

test("shapeFlexPull: truly empty pull (no sections at all) produces a helpful warning", () => {
  const r = shapeFlexPull({ trades: [], cashTransactions: [], interestAccruals: [] });
  assert.equal(r.trades.length, 0);
  assert.equal(r.income.length, 0);
  assert.ok(r.warnings.some((w) => /no Trade, Cash Transaction, or Interest Accrual rows/i.test(w)));
});

test("shapeFlexPull: missing raw entirely doesn't throw", () => {
  const r = shapeFlexPull();
  assert.deepEqual(r.trades, []);
  assert.deepEqual(r.income, []);
});

/* --------------------- real-world sparse statement (bug repro) ---------------- */

test("shapeFlexPull: Interest Accruals (no Cash Transactions) still produces an income row", () => {
  const raw = rawFromXml(SPARSE_STATEMENT);
  const r = shapeFlexPull(raw);
  assert.equal(r.income.length, 1);
  const i = r.income[0];
  assert.equal(i.kind, "interest");
  assert.equal(i.date, "2026-07-08");
  assert.equal(i.nativeCurrency, "GBP");
  assert.equal(i.amount, 8.23);
  assert.equal(i.needsFx, false);
});

test("shapeFlexPull: flags Interest Accruals present without Cash Transactions (dividends won't come through)", () => {
  const raw = rawFromXml(SPARSE_STATEMENT);
  const r = shapeFlexPull(raw);
  assert.ok(r.warnings.some((w) => /Interest Accruals but not Cash Transactions/i.test(w)));
});

test("shapeFlexPull: an empty Trades section over a single-day range explains the date range, not just 'no rows'", () => {
  const raw = { ...rawFromXml(SPARSE_STATEMENT), fromDate: "20260708", toDate: "20260708", period: "LastBusinessDay" };
  const r = shapeFlexPull(raw);
  assert.ok(r.warnings.some((w) => /only covers 2026-07-08/.test(w) && /widen the Flex Query's date range/i.test(w)));
});

test("shapeInterestAccruals via shapeFlexPull: BASE_SUMMARY is ignored when real per-currency rows exist (no double count)", () => {
  const raw = {
    trades: [], cashTransactions: [],
    interestAccruals: [
      { currency: "usd", fromdate: "20260701", todate: "20260708", interestaccrued: "5.00" },
      { currency: "base_summary", fromdate: "20260701", todate: "20260708", interestaccrued: "9.10" },
    ],
  };
  const r = shapeFlexPull(raw);
  assert.equal(r.income.length, 1);
  assert.equal(r.income[0].nativeCurrency, "USD");
  assert.equal(r.income[0].needsFx, true); // non-GBP, no fxRateToBase on this section
});

test("shapeInterestAccruals via shapeFlexPull: zero accrual for the period is skipped, not recorded as a zero row", () => {
  const raw = { trades: [], cashTransactions: [], interestAccruals: [{ currency: "BASE_SUMMARY", todate: "20260708", interestaccrued: "0" }] };
  const r = shapeFlexPull(raw);
  assert.equal(r.income.length, 0);
});

/* ------------------------------- shapeCashReport ------------------------------ */

test("shapeCashReport: filters out the synthetic BASE_SUMMARY row", () => {
  const raw = rawFromXml(SAMPLE_STATEMENT);
  const rows = shapeCashReport(raw);
  assert.equal(rows.length, 2);
  assert.ok(!rows.some((r) => r.currency === "BASE_SUMMARY"));
  const usd = rows.find((r) => r.currency === "USD");
  assert.equal(usd.endingCash, 500.25);
});

test("shapeCashReport: missing raw entirely doesn't throw", () => {
  assert.deepEqual(shapeCashReport(), []);
});
