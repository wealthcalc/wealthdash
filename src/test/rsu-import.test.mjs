import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Papa from "papaparse";
import { parseUkDate, parseQty, guessTickerFromFilename, mapRsuCsvRow, buildRsuImport } from "../core/rsu-import.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Synthetic fixtures matching the real Wells Fargo/Shareworks export shape
// this parser was built against (same headers, UK date format, comma
// thousands, decimal share counts, BOM prefix, and the "one plan label
// reused across multiple grant dates" / "one grant date reused across
// multiple plan labels" quirks that make the grouping key need both
// fields) — fabricated numbers, no personal financial data ships with the repo.
const unitsCsv = readFileSync(join(__dirname, "rsu-units-fixture.csv"), "utf8");
const awardsCsv = readFileSync(join(__dirname, "rsu-awards-fixture.csv"), "utf8");
const parseRows = (csv) => Papa.parse(csv.trim(), { header: true, skipEmptyLines: true }).data;

/* -------------------------------- parseUkDate -------------------------------- */

test("parseUkDate: 'DD Mon YYYY' -> ISO", () => {
  assert.equal(parseUkDate("11 Jan 2023"), "2023-01-11");
  assert.equal(parseUkDate("1 Dec 2025"), "2025-12-01");
  assert.equal(parseUkDate("27 January 2026".replace("January", "Jan")), "2026-01-27");
});

test("parseUkDate: already-ISO passes through, garbage returns null", () => {
  assert.equal(parseUkDate("2025-01-28"), "2025-01-28");
  assert.equal(parseUkDate("not a date"), null);
  assert.equal(parseUkDate(""), null);
  assert.equal(parseUkDate(null), null);
});

/* --------------------------------- parseQty ----------------------------------- */

test("parseQty: strips thousands commas, keeps decimals, rejects junk", () => {
  assert.equal(parseQty("1,549"), 1549);
  assert.equal(parseQty("161.00000"), 161);
  assert.equal(parseQty("30.08"), 30.08);
  assert.equal(parseQty(""), null);
  assert.equal(parseQty(null), null);
  assert.equal(parseQty("n/a"), null);
});

/* --------------------------- guessTickerFromFilename --------------------------- */

test("guessTickerFromFilename: pulls the all-caps token before the exchange parenthesis", () => {
  assert.equal(guessTickerFromFilename("restricted stock units-Wells Fargo WFC (NYS).csv"), "WFC");
  assert.equal(guessTickerFromFilename("restricted stock awards-Wells Fargo WFC (NYS).csv"), "WFC");
});

test("guessTickerFromFilename: no match -> empty string, never throws", () => {
  assert.equal(guessTickerFromFilename("export.csv"), "");
  assert.equal(guessTickerFromFilename(""), "");
  assert.equal(guessTickerFromFilename(null), "");
});

/* -------------------------------- mapRsuCsvRow --------------------------------- */

test("mapRsuCsvRow: maps a well-formed row, deriving netQty from allocation - taxCover when absent", () => {
  const row = { "Plan Description": "1/10/2022 RSU Award", "Grant Date": "10 Jan 2022", "Allocation quantity": "200", "Quantity to cover tax": "80.00000", "Net quantity": "120.00000" };
  const r = mapRsuCsvRow(row);
  assert.deepEqual(r, { planLabel: "1/10/2022 RSU Award", grantDate: "2022-01-10", allocation: 200, taxCover: 80, netQty: 120 });
});

test("mapRsuCsvRow: accepts 'Plan' as well as 'Plan Description' (the two real file variants)", () => {
  const row = { "Plan": "Long Term Incentive Plan 2022", "Grant Date": "28 Jan 2024", "Allocation quantity": "500", "Quantity to cover tax": "200", "Net quantity": "300" };
  assert.equal(mapRsuCsvRow(row).planLabel, "Long Term Incentive Plan 2022");
});

test("mapRsuCsvRow: missing plan label, grant date, or allocation -> null, not a fabricated row", () => {
  assert.equal(mapRsuCsvRow({ "Grant Date": "10 Jan 2022", "Allocation quantity": "200" }), null);
  assert.equal(mapRsuCsvRow({ "Plan Description": "X", "Allocation quantity": "200" }), null);
  assert.equal(mapRsuCsvRow({ "Plan Description": "X", "Grant Date": "10 Jan 2022" }), null);
});

/* -------------------------------- buildRsuImport -------------------------------- */

test("buildRsuImport: groups rows by plan label + grant date (both fields needed) into one grant each", () => {
  const rows = parseRows(unitsCsv);
  const r = buildRsuImport(rows, { ticker: "wfc" });
  // 3 CSV rows -> 2 distinct grants: two "1/10/2022 RSU Award" rows share a
  // grant, the "1/15/2023 Stock Award" row is its own grant.
  assert.equal(r.grants.length, 2);
  assert.ok(r.grants.every((g) => g.ticker === "WFC")); // ticker uppercased
  const jan2022 = r.grants.find((g) => g.grantDate === "2022-01-10");
  assert.equal(jan2022.note, "1/10/2022 RSU Award");
});

test("buildRsuImport: a plan label reused across different grant dates stays two separate grants", () => {
  const rows = parseRows(awardsCsv);
  const r = buildRsuImport(rows, { ticker: "WFC" });
  assert.equal(r.grants.length, 2);
  assert.equal(new Set(r.grants.map((g) => g.note)).size, 1); // same label...
  assert.deepEqual(r.grants.map((g) => g.grantDate).sort(), ["2024-01-28", "2025-01-27"]); // ...different dates
});

test("buildRsuImport: each row becomes a vest event for the gross allocation, plus a same-date sale for tax-cover shares", () => {
  const rows = parseRows(unitsCsv);
  const r = buildRsuImport(rows, { ticker: "WFC" });
  const vests = r.events.filter((e) => e.type === "vest");
  const sales = r.events.filter((e) => e.type === "sale");
  assert.equal(vests.length, 3); // one per CSV row
  assert.equal(sales.length, 3); // every row here has a nonzero tax-cover
  const bigVest = vests.find((e) => e.shares === 1000);
  assert.equal(bigVest.date, "2023-01-15");
  const matchingSale = sales.find((e) => e.grantKey === bigVest.grantKey);
  assert.equal(matchingSale.shares, 400);
  assert.equal(matchingSale.date, bigVest.date);
});

test("buildRsuImport: vest/sale events carry no fabricated price — priceNative/fxRate stay null", () => {
  const rows = parseRows(unitsCsv);
  const r = buildRsuImport(rows, { ticker: "WFC" });
  assert.ok(r.events.every((e) => e.priceNative === null && e.fxRate === null));
});

test("buildRsuImport: warns when no ticker is supplied", () => {
  const rows = parseRows(unitsCsv);
  const r = buildRsuImport(rows, { ticker: "" });
  assert.ok(r.warnings.some((w) => /no ticker/i.test(w)));
});

test("buildRsuImport: warns that vest dates default to the grant date (no per-tranche date in this export)", () => {
  const rows = parseRows(unitsCsv);
  const r = buildRsuImport(rows, { ticker: "WFC" });
  assert.ok(r.warnings.some((w) => /doesn't include a per-tranche vest date/i.test(w)));
});

test("buildRsuImport: warns with the total tax-withheld share count across all rows", () => {
  const rows = parseRows(unitsCsv);
  const r = buildRsuImport(rows, { ticker: "WFC" });
  // 80 + 20.5 + 400 = 500.5
  assert.ok(r.warnings.some((w) => /500\.5.*withheld to cover tax/i.test(w)));
});

test("buildRsuImport: skips unparseable rows and reports how many", () => {
  const rows = [...parseRows(unitsCsv), { "Plan Description": "", "Grant Date": "", "Allocation quantity": "" }];
  const r = buildRsuImport(rows, { ticker: "WFC" });
  assert.ok(r.warnings.some((w) => /1 row\(s\) skipped/i.test(w)));
});

test("buildRsuImport: empty input doesn't throw and produces no grants/events", () => {
  const r = buildRsuImport([], { ticker: "WFC" });
  assert.deepEqual(r.grants, []);
  assert.deepEqual(r.events, []);
});
