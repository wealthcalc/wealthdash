/* ======================================================================
   HOME ACTION QUEUE — turns the aggregates other modules already compute
   into a short, ranked list of MONEY decisions for the Home tab's rail:
   ISA headroom, CGT-allowance harvesting, allocation drift, fixed-rate
   mortgages ending, fixed-term cash maturing. This module owns only the
   thresholds and the ranking; every underlying number comes from an
   already-tested core (allowances/uk-tax/rebalancing/property/cash), so
   there is exactly one source of truth for each figure and this file can
   never disagree with the tab the item links to.

   Deliberately NOT here:
   - dividend allowance / PSA / pension carry-forward — those are only
     actionable near year-end and already live in tax-year-end.mjs's
     checklist. When that banner is active (`taxYearEndActive`), this
     queue also SUPPRESSES its own ISA/AEA items rather than showing the
     same advice twice on one screen.
   - data plumbing (stale prices, unpriced holdings) — the whole point of
     this queue is that "your money needs a decision" and "the app wants
     a refresh click" are different classes of message; the UI shows
     plumbing as a single demoted status line, not queue items.
   Pure and node-tested (action-queue.test.mjs).
   ====================================================================== */

import { ISA_LIMIT } from "./allowances.mjs";
import { daysToTaxYearEnd } from "./tax-year-end.mjs";

export const DRIFT_THRESHOLD_PP = 5;   // below this, rebalancing is noise
export const HARVEST_FLOOR = 100;      // £ of harvestable gain worth a nudge
export const ISA_FLOOR = 500;          // £ headroom below this isn't worth a card
export const MAX_ITEMS = 5;

// Each item: { id, tab, score (0-100, higher = more urgent), amount (£ the
// label leads with), ...context for the label }. Sorted by score desc,
// capped at `max` — a queue of twelve "actions" is a list nobody reads.
export function buildActionQueue({
  today,
  hasIsaWrapper = false,
  isaSubscribed = 0,          // £ subscribed this tax year (ISA+LISA)
  aeaLeft = 0,                // £ of annual exempt amount still unused
  harvestable = 0,            // £ unrealised gains in taxable (GIA) pools
  driftRows = [],             // allocationDrift().rows
  targetsSumTo100 = false,    // drift only means something with real targets
  mortgagesSoon = [],         // mortgagesEndingSoon() output ({expired} flag)
  cashMaturing = [],          // accountsMaturingSoon() output ({matured} flag)
  taxYearEndActive = false,
  max = MAX_ITEMS,
} = {}) {
  if (!today) throw new Error("buildActionQueue requires `today` (ISO date) — pure functions don't read the clock themselves.");
  const items = [];
  const daysLeft = daysToTaxYearEnd(today);
  // Urgency of use-it-or-lose-it allowances grows through the tax year.
  const yearProgress = Math.min(1, Math.max(0, 1 - daysLeft / 365));

  // -- Fixed-rate mortgage ending / expired — the most expensive thing on
  //    this list to ignore (SVR reversion), so it outranks everything.
  for (const m of mortgagesSoon) {
    const days = m.expired ? 0 : Math.max(0, Math.round((new Date(m.fixedEndDate || today) - new Date(today)) / 86400000));
    items.push({
      id: m.expired ? "mortgage-expired" : "mortgage-ending", tab: "property",
      amount: +m.balance || 0, score: m.expired ? 95 : Math.max(45, 90 - days / 4),
      lender: m.lender || "mortgage", days, expired: !!m.expired,
    });
  }

  // -- Fixed-term cash matured / maturing — money silently dropping to a
  //    dead rate.
  for (const a of cashMaturing) {
    const days = a.matured ? 0 : Math.max(0, Math.round((new Date(a.maturityDate) - new Date(today)) / 86400000));
    items.push({
      id: a.matured ? "cash-matured" : "cash-maturing", tab: "wealth",
      amount: +a.balance || 0, score: a.matured ? 80 : Math.max(25, 70 - days / 2),
      label: a.label || a.institution || "cash account", days, matured: !!a.matured,
    });
  }

  // -- ISA headroom — only for someone who actually uses ISAs (an ISA
  //    lecture for a GIA-only user is noise, not advice), and only outside
  //    tax-year-end mode (the banner owns it then).
  const isaHeadroom = Math.max(0, ISA_LIMIT - Math.max(0, isaSubscribed));
  if (!taxYearEndActive && hasIsaWrapper && isaHeadroom >= ISA_FLOOR) {
    items.push({
      id: "isa-headroom", tab: "allowances",
      amount: isaHeadroom, score: 20 + 50 * yearProgress, daysLeft,
    });
  }

  // -- CGT harvesting — unrealised GIA gains and unused AEA both exist;
  //    the realisable amount is whichever is smaller.
  const harvestNow = Math.min(aeaLeft, harvestable);
  if (!taxYearEndActive && harvestNow >= HARVEST_FLOOR) {
    items.push({
      id: "aea-harvest", tab: "cgt",
      amount: harvestNow, score: 15 + 50 * yearProgress, daysLeft, aeaLeft,
    });
  }

  // -- Allocation drift — worst bucket beyond the threshold, only when
  //    targets are real (sum to 100).
  if (targetsSumTo100 && driftRows.length) {
    const worst = [...driftRows].sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct))[0];
    if (worst && Math.abs(worst.driftPct) >= DRIFT_THRESHOLD_PP) {
      items.push({
        id: "allocation-drift", tab: "cgt",
        amount: Math.abs(worst.driftValue), score: Math.min(75, 40 + 2 * (Math.abs(worst.driftPct) - DRIFT_THRESHOLD_PP)),
        bucket: worst.bucket, driftPct: worst.driftPct, overweight: worst.driftPct > 0,
      });
    }
  }

  return items.sort((a, b) => b.score - a.score).slice(0, Math.max(1, max));
}
