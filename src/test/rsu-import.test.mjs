import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Papa from "papaparse";
import {
  parseUkDate, parseQty, guessTickerFromFilename, mapRsuCsvRow, buildRsuImport,
  detectRsuCsvFormat, mapRsuScheduleRow, buildRsuScheduleImport, buildRsuReleaseImport,
} from "../core/rsu-import.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Synthetic fixtures matching the real Wells Fargo/Shareworks export shapes
// these parsers were built against (same headers, UK date format, comma
// thousands, decimal share counts, BOM prefix, and the real-file quirks
// documented alongside each builder below) — fabricated numbers, no
// personal financial data ships with the repo.
const unitsCsv = readFileSync(join(__dirname, "rsu-units-fixture.csv"), "utf8");
const awardsCsv = readFileSync(join(__dirname, "rsu-awards-fixture.csv"), "utf8");
const scheduleCsv = readFileSync(join(__dirname, "rsu-schedule-fixture.csv"), "utf8");
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

/* ------------------------------ detectRsuCsvFormat ------------------------------ */

test("detectRsuCsvFormat: recognises the release-history and vesting-schedule shapes", () => {
  assert.equal(detectRsuCsvFormat(parseRows(unitsCsv)), "release");
  assert.equal(detectRsuCsvFormat(parseRows(awardsCsv)), "release");
  assert.equal(detectRsuCsvFormat(parseRows(scheduleCsv)), "schedule");
});

test("detectRsuCsvFormat: unrecognised or empty input returns null rather than guessing", () => {
  assert.equal(detectRsuCsvFormat([]), null);
  assert.equal(detectRsuCsvFormat([{ "Some Other Column": "x" }]), null);
  assert.equal(detectRsuCsvFormat(null), null);
});

/* ------------------------------ mapRsuScheduleRow ------------------------------ */

test("mapRsuScheduleRow: maps an Award row, carrying the raw Grant Date through as-is", () => {
  const row = { "Plan Description": "1/10/2023 RSU Award", "Contribution type": "Award", "Grant Date": "10 Jan 2023", "Available from": "15 Jan 2027", "Quantity": "100.00000", "Estimated value": "5000.00" };
  const r = mapRsuScheduleRow(row);
  assert.deepEqual(r, { planLabel: "1/10/2023 RSU Award", contributionType: "Award", grantDateRaw: "2023-01-10", vestDate: "2027-01-15", quantity: 100, estimatedValueGBP: 5000 });
});

test("mapRsuScheduleRow: 4-letter month abbreviations (e.g. 'Sept') still parse", () => {
  const row = { "Plan Description": "X", "Contribution type": "Notional dividend", "Grant Date": "1 Sept 2025", "Available from": "20 Jan 2028", "Quantity": "0.3", "Estimated value": "15" };
  assert.equal(mapRsuScheduleRow(row).grantDateRaw, "2025-09-01");
});

test("mapRsuScheduleRow: missing plan label, available-from date, or quantity -> null", () => {
  assert.equal(mapRsuScheduleRow({ "Contribution type": "Award", "Available from": "15 Jan 2027", "Quantity": "100" }), null);
  assert.equal(mapRsuScheduleRow({ "Plan Description": "X", "Contribution type": "Award", "Quantity": "100" }), null);
  assert.equal(mapRsuScheduleRow({ "Plan Description": "X", "Contribution type": "Award", "Available from": "15 Jan 2027" }), null);
});

/* ------------------------------ buildRsuScheduleImport ------------------------------ */

test("buildRsuScheduleImport: resolves the true grant date from a plan's Award row, not its Notional dividend rows", () => {
  const rows = parseRows(scheduleCsv);
  const r = buildRsuScheduleImport(rows, { ticker: "wfc" });
  const g = r.grants.find((g) => g.note === "1/10/2023 RSU Award");
  assert.equal(g.grantDate, "2023-01-10"); // from the Award row, NOT "2026-06-01" off the dividend row
  assert.equal(g.ticker, "WFC");
});

test("buildRsuScheduleImport: multiple Award tranches under one plan label share one grant, each its own vest event", () => {
  const rows = parseRows(scheduleCsv);
  const r = buildRsuScheduleImport(rows, { ticker: "WFC" });
  const grants = r.grants.filter((g) => g.note === "1/15/2024 Stock Award");
  assert.equal(grants.length, 1); // one grant...
  const vests = r.events.filter((e) => e.grantKey === grants[0].key);
  assert.equal(vests.length, 3); // ...two Award tranches + one Notional dividend, all under it
  assert.deepEqual(vests.map((e) => e.date).sort(), ["2027-01-20", "2028-01-20", "2028-01-20"].sort());
});

test("buildRsuScheduleImport: every vest event uses the real 'Available from' date, not the grant date", () => {
  const rows = parseRows(scheduleCsv);
  const r = buildRsuScheduleImport(rows, { ticker: "WFC" });
  const firstGrantEvents = r.events.filter((e) => e.grantKey.startsWith("1/10/2023 RSU Award"));
  assert.ok(firstGrantEvents.every((e) => e.date === "2027-01-15")); // "Available from", not "2023-01-10"
});

test("buildRsuScheduleImport: no fabricated price — priceNative/fxRate stay null, estimated value is only a note", () => {
  const rows = parseRows(scheduleCsv);
  const r = buildRsuScheduleImport(rows, { ticker: "WFC" });
  assert.ok(r.events.every((e) => e.priceNative === null && e.fxRate === null));
  assert.ok(r.events.some((e) => /estimated value £5000/i.test(e.note)));
});

test("buildRsuScheduleImport: a plan with only Notional dividend rows (no Award row) falls back to its own date and warns", () => {
  const rows = parseRows(scheduleCsv);
  const r = buildRsuScheduleImport(rows, { ticker: "WFC" });
  const g = r.grants.find((g) => g.note === "Orphan Dividend Plan");
  assert.equal(g.grantDate, "2026-03-01"); // best-effort: the row's own (dividend) date
  assert.ok(r.warnings.some((w) => /couldn't be confirmed from an "Award" row/i.test(w)));
});

test("buildRsuScheduleImport: warns that estimated values are report-date projections, not actual vest-date FMV", () => {
  const rows = parseRows(scheduleCsv);
  const r = buildRsuScheduleImport(rows, { ticker: "WFC" });
  assert.ok(r.warnings.some((w) => /not the actual FMV at vest/i.test(w)));
});

test("buildRsuScheduleImport: empty input doesn't throw", () => {
  const r = buildRsuScheduleImport([], { ticker: "WFC" });
  assert.deepEqual(r.grants, []);
  assert.deepEqual(r.events, []);
});

/* ------------------------------ dispatcher (buildRsuImport) ------------------------------ */

test("buildRsuImport: auto-detects the vesting-schedule format and delegates to buildRsuScheduleImport", () => {
  const rows = parseRows(scheduleCsv);
  const r = buildRsuImport(rows, { ticker: "WFC" });
  const g = r.grants.find((g) => g.note === "1/10/2023 RSU Award");
  assert.equal(g.grantDate, "2023-01-10");
  assert.ok(r.events.every((e) => e.priceNative === null));
});

test("buildRsuImport: still auto-detects the release-history format exactly as before (dispatcher is a no-op regression)", () => {
  const rows = parseRows(unitsCsv);
  const viaDispatcher = buildRsuImport(rows, { ticker: "WFC" });
  const direct = buildRsuReleaseImport(rows, { ticker: "WFC" });
  assert.deepEqual(viaDispatcher, direct);
});

test("buildRsuImport: unrecognised header set falls back to the release parser, which reports everything skipped rather than throwing", () => {
  const r = buildRsuImport([{ "Some Other Column": "x" }], { ticker: "WFC" });
  assert.deepEqual(r.grants, []);
  assert.ok(r.warnings.some((w) => /1 row\(s\) skipped/i.test(w)));
});
