import { test } from "node:test";
import assert from "node:assert/strict";
import { totalCreditCardDebt } from "../core/credit-cards.mjs";

test("totalCreditCardDebt: sums balances across multiple cards", () => {
  const cards = [{ id: "1", label: "Amex", balance: 500 }, { id: "2", label: "Visa", balance: 1250.5 }];
  assert.equal(totalCreditCardDebt(cards), 1750.5);
});

test("totalCreditCardDebt: empty/missing input is 0, not a crash", () => {
  assert.equal(totalCreditCardDebt([]), 0);
  assert.equal(totalCreditCardDebt(), 0);
});

test("totalCreditCardDebt: ignores a negative balance rather than adding it as a credit (never reduces total debt below what's owed elsewhere)", () => {
  assert.equal(totalCreditCardDebt([{ balance: -50 }, { balance: 200 }]), 200);
});

test("totalCreditCardDebt: non-numeric balance treated as 0, not fabricated or thrown on", () => {
  assert.equal(totalCreditCardDebt([{ balance: "" }, { balance: undefined }, { balance: 100 }]), 100);
});
