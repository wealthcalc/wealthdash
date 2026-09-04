/* ======================================================================
   POSITION RECONCILIATION — does what the app believes you own match what
   the broker says you own?

   Why this is the most important accuracy check in the app: every position
   here is DERIVED from transaction history. Quantity, book cost, S104 pool,
   unrealised gain, CGT on disposal — all of it is reconstructed from the
   ledger. So a single missing transaction (an unrecorded vest, a partial
   import, a corporate action) doesn't produce an error; it produces a
   confidently wrong number that propagates into tax figures and net worth
   and never announces itself. The 327 unledgered vest shares that took a
   manual audit to find are exactly this failure mode.

   The broker's own position report is ground truth for quantity, and it was
   already being fetched — api/ibkr-flex.mjs pulls `OpenPosition` elements
   and shapeFlexPull simply dropped them. This module puts them to work.

   Scope, deliberately narrow: QUANTITY only.
   - Cost basis is NOT compared. A broker's cost basis follows its own
     conventions (average cost, FX at different dates, different treatment
     of fees) and legitimately differs from a UK S104 pool. Flagging that as
     a discrepancy would produce noise the user learns to ignore, which
     would bury the quantity mismatches that genuinely matter.

   SCOPE IS NOT THE WRAPPER. The first version scoped by wrapper alone,
   which quietly assumed one broker per wrapper. Hold a GIA at IBKR and a
   second GIA elsewhere — investment trusts at a platform, vested shares at
   the employer's broker — and every holding at the OTHER broker was
   reported as a discrepancy on every import ("11 of 27 GIA holdings
   disagree"), with a message suggesting a missing sale. That's noise the
   user cannot act on and cannot silence, which is the failure mode that
   trains people to ignore the panel entirely — and this panel is the one
   that catches genuinely wrong tax numbers.

   So a ticker the statement doesn't mention is now sorted three ways:
     - the user has said it lives at another broker  -> excluded outright
     - this broker HAS reported it before            -> a real flag: it's
       gone, so a sale or transfer out may be unrecorded
     - never seen from this broker                   -> out of scope, shown
       quietly and counted separately, never as a disagreement
   The middle case is why coverage is remembered across imports at all: an
   omitted line and a line that was never there look identical in a single
   statement.

   Pure and node-tested (position-reconcile.test.mjs).
   ====================================================================== */
import { resolveIbkrTicker } from "./ibkr-import.mjs";

const EPS = 1e-6;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };

/* IBKR OpenPosition rows -> [{ ticker, qty, currency, isin, symbol }].
   Rows are keyed by the SAME ticker resolution the trade importer uses
   (ISIN seed first, then the .L suffix for LSE lines), or the comparison
   would report false mismatches purely from naming. Quantities for the same
   ticker are summed: IBKR can split one holding across lots/sub-accounts. */
export function shapeBrokerPositions(rawOpenPositions = [], { seedByIsin = {} } = {}) {
  const bySymbol = new Map();
  for (const attrs of rawOpenPositions) {
    if (!attrs || typeof attrs !== "object") continue;
    const get = (...keys) => { for (const k of keys) if (attrs[k] !== undefined && attrs[k] !== "") return attrs[k]; return undefined; };
    const symbol = get("symbol");
    const isin = get("isin", "securityID", "securityId");
    const currency = get("currency");
    const exchange = get("listingExchange", "exchange");
    const qty = num(get("position", "quantity"));
    if (!symbol || qty == null) continue;
    // A closed position can legitimately appear with quantity 0 — nothing to
    // reconcile, and including it would invent "extra in ledger" noise.
    if (Math.abs(qty) < EPS) continue;
    const ticker = resolveIbkrTicker(symbol, isin, currency, exchange, seedByIsin);
    if (!ticker) continue;
    const prev = bySymbol.get(ticker);
    if (prev) prev.qty = r4(prev.qty + qty);
    else bySymbol.set(ticker, { ticker, qty: r4(qty), currency: currency || null, isin: isin || null, symbol });
  }
  return [...bySymbol.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/* Compare broker positions against the app's computed holdings.

   `positions` is the wealth model's positions array ({ ticker, wrapper, qty }).
   `wrappers` limits which of them the broker is considered authoritative for
   — a GIA statement says nothing about your ISA.

   `seenAtBroker` is every ticker this broker has reported in any PREVIOUS
   import; `excluded` is tickers the user has said are held elsewhere.

   Statuses:
     match             quantities agree within tolerance
     missing-in-ledger broker holds MORE than the ledger explains (the
                       dangerous one: an unrecorded acquisition, so cost
                       basis and future CGT are both wrong)
     extra-in-ledger   ledger holds more than the broker reports (an
                       unrecorded sale, or a transfer out)
     closed-at-broker  this broker used to report it and now doesn't — the
                       ledger still shows a holding, so a sale or transfer
                       out is probably unrecorded
     not-at-broker     never reported by this broker: out of scope, not a
                       discrepancy
   Only the first three plus closed-at-broker count as DISCREPANCIES;
   `clean` follows those, not the out-of-scope list.
   `tolerance` absorbs fractional-share rounding, not real differences. */
export function reconcilePositions({
  broker = [], positions = [], wrappers = ["GIA"], tolerance = 0.001,
  seenAtBroker = [], excluded = [],
} = {}) {
  const scope = new Set(wrappers.map((w) => String(w).toUpperCase()));
  const everSeen = new Set(seenAtBroker.map((t) => String(t).toUpperCase()));
  const skip = new Set(excluded.map((t) => String(t).toUpperCase()));
  const ledger = new Map();
  for (const p of positions) {
    if (!p || !p.ticker) continue;
    if (!scope.has(String(p.wrapper).toUpperCase())) continue;
    const cur = ledger.get(p.ticker) || { qty: 0, wrappers: new Set() };
    cur.qty += +p.qty || 0;
    cur.wrappers.add(p.wrapper);
    ledger.set(p.ticker, cur);
  }

  const rows = [];
  const seen = new Set();
  let excludedCount = 0;
  const excludedTickers = [];
  for (const b of broker) {
    seen.add(b.ticker);
    // A ticker the broker is actually reporting is in scope by definition —
    // an exclusion can't override the statement in front of us, or a
    // dismissal made once would hide a real discrepancy forever.
    const l = ledger.get(b.ticker);
    const ledgerQty = l ? r4(l.qty) : 0;
    const diff = r4(b.qty - ledgerQty);
    rows.push({
      ticker: b.ticker,
      brokerQty: b.qty,
      ledgerQty,
      diff,
      wrapper: l ? [...l.wrappers].join("/") : null,
      status: Math.abs(diff) <= tolerance ? "match" : (diff > 0 ? "missing-in-ledger" : "extra-in-ledger"),
    });
  }
  // Held in the app, absent from the broker's report.
  for (const [ticker, l] of ledger) {
    if (seen.has(ticker)) continue;
    if (skip.has(String(ticker).toUpperCase())) { excludedCount += 1; excludedTickers.push(ticker); continue; }
    rows.push({
      ticker, brokerQty: 0, ledgerQty: r4(l.qty), diff: r4(-l.qty),
      wrapper: [...l.wrappers].join("/"),
      status: everSeen.has(String(ticker).toUpperCase()) ? "closed-at-broker" : "not-at-broker",
    });
  }

  rows.sort((a, b) => {
    const rank = { "missing-in-ledger": 0, "extra-in-ledger": 1, "closed-at-broker": 2, "not-at-broker": 3, match: 4 };
    return (rank[a.status] - rank[b.status]) || Math.abs(b.diff) - Math.abs(a.diff) || a.ticker.localeCompare(b.ticker);
  });

  const isDiscrepancy = (r) => r.status === "missing-in-ledger" || r.status === "extra-in-ledger" || r.status === "closed-at-broker";
  const discrepancies = rows.filter(isDiscrepancy).length;
  const notAtBroker = rows.filter((r) => r.status === "not-at-broker").length;
  return {
    rows,
    summary: {
      // Lines this statement can actually speak to.
      checked: rows.length - notAtBroker,
      matched: rows.filter((r) => r.status === "match").length,
      discrepancies,
      missingInLedger: rows.filter((r) => r.status === "missing-in-ledger").length,
      extraInLedger: rows.filter((r) => r.status === "extra-in-ledger").length,
      closedAtBroker: rows.filter((r) => r.status === "closed-at-broker").length,
      notAtBroker,
      excludedCount,
      excludedTickers,
      clean: discrepancies === 0,
      // Retained for callers that predate the out-of-scope split (and for
      // the data-health check) — same meaning as `discrepancies` now, i.e.
      // it no longer counts holdings the statement never covered.
      mismatched: discrepancies,
    },
  };
}

/* Every ticker this broker has ever reported, merged across imports.
   Kept because an omitted line and a line that was never there are
   indistinguishable inside a single statement — only history tells them
   apart. Union only: a ticker legitimately drops out when it's sold, and
   forgetting it then would silently downgrade a real "you sold this and
   didn't record it" into "out of scope". */
export function mergeBrokerCoverage(previous = [], brokerRows = []) {
  const out = new Set((previous || []).map((t) => String(t).toUpperCase()).filter(Boolean));
  for (const b of brokerRows || []) if (b && b.ticker) out.add(String(b.ticker).toUpperCase());
  return [...out].sort();
}

/* A balancing transaction that would make the ledger agree with the broker.
   Deliberately returns a DRAFT for the user to date, price and confirm — not
   something applied automatically. The quantity is known; the price and the
   reason (vest? transfer in? missed buy?) are not, and guessing them would
   put fiction into a tax record. */
export function balancingDraft(row, { wrapper = "GIA", date = null } = {}) {
  if (!row || row.status === "match") return null;
  const qty = Math.abs(row.diff);
  return {
    ticker: row.ticker,
    side: row.diff > 0 ? "BUY" : "SELL",
    quantity: r4(qty),
    wrapper: row.wrapper || wrapper,
    date,
    gbpAmount: null,          // must be supplied — never invented
    note: row.diff > 0
      ? `Balancing entry: broker reports ${row.brokerQty}, ledger has ${row.ledgerQty}.`
      : `Balancing entry: ledger has ${row.ledgerQty}, broker reports ${row.brokerQty}.`,
  };
}
