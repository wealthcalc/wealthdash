import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStatementDate, parseAmount, detectColumns, detectSign,
  parseStatement, dedupeStatement, statementKey,
} from "../core/statement-import.mjs";

test("UK dates: DD/MM never MM/DD — the silent-corruption case", () => {
  assert.equal(parseStatementDate("04/03/2026"), "2026-03-04"); // 4 March, NOT 3 April
  assert.equal(parseStatementDate("25/12/26"), "2026-12-25");
  assert.equal(parseStatementDate("2026-03-04"), "2026-03-04");
  assert.equal(parseStatementDate("04 Mar 2026"), "2026-03-04");
  assert.equal(parseStatementDate("garbage"), null);
  assert.equal(parseStatementDate(""), null);
});

test("amounts: currency symbols, parens, CR/DR suffixes", () => {
  assert.equal(parseAmount("£1,234.56"), 1234.56);
  assert.equal(parseAmount("-42.10"), -42.1);
  assert.equal(parseAmount("(42.10)"), -42.1);
  assert.equal(parseAmount("42.10 CR"), -42.1);
  assert.equal(parseAmount("42.10 DR"), 42.1);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("n/a"), null);
});

test("Amex shape: header present, spend POSITIVE, stays positive", () => {
  const csv = [
    "Date,Description,Amount",
    "04/03/2026,TESCO STORES 3155,42.10",
    "05/03/2026,PRET A MANGER 4471,4.85",
    "06/03/2026,PAYMENT RECEIVED - THANK YOU,-500.00",
  ].join("\n");
  const { rows, meta, warnings } = parseStatement(csv, { profile: "amex" });
  assert.equal(rows.length, 3);
  assert.equal(meta.signConvention, "spend-positive");
  assert.equal(rows[0].amount, 42.1);    // spend positive
  assert.equal(rows[2].amount, -500);    // card payment negative
  assert.equal(rows[0].account, "Amex");
  assert.equal(rows[0].description, "TESCO STORES 3155");
  assert.deepEqual(meta.dateRange, ["2026-03-04", "2026-03-06"]);
  assert.equal(warnings.length, 0);
});

test("HSBC shape: NO header, spend negative in file → flipped to positive", () => {
  const csv = [
    "04/03/2026,TESCO STORES 3155,-42.10",
    "05/03/2026,SALARY,2500.00",
    "06/03/2026,BRITISH GAS,-88.00",
  ].join("\n");
  const { rows, meta } = parseStatement(csv, { profile: "hsbc" });
  assert.equal(rows.length, 3);
  assert.equal(meta.columns.hasHeader, false);
  assert.equal(rows[0].amount, 42.1);   // spending normalised POSITIVE
  assert.equal(rows[1].amount, -2500);  // salary is money in → negative
  assert.equal(rows[0].account, "HSBC");
});

test("auto profile detects the convention from the balance of signs", () => {
  assert.equal(detectSign([-10, -20, -30, 500]).convention, "spend-negative");
  assert.equal(detectSign([-10, -20, -30, 500]).confident, true);
  assert.equal(detectSign([10, 20, 30, -500]).convention, "spend-positive");
  // a genuinely ambiguous file is flagged, not guessed at confidently
  assert.equal(detectSign([10, -20]).confident, false);
  assert.equal(detectSign([]).confident, false);

  const csv = "Date,Description,Amount\n04/03/2026,TESCO,-42.10\n05/03/2026,SHELL,-30.00\n06/03/2026,BOOTS,-12.00\n07/03/2026,SALARY,2000.00";
  const { rows, meta } = parseStatement(csv, { profile: "auto", account: "Current" });
  assert.equal(meta.signConvention, "spend-negative");
  assert.equal(rows[0].amount, 42.1);
  assert.equal(rows[0].account, "Current");
});

test("ambiguous sign is WARNED about rather than silently decided", () => {
  const csv = "Date,Description,Amount\n04/03/2026,A,-42.10\n05/03/2026,B,30.00";
  const { warnings } = parseStatement(csv, { profile: "auto" });
  assert.match(warnings.join(" "), /confidently/);
});

test("split debit/credit columns", () => {
  const csv = [
    "Date,Description,Debit,Credit",
    "04/03/2026,TESCO,42.10,",
    "05/03/2026,REFUND,,15.00",
  ].join("\n");
  const { rows } = parseStatement(csv, { profile: "amex" });
  assert.equal(rows[0].amount, 42.1);
  assert.equal(rows[1].amount, -15);  // credit column → money in
});

test("detectColumns finds columns by header text and by position", () => {
  const withHeader = detectColumns([["Transaction Date", "Narrative", "Amount"], ["04/03/2026", "X", "1.00"]]);
  assert.equal(withHeader.hasHeader, true);
  assert.equal(withHeader.date, 0);
  assert.equal(withHeader.desc, 1);
  assert.equal(withHeader.amount, 2);
  // headerless: the date column is found by parsing, description by width
  const headerless = detectColumns([["04/03/2026", "TESCO STORES LONDON", "-42.10"]]);
  assert.equal(headerless.hasHeader, false);
  assert.equal(headerless.date, 0);
  assert.equal(headerless.desc, 1);
  assert.equal(headerless.amount, 2);
});

test("junk rows are skipped and reported, not silently dropped", () => {
  const csv = [
    "Your statement for account 1234",
    "",
    "Date,Description,Amount",
    "04/03/2026,TESCO,42.10",
    "Closing balance,,1234.00",
  ].join("\n");
  const { rows, warnings } = parseStatement(csv, { profile: "amex" });
  assert.equal(rows.length, 1);
  assert.match(warnings.join(" "), /skipped/);
});

test("unreadable files fail loudly with a useful message", () => {
  const r = parseStatement("just some text\nwith no columns", { profile: "auto" });
  assert.equal(r.rows.length, 0);
  assert.ok(r.warnings[0].length > 20);
  assert.equal(parseStatement("").rows.length, 0);
});

test("dedupe makes overlapping re-downloads safe", () => {
  const a = { date: "2026-03-04", description: "TESCO STORES 3155", amount: 42.1, account: "Amex" };
  const b = { date: "2026-03-05", description: "PRET", amount: 4.85, account: "Amex" };
  const { rows, duplicates } = dedupeStatement([a, b], [a]);
  assert.equal(rows.length, 1);
  assert.equal(duplicates.length, 1);
  // whitespace/case differences in the description don't defeat it
  assert.equal(
    statementKey({ ...a, description: "tesco   stores 3155" }),
    statementKey(a)
  );
  // but a different amount is a different transaction (two identical-looking
  // coffees on the same day are genuinely two transactions... this is the
  // known limit: same-day, same-merchant, same-amount pairs collapse.)
  assert.notEqual(statementKey({ ...a, amount: 42.11 }), statementKey(a));
});
