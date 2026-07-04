import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WRAPPER_META, normWrapper, isWrapperTaxable,
  classifyInstrument, isDisposalTaxable, isIncomeTaxable,
  buildPositions, valuePositions, rollupByWrapper, totalWealth,
  incomeByWrapper, allocation, buildWealthModel,
} from "../core/portfolio.mjs";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const buy = (wrapper, date, ticker, quantity, gbpAmount) =>
  ({ id: wrapper + date + ticker, date, ticker, side: "BUY", quantity, gbpAmount, wrapper });
const sell = (wrapper, date, ticker, quantity, gbpAmount) =>
  ({ id: wrapper + date + ticker + "S", date, ticker, side: "SELL", quantity, gbpAmount, wrapper });

// Instrument metadata: an offshore reporting fund, a UK trust, an individual
// gilt (CGT-exempt), and a gilt FUND (not exempt).
const secMeta = {
  CSP1: { isin: "IE00B5BMR087", name: "iShares Core S&P 500", domicile: "IE", eri: true },
  SMT: { isin: "GB00BLDYK618", name: "Scottish Mortgage", domicile: "GB", eri: false, kind: "investment_trust" },
  TR31: { isin: "GB00BBJNQY21", name: "Treasury 0.25% 2031", domicile: "GB", kind: "gilt" },
  VGOV: { isin: "IE00B42WWV65", name: "Vanguard UK Gilt UCITS ETF", domicile: "IE", kind: "bond_fund" },
};

/* --------------------------- wrapper gating -------------------------- */
test("wrapper taxability matrix", () => {
  assert.equal(WRAPPER_META.GIA.taxable, true);
  assert.equal(WRAPPER_META.ISA.taxable, false);
  assert.equal(WRAPPER_META.SIPP.taxable, false);
  assert.equal(WRAPPER_META.LISA.taxable, false);
  assert.equal(isWrapperTaxable("GIA"), true);
  assert.equal(isWrapperTaxable("ISA"), false);
  assert.equal(isWrapperTaxable(""), true);       // default -> GIA
  assert.equal(isWrapperTaxable("SomethingNew"), true); // unknown -> conservative
  assert.equal(normWrapper("isa"), "ISA");
});

/* ----------------------- instrument classification ------------------ */
test("classifyInstrument: gilt is CGT-exempt with interest income", () => {
  const g = classifyInstrument("TR31", secMeta);
  assert.equal(g.kind, "gilt");
  assert.equal(g.cgtExempt, true);
  assert.equal(g.incomeKind, "interest");
});

test("classifyInstrument: gilt FUND is NOT CGT-exempt", () => {
  const f = classifyInstrument("VGOV", secMeta);
  assert.equal(f.cgtExempt, false);          // only individual gilts are exempt
  assert.equal(f.incomeKind, "interest");    // but a bond fund still pays interest
});

test("classifyInstrument: offshore reporting fund and default equity", () => {
  const rf = classifyInstrument("CSP1", secMeta);
  assert.equal(rf.eri, true);
  assert.equal(rf.cgtExempt, false);
  assert.equal(rf.incomeKind, "dividend");
  const eq = classifyInstrument("UNKNOWN", secMeta);
  assert.equal(eq.kind, "equity");
  assert.equal(eq.cgtExempt, false);
  assert.equal(eq.incomeKind, "dividend");
  assert.equal(eq.name, "UNKNOWN");
});

test("disposal/income tax gating combines wrapper and instrument", () => {
  assert.equal(isDisposalTaxable("GIA", "CSP1", secMeta), true);   // equity in GIA
  assert.equal(isDisposalTaxable("GIA", "TR31", secMeta), false);  // gilt: CGT-exempt
  assert.equal(isDisposalTaxable("ISA", "CSP1", secMeta), false);  // sheltered
  assert.equal(isIncomeTaxable("GIA"), true);
  assert.equal(isIncomeTaxable("SIPP"), false);
});

/* ------------------------------ positions --------------------------- */
test("same ticker in two wrappers -> two independent pools", () => {
  const positions = buildPositions({
    txns: [
      buy("GIA", "2020-01-01", "CSP1", 100, 1000),
      buy("GIA", "2021-01-01", "CSP1", 100, 3000), // GIA pool 200 @ 4000 (avg 20)
      buy("ISA", "2020-01-01", "CSP1", 50, 500),   // ISA pool 50 @ 500 (avg 10)
    ],
    secMeta,
  });
  assert.equal(positions.length, 2);
  const gia = positions.find((p) => p.wrapper === "GIA");
  const isa = positions.find((p) => p.wrapper === "ISA");
  assert.ok(close(gia.qty, 200));
  assert.ok(close(gia.bookCost, 4000));
  assert.ok(close(gia.avgCost, 20));
  assert.ok(close(isa.qty, 50));
  assert.ok(close(isa.avgCost, 10));
});

test("closed positions are dropped from holdings", () => {
  const positions = buildPositions({
    txns: [
      buy("GIA", "2020-01-01", "AAPL", 100, 1000),
      sell("GIA", "2021-01-01", "AAPL", 100, 2000),
    ],
    secMeta,
  });
  assert.equal(positions.length, 0);
});

test("half-entered rows (no GBP amount) don't poison the pool", () => {
  const positions = buildPositions({
    txns: [
      buy("GIA", "2020-01-01", "CSP1", 100, 1000),
      { id: "draft", date: "2021-01-01", ticker: "CSP1", side: "BUY", quantity: 10, gbpAmount: null, wrapper: "GIA" },
    ],
    secMeta,
  });
  assert.equal(positions.length, 1);
  assert.ok(close(positions[0].qty, 100));
  assert.ok(Number.isFinite(positions[0].bookCost));
  assert.ok(close(positions[0].bookCost, 1000));
});

test("ERI cost-uplift flows into the GIA position book cost", () => {
  const eriTxns = [{ id: "e1", ticker: "CSP1", side: "ERI", date: "2020-12-31", quantity: 0, gbpAmount: 40, wrapper: "GIA", _eri: { treatment: "dividend" }, _gbp: 40 }];
  const positions = buildPositions({
    txns: [buy("GIA", "2020-01-01", "CSP1", 100, 1000)],
    eriTxns,
    secMeta,
  });
  assert.ok(close(positions[0].bookCost, 1040));
});

/* ------------------------------ valuation --------------------------- */
test("valuePositions marks unpriced holdings without under-counting", () => {
  const positions = buildPositions({ txns: [buy("GIA", "2020-01-01", "CSP1", 100, 1000)], secMeta });
  const valued = valuePositions(positions, {}); // no price
  assert.equal(valued[0].priced, false);
  assert.equal(valued[0].marketValue, null);
  const valued2 = valuePositions(positions, { CSP1: 25 });
  assert.ok(close(valued2[0].marketValue, 2500));
  assert.ok(close(valued2[0].unrealised, 1500));
  assert.ok(close(valued2[0].unrealisedPct, 1.5));
});

/* ------------------------------ roll-ups ---------------------------- */
test("rollupByWrapper subtotals and unpriced tracking", () => {
  const valued = valuePositions(
    buildPositions({
      txns: [
        buy("GIA", "2020-01-01", "CSP1", 100, 1000),
        buy("GIA", "2020-01-01", "TR31", 1000, 950),
        buy("ISA", "2020-01-01", "CSP1", 50, 500),
      ],
      secMeta,
    }),
    { CSP1: 25, TR31: 1.0 }, // ISA CSP1 shares the CSP1 price; nothing unpriced here
  );
  const by = rollupByWrapper(valued, { GIA: 200 });
  assert.ok(close(by.GIA.marketValue, 100 * 25 + 1000 * 1.0)); // 3500
  assert.ok(close(by.GIA.cash, 200));
  assert.ok(close(by.GIA.total, 3700));
  assert.ok(close(by.GIA.unrealised, (2500 - 1000) + (1000 - 950))); // 1550
  assert.equal(by.GIA.taxable, true);
  assert.ok(close(by.ISA.marketValue, 1250));
  assert.equal(by.ISA.taxable, false);
});

test("totalWealth consolidates wrappers plus cash", () => {
  const valued = valuePositions(
    buildPositions({
      txns: [
        buy("GIA", "2020-01-01", "CSP1", 100, 1000),
        buy("ISA", "2020-01-01", "CSP1", 50, 500),
      ],
      secMeta,
    }),
    { CSP1: 25 },
  );
  const { total } = totalWealth(valued, { GIA: 200, SIPP: 1000 });
  // GIA holdings 2500 + ISA 1250 = 3750 market; cash 1200 -> 4950
  assert.ok(close(total.marketValue, 3750));
  assert.ok(close(total.cash, 1200));
  assert.ok(close(total.total, 4950));
});

test("unpriced holdings are excluded from market value but counted", () => {
  const valued = valuePositions(
    buildPositions({
      txns: [
        buy("GIA", "2020-01-01", "CSP1", 100, 1000),
        buy("GIA", "2020-01-01", "SMT", 100, 800),
      ],
      secMeta,
    }),
    { CSP1: 25 }, // SMT unpriced
  );
  const { total } = totalWealth(valued);
  assert.ok(close(total.marketValue, 2500));
  assert.equal(total.unpriced, 1);
  assert.deepEqual(total.unpricedTickers, ["SMT"]);
});

/* ------------------------------- income ----------------------------- */
test("incomeByWrapper gates tax to taxable wrappers", () => {
  const { byWrapper, total } = incomeByWrapper({
    incomeEntries: [
      { date: "2025-05-01", ticker: "CSP1", kind: "dividend", amount: 100, wrapper: "GIA" },
      { date: "2025-06-01", ticker: "TR31", kind: "interest", amount: 50, wrapper: "GIA" },
      { date: "2025-06-01", ticker: "CSP1", kind: "dividend", amount: 200, wrapper: "ISA" },
    ],
    eriTxns: [
      { date: "2025-07-01", ticker: "CSP1", wrapper: "GIA", _eri: { treatment: "dividend" }, _gbp: 30 },
    ],
  });
  // GIA: dividends 100 + ERI 30 = 130; interest 50; all taxable
  assert.ok(close(byWrapper.GIA.dividends, 130));
  assert.ok(close(byWrapper.GIA.interest, 50));
  assert.ok(close(byWrapper.GIA.taxableTotal, 180));
  // ISA: 200 dividends, none taxable
  assert.ok(close(byWrapper.ISA.dividends, 200));
  assert.ok(close(byWrapper.ISA.taxableTotal, 0));
  assert.ok(close(total.total, 380));
  assert.ok(close(total.taxableTotal, 180));
});

test("ERI income defaults to the GIA wrapper", () => {
  const { byWrapper } = incomeByWrapper({
    eriTxns: [{ date: "2025-07-01", ticker: "CSP1", _eri: { treatment: "interest" }, _gbp: 15 }],
  });
  assert.ok(close(byWrapper.GIA.interest, 15));
  assert.ok(close(byWrapper.GIA.taxableInterest, 15));
});

/* ---------------------------- allocation ---------------------------- */
test("positions carry the native currency of the latest trade row", () => {
  const positions = buildPositions({
    txns: [
      { ...buy("GIA", "2020-01-01", "CSP1", 100, 1000), nativeCurrency: "GBP" },
      { ...buy("GIA", "2021-01-01", "CSP1", 50, 800), nativeCurrency: "USD" }, // later row wins
      buy("GIA", "2020-01-01", "SMT", 10, 100),                                // no currency -> GBP
    ],
    secMeta,
  });
  assert.equal(positions.find((p) => p.ticker === "CSP1").currency, "USD");
  assert.equal(positions.find((p) => p.ticker === "SMT").currency, "GBP");
});

test("allocation by currency splits on the position currency", () => {
  const valued = valuePositions(
    buildPositions({
      txns: [
        { ...buy("GIA", "2020-01-01", "CSP1", 100, 1000), nativeCurrency: "USD" },
        { ...buy("GIA", "2020-01-01", "SMT", 100, 800), nativeCurrency: "GBP" },
      ],
      secMeta,
    }),
    { CSP1: 25, SMT: 12 }, // 2500 USD-line + 1200 GBP-line
  );
  const cur = allocation(valued, "currency");
  assert.ok(close(cur.find((b) => b.key === "USD").marketValue, 2500));
  assert.ok(close(cur.find((b) => b.key === "GBP").marketValue, 1200));
  assert.ok(close(cur.reduce((s, b) => s + b.pct, 0), 1));
});

test("allocation by asset class and geography sums to the priced total", () => {
  const valued = valuePositions(
    buildPositions({
      txns: [
        buy("GIA", "2020-01-01", "CSP1", 100, 1000), // fund, IE
        buy("GIA", "2020-01-01", "TR31", 1000, 950),  // gilt, GB
        buy("ISA", "2020-01-01", "SMT", 100, 800),    // investment_trust, GB
      ],
      secMeta,
    }),
    { CSP1: 25, TR31: 1.0, SMT: 12 }, // 2500 + 1000 + 1200 = 4700
  );
  const byClass = allocation(valued, "assetClass");
  const classTotal = byClass.reduce((s, b) => s + b.marketValue, 0);
  assert.ok(close(classTotal, 4700));
  assert.ok(close(byClass.reduce((s, b) => s + b.pct, 0), 1));
  const geo = allocation(valued, "geography");
  const gb = geo.find((b) => b.key === "GB");
  assert.ok(close(gb.marketValue, 2200)); // TR31 1000 + SMT 1200
});

/* --------------------------- unified model -------------------------- */
test("buildWealthModel assembles the whole picture", () => {
  const model = buildWealthModel({
    txns: [
      buy("GIA", "2020-01-01", "CSP1", 100, 1000),
      buy("GIA", "2020-01-01", "TR31", 1000, 950),
      buy("ISA", "2020-01-01", "CSP1", 50, 500),
      buy("SIPP", "2020-01-01", "SMT", 200, 1600),
    ],
    incomeEntries: [
      { date: "2025-05-01", ticker: "CSP1", kind: "dividend", amount: 120, wrapper: "GIA" },
      { date: "2025-05-01", ticker: "CSP1", kind: "dividend", amount: 300, wrapper: "ISA" },
    ],
    secMeta,
    prices: { CSP1: 25, TR31: 1.0, SMT: 12 },
    cash: { GIA: 500 },
  });
  // positions: GIA CSP1, GIA TR31, ISA CSP1, SIPP SMT
  assert.equal(model.positions.length, 4);
  // total market: GIA(2500+1000) + ISA(1250) + SIPP(2400) = 7150; +cash 500 = 7650
  assert.ok(close(model.total.marketValue, 7150));
  assert.ok(close(model.total.total, 7650));
  // income: only GIA's 120 is taxable
  assert.ok(close(model.income.total.total, 420));
  assert.ok(close(model.income.total.taxableTotal, 120));
  // allocation present
  assert.ok(model.allocation.assetClass.length >= 2);
  assert.ok(model.allocation.wrapper.length === 3); // GIA, ISA, SIPP have priced value
  assert.ok(model.allocation.currency.length >= 1); // currency dimension present
});
