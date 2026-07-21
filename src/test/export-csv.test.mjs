import { test } from "node:test";
import assert from "node:assert/strict";
import { csvField, toCsv, ledgerCsv, incomeCsv, taxSummaryText } from "../core/export-csv.mjs";

test("csvField escapes commas, quotes and newlines per RFC 4180", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("line1\nline2"), '"line1\nline2"');
  assert.equal(csvField(null), "");
  assert.equal(csvField(42), "42");
});

test("csvField defangs spreadsheet formula injection", () => {
  // A merchant literally named "=cmd..." must not become a live formula.
  assert.equal(csvField("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvField("+44 supplier"), "'+44 supplier");
  assert.equal(csvField("-5 refund"), "'-5 refund");
  assert.equal(csvField("@handle"), "'@handle");
});

test("toCsv joins with CRLF and escapes every field", () => {
  const out = toCsv([["a", "b"], ["c,d", "e"]]);
  assert.equal(out, 'a,b\r\n"c,d",e');
});

test("ledgerCsv: fixed columns, sorted by date, no leaking of extra keys", () => {
  const csv = ledgerCsv([
    { date: "2026-02-01", side: "SELL", ticker: "VWRL", wrapper: "GIA", quantity: 10, gbpAmount: 1200, secretInternalField: "nope" },
    { date: "2026-01-01", side: "BUY", ticker: "VWRL", wrapper: "GIA", quantity: 50, gbpAmount: 5000, fees: 5, nativeCurrency: "GBP", account: "IBKR" },
  ]);
  const lines = csv.split("\r\n");
  assert.match(lines[0], /^Date,Side,Ticker,Wrapper,Quantity,GBP amount,Fees,Native ccy,Account$/);
  // sorted: the January BUY comes before the February SELL
  assert.match(lines[1], /^2026-01-01,BUY/);
  assert.match(lines[2], /^2026-02-01,SELL/);
  // the internal field never appears
  assert.ok(!csv.includes("nope"));
});

test("incomeCsv lays out dividends/interest", () => {
  const csv = incomeCsv([{ date: "2026-03-01", kind: "dividend", ticker: "VWRL", wrapper: "GIA", amount: 120 }]);
  assert.match(csv.split("\r\n")[0], /^Date,Type,Ticker,Wrapper,Amount/);
  assert.match(csv, /2026-03-01,dividend,VWRL,GIA,120/);
});

test("taxSummaryText renders both sections, or says there's nothing", () => {
  const full = taxSummaryText({
    taxYear: "2025/26", generatedOn: "2026-07-20",
    cgt: { proceeds: 50000, gains: 8000, losses: 1000, netGain: 7000, allowance: 3000, taxable: 4000, disposals: 6 },
    income: { dividends: 2000, interest: 500, dividendTax: 150, interestTax: 0 },
  });
  assert.match(full, /UK TAX SUMMARY — 2025\/26/);
  assert.match(full, /Taxable gain:\s+£4,000/);
  assert.match(full, /Dividends:\s+£2,000/);
  assert.match(full, /not tax advice/);

  const empty = taxSummaryText({ taxYear: "2025/26" });
  assert.match(empty, /No taxable CGT or investment income/);
});
