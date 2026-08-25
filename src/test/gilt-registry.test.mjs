import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateGiltRegistration, unregisterGiltMeta, giltRegistryDiagnostics,
  shapeGiltCatalogue, searchGiltCatalogue, buildGiltTrade, isGiltMeta,
} from "../core/gilt-registry.mjs";
import { giltAnalytics } from "../core/gilts.mjs";

const TG30 = { ticker: "TG30", name: "0⅜% Treasury Gilt 2030", coupon: "0.375", maturity: "2030-10-22", isin: "GB00BMBL1D50" };

/* --------------------------- form validation -------------------------- */

test("a complete form registers, and what it produces is what giltAnalytics accepts", () => {
  // The contract that actually matters: the form's output must satisfy the
  // engine's own isGiltMeta gate, or registration "succeeds" and the tab
  // still shows nothing.
  const r = validateGiltRegistration(TG30, { secMeta: {} });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.ticker, "TG30");
  assert.equal(r.value.patch.coupon, 0.375, "coupon is stored as a number, not the typed string");
  assert.equal(r.value.patch.kind, "gilt");
  assert.ok(isGiltMeta(r.value.patch));

  const analytics = giltAnalytics({
    txns: [{ date: "2026-08-20", ticker: "TG30", side: "BUY", quantity: 20000, wrapper: "GIA" }],
    secMeta: { TG30: r.value.patch }, prices: { TG30: 0.84 }, asOf: "2026-08-25",
  });
  assert.equal(analytics.holdings.length, 1, "the registration reaches the ladder");
  assert.equal(analytics.holdings[0].nominal, 20000);
});

test("a BLANK coupon is rejected, not silently registered as 0%", () => {
  // The original bug: `+"" === 0` is finite, so an empty coupon passed
  // validation and produced a gilt whose every projected cashflow was zero.
  const r = validateGiltRegistration({ ...TG30, coupon: "" }, { secMeta: {} });
  assert.equal(r.ok, false);
  assert.match(r.errors.coupon, /Required/);
  assert.equal(r.value, null);
});

test("each bad field gets its own message instead of the form doing nothing", () => {
  const r = validateGiltRegistration({ ticker: "", coupon: "4¼", maturity: "2030", isin: "NOTANISIN" }, { secMeta: {} });
  assert.equal(r.ok, false);
  assert.ok(r.errors.ticker && r.errors.coupon && r.errors.maturity && r.errors.isin,
    "silence was the whole problem — every failure has to name itself");
  assert.match(r.errors.coupon, /4\.25/, "and says what to type instead");
});

test("a coupon typed as a price, or with a % sign, is caught", () => {
  assert.match(validateGiltRegistration({ ...TG30, coupon: "0.375%" }, {}).errors.coupon, /isn't a number/);
  assert.match(validateGiltRegistration({ ...TG30, coupon: "98.4" }, {}).errors.coupon, /outside any coupon/);
});

test("re-registering the same ticker is refused; editing it is not", () => {
  const secMeta = { TG30: { kind: "gilt", coupon: 0.375, maturity: "2030-10-22" } };
  assert.match(validateGiltRegistration(TG30, { secMeta }).errors.ticker, /already registered/);
  assert.equal(validateGiltRegistration(TG30, { secMeta, editing: "TG30" }).ok, true);
});

test("one ISIN on two tickers is refused at the point of entry", () => {
  // Two tickers for one stock splits the holding in half, and neither side
  // looks wrong on its own.
  const secMeta = { TR30: { isin: "GB00BMBL1D50", name: "same gilt, other name" } };
  const r = validateGiltRegistration(TG30, { secMeta });
  assert.equal(r.ok, false);
  assert.match(r.errors.isin, /already on TR30/);
});

test("registering preserves an existing ISIN and merges rather than replacing", () => {
  const secMeta = { TG30: { isin: "GB00BMBL1D50", name: "kept", someOtherFlag: true } };
  const r = validateGiltRegistration({ ...TG30, isin: "", name: "" }, { secMeta, editing: "TG30" });
  assert.equal(r.value.patch.isin, "GB00BMBL1D50", "a blank ISIN field doesn't erase the stored one");
  assert.equal(r.value.patch.someOtherFlag, true, "unrelated metadata survives");
  assert.equal(r.value.patch.name, "TG30", "an empty name falls back to the ticker");
});

test("un-registering removes only the gilt fields", () => {
  const m = unregisterGiltMeta({ kind: "gilt", coupon: 4, maturity: "2030-01-01", isin: "GB00BMBL1D50", name: "keep me" });
  assert.equal(m.kind, undefined);
  assert.equal(m.coupon, undefined);
  assert.equal(m.isin, "GB00BMBL1D50", "the ticker stays a known security everywhere else");
  assert.equal(m.name, "keep me");
});

/* ------------------------ ledger-side diagnostics --------------------- */

test("registered but never bought: the ladder is empty for a reason it can state", () => {
  const d = giltRegistryDiagnostics({
    txns: [{ date: "2026-01-01", ticker: "VWRL", side: "BUY", quantity: 10 }],
    secMeta: { TG30: { kind: "gilt", coupon: 0.375, maturity: "2030-10-22", name: "0⅜% Treasury Gilt 2030" } },
  });
  assert.deepEqual(d.registeredUnheld.map((r) => r.ticker), ["TG30"]);
  assert.equal(d.unregistered.length, 0);
  assert.equal(d.clean, false);
});

test("bought but never registered: the gilt is sitting in the ledger as an ordinary share", () => {
  const d = giltRegistryDiagnostics({
    txns: [
      { date: "2026-08-20", ticker: "TG30", side: "BUY", quantity: 20000 },
      { date: "2026-08-21", ticker: "TG30", side: "SELL", quantity: 5000 },
      { date: "2026-01-01", ticker: "VWRL", side: "BUY", quantity: 10 },
    ],
    secMeta: {},
  });
  assert.equal(d.unregistered.length, 1, "VWRL doesn't look like a gilt and isn't flagged");
  assert.equal(d.unregistered[0].ticker, "TG30");
  assert.equal(d.unregistered[0].qty, 15000, "net nominal, so a part-sold line still reads correctly");
  assert.equal(d.unregistered[0].reason, "ticker");
});

test("a gilt named as one is flagged even when the ticker gives nothing away", () => {
  const d = giltRegistryDiagnostics({
    txns: [{ date: "2026-08-20", ticker: "XYZ", side: "BUY", quantity: 5000 }],
    secMeta: { XYZ: { name: "4¼% Treasury Gilt 2032" } },
  });
  assert.equal(d.unregistered[0].reason, "name");
});

test("the invisible one: the same ISIN registered under one ticker and HELD under another", () => {
  // Broker imports map by ISIN, so the stock can already be in the ledger as
  // TR30 when the user registers TG30. Both halves look healthy; the tab is
  // empty; no error on either form could catch it. ISIN is the only thing
  // the two sides share.
  const d = giltRegistryDiagnostics({
    txns: [{ date: "2026-08-20", ticker: "TR30", side: "BUY", quantity: 20000 }],
    secMeta: {
      TG30: { kind: "gilt", coupon: 0.375, maturity: "2030-10-22", isin: "GB00BMBL1D50" },
      TR30: { isin: "GB00BMBL1D50", name: "broker's name for it" },
    },
  });
  assert.equal(d.isinConflicts.length, 1);
  assert.deepEqual(
    { ...d.isinConflicts[0] },
    { isin: "GB00BMBL1D50", registeredAs: "TG30", heldAs: "TR30", qty: 20000 }
  );
});

test("an ISIN duplicated on a ticker that isn't actually held is not raised", () => {
  // Stale metadata from an old import isn't a problem worth a warning.
  const d = giltRegistryDiagnostics({
    txns: [],
    secMeta: {
      TG30: { kind: "gilt", coupon: 0.375, maturity: "2030-10-22", isin: "GB00BMBL1D50" },
      TR30: { isin: "GB00BMBL1D50" },
    },
  });
  assert.equal(d.isinConflicts.length, 0);
});

test("a healthy setup says so, so the UI can stay quiet", () => {
  const d = giltRegistryDiagnostics({
    txns: [{ date: "2026-08-20", ticker: "TG30", side: "BUY", quantity: 20000 }],
    secMeta: { TG30: { kind: "gilt", coupon: 0.375, maturity: "2030-10-22", isin: "GB00BMBL1D50" } },
  });
  assert.equal(d.clean, true);
  assert.equal(d.registeredCount, 1);
});

test("empty inputs are safe", () => {
  const d = giltRegistryDiagnostics({});
  assert.equal(d.clean, true);
  assert.deepEqual(d.unregistered, []);
});

/* --------------------------- DMO catalogue ---------------------------- */

// Shaped exactly as api/gilt-prices.mjs returns it: `name` is the part
// AFTER the rate, because the parser reads the rate separately.
const BODY = {
  date: "22/08/2026",
  prices: {
    GB00BMBL1D50: { clean: 84.12, name: "Treasury Gilt 2030", coupon: 0.375, maturity: "2030-10-22", indexLinked: false },
    GB00BNNGP668: { clean: 99.06, name: "Treasury Gilt 2026", coupon: 0.375, maturity: "2026-10-22", indexLinked: false },
    GB00BMF9LJ15: { clean: 95.24, name: "Index - linked Treasury Gilt 2033", coupon: 0.125, maturity: "2033-11-22", indexLinked: true },
    GB00UNREADABLE: { clean: 90, name: "Treasury Gilt 2040", coupon: null, maturity: null },
  },
};

test("the display name is recomposed from the parsed rate and name, not invented", () => {
  const { rows } = shapeGiltCatalogue(BODY);
  const byIsin = Object.fromEntries(rows.map((r) => [r.isin, r]));
  assert.equal(byIsin.GB00BMBL1D50.name, "0.375% Treasury Gilt 2030");
  assert.equal(byIsin.GB00BMF9LJ15.name, "0.125% Index-linked Treasury Gilt 2033", "stray spacing round the hyphen is tidied");
});

test("the catalogue is sorted by maturity and drops anything that would have to be guessed", () => {
  const { rows, date } = shapeGiltCatalogue(BODY);
  assert.equal(date, "22/08/2026");
  assert.deepEqual(rows.map((r) => r.isin), ["GB00BNNGP668", "GB00BMBL1D50", "GB00BMF9LJ15"]);
  assert.ok(!rows.some((r) => r.isin === "GB00UNREADABLE"), "a gilt with no readable coupon is not offered");
});

test("index-linked gilts are shown but marked unsupported, not silently hidden", () => {
  const il = shapeGiltCatalogue(BODY).rows.find((r) => r.indexLinked);
  assert.equal(il.supported, false);
  assert.match(il.unsupportedReason, /fixed coupons/);
  assert.equal(shapeGiltCatalogue(BODY).rows.find((r) => r.isin === "GB00BMBL1D50").supported, true);
});

test("search matches on year, ISIN, coupon or name, and every term must hit", () => {
  const { rows } = shapeGiltCatalogue(BODY);
  assert.equal(searchGiltCatalogue(rows, "2030").length, 1);
  assert.equal(searchGiltCatalogue(rows, "gb00bmbl1d50").length, 1, "case-insensitive ISIN");
  assert.equal(searchGiltCatalogue(rows, "0.375").length, 2);
  assert.equal(searchGiltCatalogue(rows, "0.375 2030").length, 1, "terms narrow, they don't widen");
  assert.equal(searchGiltCatalogue(rows, "").length, 3);
  assert.equal(searchGiltCatalogue(rows, "index").length, 1);
});

test("an empty or malformed body doesn't throw", () => {
  assert.deepEqual(shapeGiltCatalogue({}).rows, []);
  assert.deepEqual(shapeGiltCatalogue().rows, []);
  assert.deepEqual(searchGiltCatalogue(undefined, "x"), []);
});

/* ---------------------------- gilt trade row -------------------------- */

test("a gilt purchase is entered in contract-note units and converted once", () => {
  // £20,000 nominal at 84.12 per £100 = £16,824 — the 100x that makes this
  // worth a dedicated builder rather than free-typing into the ledger.
  const r = buildGiltTrade({ ticker: "tg30", date: "2026-08-20", nominal: 20000, clean100: 84.12, fees: 5.95, wrapper: "gia" });
  assert.equal(r.ok, true);
  assert.equal(r.consideration, 16824);
  assert.equal(r.row.ticker, "TG30");
  assert.equal(r.row.wrapper, "GIA");
  assert.equal(r.row.quantity, 20000, "quantity is £ nominal, matching the gilt engine's unit convention");
  assert.equal(r.row.gbpAmount, 16829.95, "fees are in cost, accrued interest is not");
  assert.equal(r.row.nativeCurrency, "GBP");
  assert.equal(r.row.fxRate, 1);
});

test("the row it builds is one the gilt engine actually reads back", () => {
  const { row } = buildGiltTrade({ ticker: "TG30", date: "2026-08-20", nominal: 20000, clean100: 84.12 });
  const a = giltAnalytics({
    txns: [row],
    secMeta: { TG30: { kind: "gilt", coupon: 0.375, maturity: "2030-10-22" } },
    prices: { TG30: 0.8412 }, asOf: "2026-08-25",
  });
  assert.equal(a.holdings[0].nominal, 20000);
  assert.equal(a.holdings[0].wrapper, "GIA");
});

test("cash paid typed where nominal belongs is caught by the price sanity bound", () => {
  const r = buildGiltTrade({ ticker: "TG30", date: "2026-08-20", nominal: 20000, clean100: 16824 });
  assert.equal(r.ok, false);
  assert.match(r.errors.clean100, /per £100/);
});

test("a sale is supported and the missing fields name themselves", () => {
  assert.equal(buildGiltTrade({ ticker: "TG30", date: "2026-08-20", side: "SELL", nominal: 5000, clean100: 84 }).row.side, "SELL");
  const bad = buildGiltTrade({});
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.ticker && bad.errors.date && bad.errors.nominal && bad.errors.clean100);
  assert.equal(bad.row, null);
});
