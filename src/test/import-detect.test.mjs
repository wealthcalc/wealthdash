import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectImportFormat, findHeaderLine, headerSignature, saveProfile, matchProfile, deleteProfile } from "../core/import-detect.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("IBKR Flex CSV is recognised by its own column names", () => {
  const csv = "Symbol,ISIN,TradeDate,Buy/Sell,Quantity,TradePrice,Proceeds,IBCommission,CurrencyPrimary,FXRateToBase,AssetClass\nAAPL,US0378331005,20240115,BUY,10,180,-1800,-1,USD,0.79,STK";
  const r = detectImportFormat(csv);
  assert.equal(r.kind, "ibkr");
  assert.ok(r.confidence >= 0.9);
});

test("IBKR Activity Statement (sectioned rows) is recognised without a header line", () => {
  const csv = "Statement,Header,Field Name,Field Value\nStatement,Data,BrokerName,Interactive Brokers\nTrades,Header,DataDiscriminator,Asset Category,Currency,Symbol\nTrades,Data,Order,Stocks,USD,AAPL";
  assert.equal(detectImportFormat(csv).kind, "ibkr");
});

test("the real Fidelity export fixture is recognised despite its metadata preamble", () => {
  const csv = readFileSync(join(__dirname, "fidelity-fixture.csv"), "utf8");
  const r = detectImportFormat(csv);
  assert.equal(r.kind, "fidelity", r.reason);
  assert.ok(r.headerIndex > 0, "the header wasn't on line 0 — the preamble was skipped");
});

test("Shareworks RSU exports are recognised by the columns the RSU parser keys on", () => {
  assert.equal(detectImportFormat("Grant Date,Allocation quantity,Release Date,Price\n2024-01-01,100,2025-01-01,50").kind, "rsu");
  assert.equal(detectImportFormat("Grant Date,Available from,Contribution type,Quantity\n2024-01-01,2025-01-01,RSU,100").kind, "rsu");
});

test("a bank statement is dated rows with a description and no instrument", () => {
  const amex = "Date,Description,Amount\n01/09/2026,TESCO STORES 1234,42.10\n02/09/2026,TFL TRAVEL,7.20";
  const r = detectImportFormat(amex);
  assert.equal(r.kind, "statement");
  assert.match(r.reason, /Budget/);
});

test("a holdings snapshot is instrument + quantity with no side", () => {
  const fidelityValuation = "Investment,ISIN,Quantity,Price,Value\nBankers Investment Trust,GB00BN4NDR39,5187,1.19,6172.53";
  const r = detectImportFormat(fidelityValuation);
  assert.equal(r.kind, "positions", r.reason);
  const hl = "Stock,Units held,Price (pence),Value (£)\nScottish Mortgage,2280,1050,23940";
  assert.equal(detectImportFormat(hl).kind, "positions");
});

test("a dividend list and a generic trade list are told apart", () => {
  assert.equal(detectImportFormat("Date,Symbol,Type,Currency,Amount\n2025-06-15,CSP1,Dividend,USD,42.10").kind, "dividends");
  assert.equal(detectImportFormat("Date,Symbol,Action,Quantity,Currency,Amount,FXRate\n2025-06-02,WFC,SELL,200,USD,18718,0.78").kind, "trades");
});

test("an Excel file is a workbook by extension; nonsense is unknown, not guessed", () => {
  assert.equal(detectImportFormat("", { filename: "iShares-ERI-2025.xlsx" }).kind, "workbook");
  const r = detectImportFormat("hello\nworld\n");
  assert.equal(r.kind, "unknown");
  assert.equal(detectImportFormat("Colour,Shape,Mood\nred,round,fine").kind, "unknown");
});

test("findHeaderLine skips numeric preambles and quoted commas", () => {
  const f = findHeaderLine('Account ,All Accounts\nTimeframe,Last 30 days\n"Order date","Completion date","Transaction type","Investments"\n2026-01-01,...');
  assert.equal(f.index, 2);
  assert.deepEqual(f.cells.slice(0, 2), ["Order date", "Completion date"]);
  assert.equal(findHeaderLine(""), null);
});

/* --------------------------- mapping profiles ------------------------- */

test("a saved profile is recognised again by header signature, exactly or by fit", () => {
  const headers = ["Trade Date", "Stock", "Deal type", "Units", "Consideration"];
  const map = { date: "Trade Date", ticker: "Stock", side: "Deal type", quantity: "Units", gbpAmount: "Consideration" };
  let profiles = saveProfile({}, { name: "AJ Bell", kind: "trades", headers, map });
  assert.ok(profiles["AJ Bell"].signature);

  const exact = matchProfile(profiles, ["Consideration", "Units", "Deal type", "Stock", "Trade Date"], "trades");
  assert.equal(exact.exact, true, "order doesn't matter");
  assert.equal(exact.profile.name, "AJ Bell");

  const wider = matchProfile(profiles, [...headers, "Settlement Date", "Reference"], "trades");
  assert.equal(wider.exact, false, "a wider export of the same shape still fits");
  assert.equal(wider.profile.name, "AJ Bell");

  assert.equal(matchProfile(profiles, ["Date", "Symbol"], "trades"), null, "missing mapped columns don't fit");
  assert.equal(matchProfile(profiles, headers, "dividends"), null, "kind is respected");
  assert.equal(headerSignature(["b", "A "]), "a|b");
  profiles = deleteProfile(profiles, "AJ Bell");
  assert.deepEqual(profiles, {});
  assert.throws(() => saveProfile({}, { name: " ", headers, map }), /name/);
});
