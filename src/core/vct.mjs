/* ======================================================================
   VCT HOLDING-PERIOD TRACKER — Venture Capital Trusts carry a rule the
   rest of the app is silent on, and it's real money: to KEEP the 30%
   income-tax relief you claimed when subscribing, you must hold the shares
   for at least FIVE YEARS. Sell (or the shares are bought back) inside
   five years and HMRC claws the relief back — up to 30% of what you put
   in. This surfaces, per VCT subscription: when its five years are up, how
   long is left, and the relief at stake if sold early.

   Modelling decisions, stated plainly:
   - Relief applies to money SUBSCRIBED FOR NEW SHARES (an offer/allotment),
     at 30% up to the £200k annual limit. This app can't tell a genuine new
     subscription apart from a secondary-market purchase from the ledger
     alone, so it treats each VCT BUY as a subscription and DISCLOSES that
     — a secondary-market buy earns no relief and isn't subject to
     clawback, so the user must exclude those. Better to show the rule and
     let the user prune than to hide a real clawback risk.
   - The five years run from the ALLOTMENT (purchase) date. Dividends do
     NOT reset or affect it — only the original subscription matters.
   - Relief is capped at the tax actually paid that year; the app can't
     know that, so 30% is an UPPER BOUND on what's at risk, labelled as
     such.
   - Buybacks: VCTs routinely buy their own shares back. A buyback inside
     five years is a disposal and triggers clawback exactly like a sale —
     so this treats each BUY lot independently (a partial sale claws back
     pro-rata), matching how HMRC views it.

   Pure and node-tested (vct.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;
const RELIEF_RATE = 0.30;
const HOLD_YEARS = 5;

// Add whole years to an ISO date (clamping Feb 29 → Feb 28).
function addYearsISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const ny = y + n;
  const last = new Date(Date.UTC(ny, m, 0)).getUTCDate();
  return `${ny}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// txns: full ledger. secMeta: { ticker: { ... } }. A holding is a VCT if
// its wrapper is "VCT" on its buys (the app's convention) or secMeta marks
// it. today: ISO. Returns per-subscription lots with clawback timing.
export function vctHoldings({ txns = [], secMeta = {}, today } = {}) {
  if (!today) throw new Error("vctHoldings requires today (ISO) — pure functions don't read the clock.");
  // Which tickers are VCTs? Any BUY/SELL tagged wrapper VCT, or secMeta.
  const isVct = (t) => (t.wrapper === "VCT") || secMeta[t.ticker]?.kind === "vct" || secMeta[t.ticker]?.vct === true;

  // Per ticker: subscription BUY lots (each its own 5-year clock) and the
  // running sold quantity (FIFO) so we know how much of each lot survives.
  const byTicker = new Map();
  for (const t of txns) {
    if (!t || (t.side !== "BUY" && t.side !== "SELL") || !isVct(t)) continue;
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, { buys: [], sells: [] });
    const g = byTicker.get(t.ticker);
    (t.side === "BUY" ? g.buys : g.sells).push({ date: t.date, qty: +t.quantity || 0, gbp: +t.gbpAmount || 0 });
  }

  const lots = [];
  for (const [ticker, g] of byTicker) {
    g.buys.sort((a, b) => (a.date < b.date ? -1 : 1));
    // FIFO-consume sold quantity against the oldest lots.
    let toSell = g.sells.reduce((s, x) => s + x.qty, 0);
    for (const b of g.buys) {
      let remaining = b.qty;
      if (toSell > 0) { const used = Math.min(remaining, toSell); remaining -= used; toSell -= used; }
      if (remaining <= 1e-9) continue; // this lot fully sold already
      const costRemaining = b.qty > 0 ? b.gbp * (remaining / b.qty) : 0;
      const clawbackDate = addYearsISO(b.date, HOLD_YEARS);
      const daysLeft = daysBetween(today, clawbackDate);
      const cleared = daysLeft <= 0;
      lots.push({
        ticker,
        subscribedDate: b.date,
        clawbackDate,
        daysLeft: cleared ? 0 : daysLeft,
        cleared,
        qtyRemaining: r2(remaining),
        costRemaining: r2(costRemaining),
        reliefAtRisk: cleared ? 0 : r2(costRemaining * RELIEF_RATE),
      });
    }
  }
  lots.sort((a, b) => (a.clawbackDate < b.clawbackDate ? -1 : 1));

  const locked = lots.filter((l) => !l.cleared);
  return {
    lots,
    summary: {
      subscriptions: lots.length,
      lockedCount: locked.length,
      reliefAtRisk: r2(locked.reduce((s, l) => s + l.reliefAtRisk, 0)),
      // The soonest lot to clear its 5 years — "you're free to sell X from
      // this date without clawback".
      nextClears: locked.length ? locked.slice().sort((a, b) => (a.clawbackDate < b.clawbackDate ? -1 : 1))[0] : null,
      // Anything clearing within a year is worth knowing (you could realise
      // it and rotate the relief into a fresh subscription).
      clearingWithinYear: locked.filter((l) => l.daysLeft <= 365).length,
      costLocked: r2(locked.reduce((s, l) => s + l.costRemaining, 0)),
    },
  };
}
