import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Papa from "papaparse";
import {
  parseMoney, parsePensionDate, classifyPensionType, guessPensionColumns, mapPensionRow,
} from "../core/pension-import.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Synthetic fixtures — same header conventions, date formats, amount
// formatting, and row-type mix (Switch/Phasing/Adjustment/Regular
// Contribution) as the two real provider exports this parser was built
// against, but with fabricated dates/amounts so no personal financial data
// ships with the repo.
const citiCsv = readFileSync(join(__dirname, "pension-citi-fixture.csv"), "utf8");
const avivaCsv = readFileSync(join(__dirname, "pension-aviva-fixture.csv"), "utf8");

test("parseMoney handles £, commas, blanks, and negatives", () => {
  assert.equal(parseMoney("£2,345.67"), 2345.67);
  assert.equal(parseMoney("999.99"), 999.99);
  assert.equal(parseMoney(""), null);
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney("£0.00"), 0);
  assert.equal(parseMoney("-£95.87"), -95.87);
  assert.equal(parseMoney("(95.87)"), -95.87);
});

test("parsePensionDate normalises both DD/MM/YYYY and YYYY-MM-DD to ISO", () => {
  assert.equal(parsePensionDate("30/11/2022"), "2022-11-30");
  assert.equal(parsePensionDate("2023-01-06"), "2023-01-06");
  assert.equal(parsePensionDate("not a date"), null);
  assert.equal(parsePensionDate(""), null);
});

test("classifyPensionType treats any 'Switch' label as a switch, everything else as a contribution", () => {
  assert.equal(classifyPensionType("Switch"), "switch");
  assert.equal(classifyPensionType("Regular Contribution"), "contribution");
  assert.equal(classifyPensionType("Employer Contribution"), "contribution");
  assert.equal(classifyPensionType("Adjustment"), "contribution");
  assert.equal(classifyPensionType("Phasing"), "contribution");
  assert.equal(classifyPensionType("Some Future Label"), "contribution"); // unrecognised but real -> keep, don't drop
});

test("guessPensionColumns finds both the Citi and Aviva header naming conventions", () => {
  const citiFields = Papa.parse(citiCsv.trim(), { header: true, skipEmptyLines: true }).meta.fields;
  const avivaFields = Papa.parse(avivaCsv.trim(), { header: true, skipEmptyLines: true }).meta.fields;
  const c = guessPensionColumns(citiFields);
  assert.deepEqual(c, { date: "Effective Date", type: "Transaction Type", currency: "Transaction Currency", amount: "Amount" });
  const a = guessPensionColumns(avivaFields);
  assert.deepEqual(a, { date: "Date", type: "Type", currency: "Currency", amount: "Amount" });
});

test("mapPensionRow: Citi-style fixture — switches, zero-amount Phasing/Switch rows excluded, contributions and a nonzero Adjustment kept", () => {
  const res = Papa.parse(citiCsv.trim(), { header: true, skipEmptyLines: true });
  const colMap = guessPensionColumns(res.meta.fields);
  const mapped = res.data.map((r) => mapPensionRow(r, colMap, "L&G (Citi)")).filter(Boolean);
  // fixture has: 2 Switch (blank/zero amount), 1 Phasing (£0.00),
  // 5 Regular Contribution, 1 Adjustment (£50.25) -> 6 usable rows
  assert.equal(mapped.length, 6);
  assert.ok(mapped.every((m) => m.provider === "L&G (Citi)"));
  assert.ok(mapped.every((m) => m.nativeAmount > 0));
  const feb2025 = mapped.find((m) => m.date === "2025-02-28");
  assert.equal(feb2025.nativeAmount, 1234.56);
  const adjustment = mapped.find((m) => m.type === "Adjustment");
  assert.equal(adjustment.nativeAmount, 50.25);
});

test("mapPensionRow: Aviva-style fixture — all 4 rows are genuine contributions", () => {
  const res = Papa.parse(avivaCsv.trim(), { header: true, skipEmptyLines: true });
  const colMap = guessPensionColumns(res.meta.fields);
  const mapped = res.data.map((r) => mapPensionRow(r, colMap, "Aviva (Wells Fargo)")).filter(Boolean);
  assert.equal(mapped.length, 4);
  assert.equal(mapped[0].date, "2023-02-10");
  assert.equal(mapped[0].nativeAmount, 600.00);
  assert.equal(mapped[3].date, "2026-06-01");
});

test("mapPensionRow returns null for a genuine switch row (no cashflow)", () => {
  const row = { "Effective Date": "15/03/2026", "Transaction Type": "Switch", "Transaction Currency": "", "Amount": "" };
  const colMap = { date: "Effective Date", type: "Transaction Type", currency: "Transaction Currency", amount: "Amount" };
  assert.equal(mapPensionRow(row, colMap, "L&G (Citi)"), null);
});

test("mapPensionRow returns null for a zero-amount row regardless of type label (Phasing, Switch)", () => {
  const colMap = { date: "Effective Date", type: "Transaction Type", currency: "Transaction Currency", amount: "Amount" };
  assert.equal(mapPensionRow({ "Effective Date": "27/10/2023", "Transaction Type": "Phasing", "Transaction Currency": "GBP", "Amount": "£0.00" }, colMap, "L&G (Citi)"), null);
  assert.equal(mapPensionRow({ "Effective Date": "18/10/2023", "Transaction Type": "Switch", "Transaction Currency": "GBP", "Amount": "£0.00" }, colMap, "L&G (Citi)"), null);
});
