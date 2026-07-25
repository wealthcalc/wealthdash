/* ======================================================================
   RECURRING-PAYMENT DETECTION — find the subscriptions and direct debits
   hiding in imported statement rows, so the user doesn't have to declare
   each one by hand. Closes the loop between Import and the Recurring tab.

   A cluster is "recurring" when the SAME merchant (normalised) is charged
   at a REGULAR cadence (monthly / quarterly / annual) for a CONSISTENT
   amount. Each of those three has a deliberate tolerance:
   - merchant: normaliseMerchant() (shared with categorisation) collapses
     the store-number/date noise banks add, so "NETFLIX.COM 8829" and
     "NETFLIX.COM 4471" are one merchant.
   - cadence: the median gap must fall in a monthly/quarterly/annual band,
     the same detector the income calendar uses — a couple of irregular
     gaps don't disqualify an otherwise regular series.
   - amount: real subscriptions drift (price rises, FX), so amounts within
     a band of the median count as "the same" charge. A merchant you visit
     at wildly varying amounts (a supermarket) fails this and is NOT
     flagged — that's a shop, not a subscription.

   PRICE-RISE flagging falls straight out of the same data: if the latest
   charge is materially above the earliest, the subscription has crept up,
   and the £/yr increase is surfaced — the leak people miss.

   Deliberately conservative: needs at least 3 charges over a real span, so
   two coincidental same-amount payments aren't mistaken for a standing
   order. Suggestions only — nothing is created without the user's click.

   Pure and node-tested (detect-recurring.test.mjs).
   ====================================================================== */
import { normaliseMerchant } from "./categorise.mjs";
import { detectCadence } from "./income-calendar.mjs";

const r2 = (x) => Math.round(x * 100) / 100;
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const CADENCE_TO_FREQUENCY = { monthly: "monthly", quarterly: "quarterly", "semi-annual": "biannual", annual: "annual" };

// txns: spend rows [{ date, description, amount, categoryId, account }].
// `existingLabels` is a set of labels/merchants already declared as
// recurring, so a detected cluster the user has already added isn't
// re-suggested.
export function detectRecurring(txns = [], { existingKeys = new Set(), minCharges = 3, amountTolerance = 0.25 } = {}) {
  // Group by normalised merchant, POSITIVE spend only (a refund isn't a
  // subscription charge).
  const groups = new Map();
  for (const t of txns) {
    if (!t || !t.date || !(+t.amount > 0)) continue;
    const key = normaliseMerchant(t.description);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, sample: t.description || "", account: t.account || "", categoryId: t.categoryId || null, rows: [] });
    groups.get(key).rows.push({ date: t.date, amount: +t.amount });
  }

  const suggestions = [];
  for (const g of groups.values()) {
    if (g.rows.length < minCharges) continue;
    g.rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    const dates = g.rows.map((r) => r.date);
    const amounts = g.rows.map((r) => r.amount);
    const spanDays = (+new Date(dates[dates.length - 1]) - +new Date(dates[0])) / 86400000;
    if (spanDays < 60) continue; // too short a history to be a standing order

    const cadence = detectCadence(dates);
    if (!cadence || !CADENCE_TO_FREQUENCY[cadence.label]) continue;

    // Amount consistency: most charges must sit within the tolerance band
    // of the median. A merchant with wildly varying amounts is a shop, not
    // a subscription.
    const med = median(amounts);
    if (!(med > 0)) continue;
    const within = amounts.filter((a) => Math.abs(a - med) <= med * amountTolerance).length;
    if (within / amounts.length < 0.6) continue;

    if (existingKeys.has(g.key)) continue;

    // Price-rise: latest vs earliest charge, only when it's a real rise
    // (above the amount tolerance, not just noise).
    const first = amounts[0], last = amounts[amounts.length - 1];
    const rose = last > first * (1 + amountTolerance);
    const perYear = med * (12 / stepMonths(cadence.label));

    suggestions.push({
      key: g.key,
      label: titleCase(g.key),
      sample: g.sample,
      account: g.account,
      categoryId: g.categoryId,
      frequency: CADENCE_TO_FREQUENCY[cadence.label],
      cadence: cadence.label,
      amount: r2(med),
      charges: g.rows.length,
      startDate: dates[dates.length - 1], // most recent charge = next-cycle anchor
      firstSeen: dates[0],
      annualEstimate: r2(perYear),
      priceRose: rose,
      priceFrom: rose ? r2(first) : null,
      priceTo: rose ? r2(last) : null,
      annualIncrease: rose ? r2((last - first) * (12 / stepMonths(cadence.label))) : 0,
    });
  }
  // Biggest annual commitment first — that's where attention is worth most.
  suggestions.sort((a, b) => b.annualEstimate - a.annualEstimate);
  return suggestions;
}

// Top merchants by total spend over a window — "where does my money
// actually go, by shop" rather than by category. Groups on the normalised
// merchant so store-number noise collapses; refunds net off; transfers
// (by categoryId) excluded. Returns the ranked list and each merchant's
// share of the total.
export function topMerchants(txns = [], { transferIds = new Set(), limit = 12 } = {}) {
  const groups = new Map();
  for (const t of txns) {
    if (!t || !t.date) continue;
    if (t.categoryId && transferIds.has(t.categoryId)) continue;
    const key = normaliseMerchant(t.description);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, label: titleCase(key), sample: t.description || "", total: 0, count: 0 });
    const g = groups.get(key);
    g.total += +t.amount || 0; g.count += 1;
  }
  const rows = [...groups.values()].filter((g) => g.total > 0).map((g) => ({ ...g, total: r2(g.total) })).sort((a, b) => b.total - a.total);
  const grand = r2(rows.reduce((s, r) => s + r.total, 0));
  for (const r of rows) r.weight = grand > 0 ? r2((r.total / grand) * 100) : 0;
  return { rows: rows.slice(0, limit), total: grand, merchantCount: rows.length };
}

const stepMonths = (label) => (label === "monthly" ? 1 : label === "quarterly" ? 3 : label === "semi-annual" ? 6 : 12);
function titleCase(s) {
  return String(s || "").split(" ").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
