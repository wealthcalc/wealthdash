import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMonthsISO, findHeaderRow, guessColumnMap, extractISharesRows, parseISharesWorkbook,
} from "../core/ishares-eri.mjs";

/* ---------------------------- addMonthsISO ---------------------------- */

test("addMonthsISO: plain shift and month-end clamping", () => {
  assert.equal(addMonthsISO("2024-06-30", 6), "2024-12-30");
  assert.equal(addMonthsISO("2025-08-31", 6), "2026-02-28"); // clamp to Feb
  assert.equal(addMonthsISO("2023-08-31", 6), "2024-02-29"); // leap-year Feb
  assert.equal(addMonthsISO("", 6), "");
});

/* --------------------------- header detection ------------------------- */

// A realistic umbrella sheet: two preamble rows, then the header.
const HEADER = [
  "Fund Umbrella Name", "Fund Name", "Share Class Name", "ISIN",
  "Reporting Period", "Currency",
  "Statement Under Regulation 92(1)(e)",
  "Excess of Reported Income per Unit", "Fund Distribution Date",
  "Meets definition of a Bond Fund for the period",
];
const sheet = (rows) => [
  ["iShares plc", "", "", "", "", "", "", "", "", ""],
  ["UK Reportable Income", "", "", "", "", "", "", "", "", ""],
  HEADER,
  ...rows,
];

test("findHeaderRow scores the ISIN-bearing row above preamble", () => {
  assert.equal(findHeaderRow(sheet([])), 2);
  assert.equal(findHeaderRow([["just", "two"], ["cells", "here"]]), -1);
});

test("guessColumnMap resolves keyword-based columns wherever they sit", () => {
  const m = guessColumnMap(HEADER);
  assert.equal(m.isin, 3);
  assert.equal(m.fundName, 1);
  assert.equal(m.reportingPeriod, 4);
  assert.equal(m.currency, 5);
  assert.equal(m.eriPerUnit, 7);
  assert.equal(m.distributionDate, 8);
  assert.equal(m.bondFund, 9);
});

test("guessColumnMap ignores the Regulation statement column for ERI", () => {
  const m = guessColumnMap(HEADER);
  assert.notEqual(m.eriPerUnit, 6);
});

/* ---------------------------- row extraction --------------------------- */

const ROW = (isin, eri, opts = {}) => [
  "iShares plc", opts.fund ?? "iShares Core S&P 500", "Acc", isin,
  opts.period ?? "01 July 2024 to 30 June 2025", opts.ccy ?? "USD",
  "statement text", eri, opts.dist ?? "31 December 2025", opts.bond ?? "No",
];

test("extracts a dividend-treatment row with dates normalised to ISO", () => {
  const aoa = sheet([ROW("IE00B5BMR087", 0.1234)]);
  const rows = extractISharesRows(aoa, 2, guessColumnMap(HEADER), null);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.isin, "IE00B5BMR087");
  assert.equal(r.perShare, 0.1234);
  assert.equal(r.periodEnd, "2025-06-30");       // end of the text range
  assert.equal(r.distributionDate, "2025-12-31");
  assert.equal(r.treatment, "dividend");
});

test("bond-fund 'Yes' flips treatment to interest", () => {
  const aoa = sheet([ROW("IE00B5BMR087", 0.5, { bond: "Yes" })]);
  const [r] = extractISharesRows(aoa, 2, guessColumnMap(HEADER), null);
  assert.equal(r.treatment, "interest");
});

test("zero, blank, and non-numeric ERI rows are dropped", () => {
  const aoa = sheet([
    ROW("IE00B5BMR087", 0),
    ROW("IE00BKM4GZ66", ""),
    ROW("IE00B4L5Y983", "n/a"),
    ROW("IE00B53SZB19", "1,234.5"), // comma-formatted still parses
  ]);
  const rows = extractISharesRows(aoa, 2, guessColumnMap(HEADER), null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].perShare, 1234.5);
});

test("holdingIsins filter keeps only the ISINs actually held", () => {
  const aoa = sheet([ROW("IE00B5BMR087", 0.1), ROW("IE00BKM4GZ66", 0.2)]);
  const rows = extractISharesRows(aoa, 2, guessColumnMap(HEADER), new Set(["IE00BKM4GZ66"]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isin, "IE00BKM4GZ66");
});

test("rows without a valid ISIN are skipped", () => {
  const aoa = sheet([ROW("NOT-AN-ISIN", 0.1)]);
  assert.equal(extractISharesRows(aoa, 2, guessColumnMap(HEADER), null).length, 0);
});

test("date variants: dd/mm/yyyy, dotted, Excel serial, missing distribution", () => {
  const aoa = sheet([
    ROW("IE00B5BMR087", 0.1, { period: "01/03/2020 to 28/02/2021", dist: "31/08/2021" }),
    ROW("IE00BKM4GZ66", 0.1, { period: "01.12.2024 to 30.11.2025", dist: 45992 }), // serial = 2025-12-01
    ROW("IE00B4L5Y983", 0.1, { dist: "" }), // falls back to period end + 6 months
  ]);
  const rows = extractISharesRows(aoa, 2, guessColumnMap(HEADER), null);
  assert.equal(rows[0].periodEnd, "2021-02-28");
  assert.equal(rows[0].distributionDate, "2021-08-31");
  assert.equal(rows[1].periodEnd, "2025-11-30");
  assert.equal(rows[1].distributionDate, "2025-12-01");
  assert.equal(rows[2].distributionDate, "2025-12-30"); // 2025-06-30 + 6 months
});

test("GBX / GBP PENCE currencies normalise to GBp", () => {
  const aoa = sheet([ROW("IE00B5BMR087", 0.1, { ccy: "GBX" }), ROW("IE00BKM4GZ66", 0.1, { ccy: "GBP PENCE" })]);
  const rows = extractISharesRows(aoa, 2, guessColumnMap(HEADER), null);
  assert.equal(rows[0].currency, "GBp");
  assert.equal(rows[1].currency, "GBp");
});

/* ------------------------------ workbook ------------------------------ */

test("parseISharesWorkbook: per-sheet results, headerless sheets flagged", () => {
  const out = parseISharesWorkbook([
    { name: "2025", aoa: sheet([ROW("IE00B5BMR087", 0.25)]) },
    { name: "Notes", aoa: [["free text"], ["no header here"]] },
  ], null);
  assert.equal(out[0].rows.length, 1);
  assert.equal(out[0].headerRowIdx, 2);
  assert.equal(out[1].headerRowIdx, -1);
  assert.deepEqual(out[1].rows, []);
});
