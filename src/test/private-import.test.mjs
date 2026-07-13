import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInvestmentCsv, parseDistributionPaste, reconcileImportRows } from "../core/private-import.mjs";

// A slice of the real JamJar export — note every line is deliberately
// duplicated (two genuine identical same-day contributions), which the
// parser must PRESERVE, not collapse.
const JAMJAR_CSV = `Date,Transaction,Amount,Shares,Share Price,Type
2026-06-09,Investment,309.61,,,"Fund"
2026-06-09,Investment,309.61,,,"Fund"
2022-06-20,Investment,125.00,,,"Fund"
2022-06-20,Investment,125.00,,,"Fund"`;

const PASSION_CSV = `Date,Transaction,Amount,Shares,Share Price,Type
2025-03-20,Investment,222.41,,,"Fund"
2022-03-09,Extinguish,11.46,,,
2021-04-27,Investment,900.00,,,"Fund"`;

test("parseInvestmentCsv: Investment -> call, header skipped, genuine duplicates preserved", () => {
  const { rows, skipped } = parseInvestmentCsv(JAMJAR_CSV);
  assert.equal(rows.length, 4);                 // both copies of both dates kept
  assert.equal(skipped.length, 0);
  assert.ok(rows.every((r) => r.type === "call"));
  assert.deepEqual(rows.map((r) => r.amount), [309.61, 309.61, 125, 125]);
  assert.deepEqual(rows.map((r) => r.date), ["2026-06-09", "2026-06-09", "2022-06-20", "2022-06-20"]);
});

test("parseInvestmentCsv: Extinguish maps to a capital distribution (return of capital)", () => {
  const { rows } = parseInvestmentCsv(PASSION_CSV);
  assert.equal(rows.length, 3);
  const ext = rows.find((r) => r.transaction === "Extinguish");
  assert.equal(ext.type, "distribution_capital");
  assert.equal(ext.amount, 11.46);
  assert.equal(ext.date, "2022-03-09");
  // the two Investment rows are calls
  assert.equal(rows.filter((r) => r.type === "call").length, 2);
});

test("parseInvestmentCsv: unrecognised transaction words and bad rows are skipped, not coerced", () => {
  const { rows, skipped } = parseInvestmentCsv(
    "2024-01-01,Investment,100,,,\n2024-02-02,Redemption,50,,,\nnot-a-date,Investment,10,,,\n2024-03-03,Investment,,,,"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 100);
  assert.equal(skipped.length, 3); // Redemption (unrecognised), bad date, missing amount
});

test("parseDistributionPaste: pulls net/gross/units/per-unit from the receipt block", () => {
  const receipt = `Distribution Summary
JamJar Ventures II LP
Total units held
535,140.1336284636825709
Returns per unit
£0.0004286167
Gross return
£229.37
Net return
£229.37`;
  const out = parseDistributionPaste(receipt);
  assert.equal(out.fund, "JamJar Ventures II LP");
  assert.equal(out.net, 229.37);
  assert.equal(out.gross, 229.37);
  assert.equal(out.amount, 229.37);          // net preferred
  assert.equal(out.returnPerUnit, 0.0004286167);
  assert.ok(Math.abs(out.unitsHeld - 535140.1336) < 1e-3);
});

test("parseDistributionPaste: same-line 'label: value' layout also parses", () => {
  const out = parseDistributionPaste("Distribution Summary\nAcme Fund\nNet return: £1,250.00");
  assert.equal(out.amount, 1250);
  assert.equal(out.fund, "Acme Fund");
});

test("parseDistributionPaste: no amount present is a clean error, not a throw", () => {
  const out = parseDistributionPaste("Distribution Summary\nAcme Fund\nTotal units held\n100");
  assert.ok(out.error);
});

test("reconcileImportRows: genuine in-file duplicates land on first import, but a re-import is idempotent", () => {
  const key = (r) => `${r.date}|${r.type}|${r.amount.toFixed(2)}`;
  const rows = parseInvestmentCsv(JAMJAR_CSV).rows;
  // first import into an empty ledger — nothing skipped, both pairs kept
  const first = reconcileImportRows(rows, [], key);
  assert.equal(first.rows.length, 4);
  assert.equal(first.skipped, 0);
  // simulate them now being in the ledger, then re-paste the same file
  const existing = first.rows;
  const second = reconcileImportRows(rows, existing, key);
  assert.equal(second.rows.length, 0);
  assert.equal(second.skipped, 4);
  // a genuinely new third identical contribution still gets through
  const third = reconcileImportRows(
    [...rows, { date: "2026-06-09", type: "call", amount: 309.61 }], existing, key
  );
  assert.equal(third.rows.length, 1);
  assert.equal(third.rows[0].date, "2026-06-09");
});
