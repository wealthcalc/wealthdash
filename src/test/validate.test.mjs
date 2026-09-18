import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFields, req, pos, nonNeg, numberish, isoDate, isoDateOpt, oneOf, notBefore, errorMessages } from "../core/validate.mjs";

test("a valid draft passes with no errors", () => {
  const r = validateFields(
    { ticker: "TG36", date: "2026-09-02", quantity: "10000", fees: "" },
    { ticker: [req("Ticker")], date: [isoDate("Date")], quantity: [pos("Quantity")], fees: [nonNeg("Fees")] },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, {});
  assert.equal(r.first, null);
});

test("every failing field gets its own message — silence was the whole problem", () => {
  const r = validateFields(
    { ticker: "", date: "2026", quantity: "0" },
    { ticker: [req("Ticker")], date: [isoDate("Date")], quantity: [pos("Quantity")] },
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.ticker, /required/);
  assert.match(r.errors.date, /full date/);
  assert.match(r.errors.quantity, /more than 0/);
  assert.equal(r.first, r.errors.ticker, "the first message is the one to put focus on");
});

test("a blank number says 'required', not 'isn't a number'", () => {
  // That's what the user did; telling them their nothing isn't numeric is
  // technically true and practically rude.
  assert.match(pos("Quantity")(""), /required/);
  assert.match(pos("Quantity")("abc"), /isn't a number/);
  assert.match(pos("Quantity")("-3"), /more than 0/);
  assert.equal(pos("Quantity")("0.0001"), null);
});

test("rules stop at the first failure per field", () => {
  const r = validateFields({ q: "" }, { q: [req("Q"), pos("Q")] });
  assert.equal(r.errors.q, "Q is required.");
});

test("optional numeric fields accept blank but reject nonsense", () => {
  assert.equal(nonNeg("Fees")(""), null);
  assert.equal(nonNeg("Fees")("0"), null);
  assert.match(nonNeg("Fees")("-1"), /negative/);
  assert.equal(numberish("Coupon")(""), null);
  assert.match(numberish("Coupon")("4¼"), /4\.25/, "and says what to type instead");
});

test("dates: required vs optional, and cross-field ordering", () => {
  assert.match(isoDate("Date")(""), /required/);
  assert.equal(isoDateOpt("Valued on")(""), null);
  assert.match(isoDateOpt("Valued on")("yesterday"), /full date/);
  const later = notBefore("End", "start", "the start date");
  assert.equal(later("2026-02-01", { start: "2026-01-01" }), null);
  assert.match(later("2025-12-01", { start: "2026-01-01" }), /can't be before/);
  assert.equal(later("", { start: "2026-01-01" }), null, "blank is someone else's rule");
});

test("oneOf and the message summary", () => {
  assert.match(oneOf("Side", ["BUY", "SELL"])("HOLD"), /one of BUY, SELL/);
  const r = validateFields({ a: "", b: "" }, { a: [req("A")], b: [req("A")] });
  assert.deepEqual(errorMessages(r.errors), ["A is required."], "identical messages are not repeated");
});

test("empty inputs are safe", () => {
  assert.equal(validateFields().ok, true);
  assert.equal(validateFields({}, {}).ok, true);
  assert.deepEqual(errorMessages(), []);
});
