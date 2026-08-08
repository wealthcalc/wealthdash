/* ======================================================================
   CURRENCY EXPOSURE — how much of your wealth isn't actually in sterling.

   The balance sheet reports everything in GBP, which quietly hides a real
   risk: a portfolio full of US equities can lose several percent of its
   sterling value on a good week for the pound, with no holding having
   fallen at all. Nothing in the app surfaced that.

   Two different things get measured, because conflating them would be
   misleading:

   1. QUOTE currency — the currency a holding trades in. Cheap and exact:
      it's on every position.
   2. UNDERLYING currency — what the assets inside are actually exposed to.
      A FTSE-listed, GBP-quoted world tracker is overwhelmingly dollar
      exposure; its quote currency says nothing useful. That can only come
      from a per-security override, so it's reported as a SEPARATE view
      whose coverage is stated rather than being silently blended in.

   Cash and property are included at their own currency (GBP unless stated),
   because "what share of my wealth moves with the dollar" is a whole-balance-
   sheet question, not a portfolio one.
   Pure and node-tested (currency-exposure.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/* positions: valued positions ({ currency, marketValue, priced, ticker }).
   extras: [{ label, value, currency }] — cash, property, anything else on
   the balance sheet that should count.
   secMeta[ticker].fxExposure: optional override, either a currency code
   ("USD") or a map ({ USD: 0.6, EUR: 0.2, GBP: 0.2 }) for a fund's
   look-through mix. */
export function currencyExposure({ positions = [], extras = [], secMeta = {} } = {}) {
  const quote = new Map();
  const under = new Map();
  let total = 0, unpriced = 0, overriddenValue = 0;

  const add = (map, ccy, v) => map.set(ccy, (map.get(ccy) || 0) + v);

  for (const p of positions) {
    if (!p) continue;
    if (!p.priced || !(p.marketValue > 0)) { unpriced += 1; continue; }
    const v = +p.marketValue;
    total += v;
    // GBp (pence-quoted) is sterling — treating it as its own currency would
    // split the same exposure across two rows.
    const ccy = (p.currency === "GBp" ? "GBP" : p.currency) || "GBP";
    add(quote, ccy, v);

    const ex = secMeta[p.ticker]?.fxExposure;
    if (typeof ex === "string" && ex.trim()) {
      add(under, ex.trim().toUpperCase(), v);
      overriddenValue += v;
    } else if (ex && typeof ex === "object") {
      const weights = Object.entries(ex).filter(([, w]) => +w > 0);
      const sum = weights.reduce((s, [, w]) => s + +w, 0) || 1;
      for (const [k, w] of weights) add(under, k.toUpperCase(), v * (+w / sum));
      overriddenValue += v;
    } else {
      add(under, ccy, v);   // no better information than the quote currency
    }
  }

  for (const e of extras) {
    const v = +e?.value;
    if (!Number.isFinite(v) || v === 0) continue;
    total += v;
    const ccy = (e.currency === "GBp" ? "GBP" : e.currency) || "GBP";
    add(quote, ccy, v);
    add(under, ccy, v);
  }

  const shape = (map) => [...map.entries()]
    .map(([currency, value]) => ({
      currency,
      value: r2(value),
      weight: total > 0 ? r4(value / total) : 0,
    }))
    .sort((a, b) => b.value - a.value);

  const byQuote = shape(quote);
  const byUnderlying = shape(under);
  const nonGbp = (rows) => r4(rows.filter((r) => r.currency !== "GBP").reduce((s, r) => s + r.weight, 0));

  return {
    total: r2(total),
    byQuote,
    byUnderlying,
    nonGbpQuoteShare: nonGbp(byQuote),
    nonGbpUnderlyingShare: nonGbp(byUnderlying),
    unpricedCount: unpriced,
    // What proportion of value has a real look-through override. Without
    // this the "underlying" view looks authoritative when it may just be a
    // copy of the quote view.
    lookThroughCoverage: total > 0 ? r4(overriddenValue / total) : 0,
  };
}
