import { test } from "node:test";
import assert from "node:assert/strict";
import { currencyExposure } from "../core/currency-exposure.mjs";
import { suggestBudgetsFromHistory } from "../core/budget.mjs";

const pos = (ticker, currency, marketValue) => ({ ticker, currency, marketValue, priced: true });

test("splits the balance sheet by quote currency, folding pence into sterling", () => {
  // GBp is sterling — treating it as a separate currency would split one
  // exposure across two rows and understate the GBP share.
  const e = currencyExposure({
    positions: [pos("VOD", "GBp", 40000), pos("VWRL", "GBP", 10000), pos("WFC", "USD", 30000), pos("SAP", "EUR", 20000)],
  });
  assert.equal(e.total, 100000);
  const byCcy = Object.fromEntries(e.byQuote.map((r) => [r.currency, r.weight]));
  assert.equal(byCcy.GBP, 0.5, "40k pence-quoted + 10k GBP");
  assert.equal(byCcy.USD, 0.3);
  assert.equal(byCcy.EUR, 0.2);
  assert.equal(e.nonGbpQuoteShare, 0.5);
});

test("a GBP-quoted world tracker's real exposure comes from a look-through override", () => {
  // The headline risk this exists for: quote currency says GBP, the assets
  // inside are mostly dollars.
  const e = currencyExposure({
    positions: [pos("VWRL", "GBP", 100000)],
    secMeta: { VWRL: { fxExposure: { USD: 0.6, EUR: 0.2, GBP: 0.2 } } },
  });
  assert.equal(e.nonGbpQuoteShare, 0, "by quote currency it looks entirely sterling");
  assert.equal(e.nonGbpUnderlyingShare, 0.8, "in reality 80% sits in foreign currency");
  const u = Object.fromEntries(e.byUnderlying.map((r) => [r.currency, r.value]));
  assert.equal(u.USD, 60000);
  assert.equal(u.GBP, 20000);
  assert.equal(e.lookThroughCoverage, 1);
});

test("look-through coverage is reported, so the underlying view can't masquerade as authoritative", () => {
  const e = currencyExposure({
    positions: [pos("KNOWN", "GBP", 50000), pos("GUESSED", "GBP", 50000)],
    secMeta: { KNOWN: { fxExposure: "USD" } },
  });
  assert.equal(e.lookThroughCoverage, 0.5, "only half has real look-through data");
  // The half without an override falls back to its quote currency rather
  // than being dropped or guessed.
  const u = Object.fromEntries(e.byUnderlying.map((r) => [r.currency, r.value]));
  assert.equal(u.USD, 50000);
  assert.equal(u.GBP, 50000);
});

test("cash and property count — this is a balance-sheet question, not a portfolio one", () => {
  const e = currencyExposure({
    positions: [pos("WFC", "USD", 50000)],
    extras: [{ label: "Cash", value: 30000, currency: "GBP" }, { label: "Flat", value: 20000 }],
  });
  assert.equal(e.total, 100000);
  assert.equal(e.nonGbpQuoteShare, 0.5, "extras default to sterling");
});

test("unpriced holdings are counted and excluded rather than valued at zero", () => {
  const e = currencyExposure({
    positions: [pos("A", "USD", 100), { ticker: "B", currency: "USD", marketValue: null, priced: false }],
  });
  assert.equal(e.unpricedCount, 1);
  assert.equal(e.total, 100);
});

test("empty input is safe", () => {
  const e = currencyExposure({});
  assert.equal(e.total, 0);
  assert.deepEqual(e.byQuote, []);
  assert.equal(e.nonGbpQuoteShare, 0);
});

/* ------------------------- budgets from history ------------------------ */

const CATS = [
  { id: "gro", name: "Groceries", monthly: 400, essential: true },
  { id: "fun", name: "Eating out", monthly: 100 },
  { id: "ins", name: "Car insurance", annual: 600, essential: true },
  { id: "new", name: "Never used", monthly: 50 },
  { id: "xfer", name: "Card payment", transfer: true },
];

test("proposes limits from what you actually spend, not from optimism", () => {
  const txns = [];
  for (let i = 0; i < 12; i++) {
    const m = `2026-${String(i + 1).padStart(2, "0")}`;
    txns.push({ id: `g${i}`, date: `${m}-05`, amount: 600, categoryId: "gro" });   // budgeted 400, really 600
    txns.push({ id: `f${i}`, date: `${m}-06`, amount: 80, categoryId: "fun" });
  }
  const s = suggestBudgetsFromHistory({ categories: CATS, txns, toMonth: "2026-12" });
  const byId = Object.fromEntries(s.rows.map((r) => [r.id, r]));

  assert.equal(byId.gro.suggested, 600, "monthly categories proposed as a monthly figure");
  assert.equal(byId.gro.suggestedAnnual, 7200);
  assert.equal(byId.gro.delta, 2400, "the budget was £2,400/yr too low");
  assert.equal(byId.fun.suggested, 80);
  assert.equal(s.reliable, true);
  assert.equal(s.monthsOfHistory, 12);

  // No history is not the same as "spend nothing".
  assert.equal(byId.new.suggested, null);
  assert.equal(byId.new.hasHistory, false);
  // Transfers are never budgeted.
  assert.ok(!byId.xfer);
});

test("annual-only categories keep an annual figure, and uplift is opt-in", () => {
  const txns = [{ id: "i1", date: "2026-03-01", amount: 720, categoryId: "ins" }];
  for (let i = 0; i < 12; i++) txns.push({ id: `g${i}`, date: `2026-${String(i + 1).padStart(2, "0")}-05`, amount: 100, categoryId: "gro" });

  const plain = suggestBudgetsFromHistory({ categories: CATS, txns, toMonth: "2026-12" });
  const ins = plain.rows.find((r) => r.id === "ins");
  assert.equal(ins.annualOnly, true);
  assert.equal(ins.suggested, 720, "annual-only stays annual");

  const padded = suggestBudgetsFromHistory({ categories: CATS, txns, toMonth: "2026-12", uplift: 10 });
  assert.equal(padded.rows.find((r) => r.id === "ins").suggested, 792, "10% headroom when asked for");
});

test("too little history is flagged as unreliable rather than silently trusted", () => {
  const txns = [{ id: "g1", date: "2026-12-05", amount: 600, categoryId: "gro" }];
  const s = suggestBudgetsFromHistory({ categories: CATS, txns, toMonth: "2026-12" });
  assert.equal(s.reliable, false, "one month is noise, not a pattern");
  assert.equal(s.monthsOfHistory, 1);
});
