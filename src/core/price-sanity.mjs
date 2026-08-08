/* ======================================================================
   PRICE SANITY + CORPORATE ACTIONS — catching the two ways a price can be
   wrong without anything looking broken.

   1. A BAD QUOTE. Live prices arrive from a symbol lookup, and symbols
      collide. A workplace fund code that happens to match a US ETF returns
      a real, plausible-looking price for the wrong security — no error, no
      warning, just a number that's out by a factor of ten and in the wrong
      currency. Once it lands in a daily snapshot it corrupts the trend
      chart and every performance figure derived from it, permanently.

   2. A CORPORATE ACTION. A share split changes the quantity at the broker
      while the ledger keeps the old one, so quantity, cost basis and CGT all
      go wrong at once. Splits are the common case and have a fingerprint:
      the price divides by almost exactly the ratio the quantity multiplies
      by, on a single day, with no trade to explain it.

   Both are DETECTION ONLY. Nothing is auto-corrected: a 30% fall might be a
   bad tick or might be a bad day, and the app can't tell. It can only say
   "this looks wrong, check it" — which is the difference between a useful
   warning and a silent corruption in the other direction.
   Pure and node-tested (price-sanity.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/* Flag prices that moved implausibly since the last recorded value.

   `jumpPct` defaults to 25%: below that, single-day moves are ordinary for
   individual equities and flagging them would train the user to dismiss the
   warning. Above it, a data error is far more likely than a real move —
   and the check is a prompt, not a verdict. */
export function priceSanity({ prices = {}, previous = {}, priceMeta = {}, secMeta = {}, jumpPct = 25 } = {}) {
  const issues = [];
  for (const [ticker, price] of Object.entries(prices)) {
    const p = +price;
    const prev = +previous[ticker];
    const meta = priceMeta[ticker] || {};
    const kind = secMeta[ticker]?.kind;

    if (!Number.isFinite(p) || p <= 0) {
      issues.push({ ticker, type: "invalid", price: price ?? null, message: `${ticker}: price is ${p === 0 ? "zero" : "not a usable number"}.` });
      continue;
    }
    // A pension/LISA fund can only be priced by hand — a live source on one
    // is definitionally a different security with the same symbol.
    if (kind === "fund" && meta.source && !/^(manual|L&G)/i.test(meta.source)) {
      issues.push({
        ticker, type: "wrong-source", price: p, source: meta.source, ccy: meta.ccy,
        message: `${ticker}: priced from ${meta.source}${meta.ccy && meta.ccy !== "GBP" ? ` in ${meta.ccy}` : ""}, but workplace fund units aren't exchange-traded — this is a different security with the same symbol.`,
      });
      continue;
    }
    if (!Number.isFinite(prev) || prev <= 0) continue;  // nothing to compare

    const changePct = ((p - prev) / prev) * 100;
    if (Math.abs(changePct) >= jumpPct) {
      // A move that's close to a round ratio is the signature of a share
      // split rather than a market move — worth naming, since the fix is
      // completely different (adjust quantity, don't re-fetch the price).
      const ratio = prev / p;
      const split = nearRatio(ratio) || (nearRatio(p / prev) ? { ...nearRatio(p / prev), reverse: true } : null);
      issues.push({
        ticker, type: split ? "possible-split" : "jump",
        price: p, previous: r4(prev), changePct: r2(changePct),
        ratio: split ? split.label : null,
        message: split
          ? `${ticker}: price moved by a factor of about ${split.label} — that's the signature of a ${split.reverse ? "reverse " : ""}share split, not a market move. Check whether your quantity needs adjusting too.`
          : `${ticker}: price moved ${r2(changePct)}% since the last value (${r4(prev)} → ${r4(p)}). Verify before this lands in a snapshot.`,
      });
    }
  }
  return { issues, clean: issues.length === 0 };
}

// Is `x` close to a simple whole-number ratio (2:1, 3:1, 10:1…)? Splits use
// tidy ratios, whereas a genuine market move almost never lands on one.
function nearRatio(x, tol = 0.03) {
  if (!Number.isFinite(x) || x <= 1.5) return null;
  for (const n of [2, 3, 4, 5, 6, 8, 10, 20, 100]) {
    if (Math.abs(x - n) / n <= tol) return { n, label: `${n}:1` };
  }
  return null;
}

/* Detect a quantity change with no transaction to explain it.

   Compares the broker's reported quantity against the ledger's, and asks
   whether the difference is a clean MULTIPLE rather than an arbitrary
   number. 100 -> 400 with no trades is a 4:1 split; 100 -> 427 is a missing
   purchase. The two need completely different fixes, and telling them apart
   is most of the value. */
export function detectCorporateActions({ reconcileRows = [], tolerance = 0.02 } = {}) {
  const actions = [];
  for (const row of reconcileRows) {
    if (!row || row.status === "match" || row.status === "not-at-broker") continue;
    const { ledgerQty, brokerQty, ticker } = row;
    if (!(ledgerQty > 0) || !(brokerQty > 0)) continue;

    const ratio = brokerQty / ledgerQty;
    const fwd = nearRatio(ratio, tolerance);
    const rev = nearRatio(1 / ratio, tolerance);
    if (fwd) {
      actions.push({
        ticker, type: "split", ratio: fwd.label, factor: fwd.n, ledgerQty, brokerQty,
        message: `${ticker}: the broker holds ${fwd.label} the ledger's quantity — consistent with a ${fwd.label} share split. Your cost per share should divide by ${fwd.n}; total cost is unchanged.`,
      });
    } else if (rev) {
      actions.push({
        ticker, type: "reverse-split", ratio: `1:${rev.n}`, factor: rev.n, ledgerQty, brokerQty,
        message: `${ticker}: the broker holds 1/${rev.n} of the ledger's quantity — consistent with a 1:${rev.n} reverse split. Total cost is unchanged.`,
      });
    }
    // Anything else stays a plain reconciliation difference — position
    // reconciliation already reports it, and guessing at a cause here would
    // just add noise.
  }
  return actions;
}
