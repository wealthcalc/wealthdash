/* ======================================================================
   INCOME CALENDAR (Phase 2, build step 4) — a forward-looking view over
   income already modelled elsewhere in the app: gilt coupons/redemptions
   (core/gilts.mjs — contractually SCHEDULED, not estimated), cash account
   maturities (core/cash.mjs), and a genuinely new piece: a forward
   dividend/interest forecast, built by detecting each series' historical
   cadence (monthly/quarterly/semi-annual/annual) and projecting the next
   occurrences at the recent average amount.

   Deliberately scoped to money actually received (or receivable): pension
   CONTRIBUTIONS are excluded on purpose, even though they're scheduled and
   forecastable the same way dividends are — a contribution is money moving
   from the investor's pocket INTO the pension pot, not income coming back
   out. Including it here would net an outflow against inflows and overstate
   "income." (Pension INCOME — i.e. drawdown once in payment — isn't
   currently modelled in this app at all, so there's nothing to add for that
   side yet either.)

   Every forecast row is explicitly marked "estimated" (dividends can be
   cut, cadence can change) vs "scheduled" (gilt coupons, cash maturities —
   contractual dates). Nothing here invents a payment that hasn't happened
   at least twice historically, and nothing forecasts a holding that's
   since been fully sold. Pure and React-free; runs under node --test.

   Every event also carries a `wrapper` (GIA/ISA/SIPP/LISA/VCT), so the UI
   can show the actual income-tax treatment alongside the amount — GIA
   income is taxable, everything else here is sheltered/tax-free. Dividend/
   interest forecasts use the WRAPPER OF THE MOST RECENT recorded payment in
   that series (a holding can be re-registered onto a different wrapper);
   gilts and cash maturities carry the wrapper straight through from
   gilts.mjs/the cash account record. Unknown wrapper defaults to GIA, same
   "unknown defaults to taxable" convention as core/portfolio.mjs.
   ====================================================================== */

const DAY_MS = 86400000;
const addDaysISO = (dateISO, n) => {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Units of `ticker` held at close of `dateStr`, from a BUY/SELL txn list —
// a pure duplicate of ui/shared.jsx's unitsHeldAt (that copy lives in a
// React-importing module; core stays dependency-free, so this is
// deliberately re-implemented here rather than cross-imported).
function unitsHeldAt(txns, dateStr, ticker) {
  const want = ticker ? String(ticker).toUpperCase() : null;
  let q = 0;
  for (const t of txns) {
    if (t.side !== "BUY" && t.side !== "SELL") continue;
    if (want && String(t.ticker || "").toUpperCase() !== want) continue;
    if (t.date <= dateStr) q += (t.side === "BUY" ? 1 : -1) * t.quantity;
  }
  return q;
}

// Classifies the typical gap (in days) between consecutive dates in one
// series into a payment cadence. Needs at least 2 dates (1 gap); returns
// null if there's nothing to measure. Uses the MEDIAN gap, not the mean,
// so one irregular special-dividend gap doesn't derail an otherwise
// regular quarterly series. Bands are wide enough to absorb weekend/
// bank-holiday drift in real payment dates without misclassifying.
const CADENCE_BANDS = [
  ["monthly", 25, 36],
  ["quarterly", 80, 100],
  ["semi-annual", 170, 196],
  ["annual", 350, 380],
];
export function detectCadence(datesAscending) {
  if (!datesAscending || datesAscending.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < datesAscending.length; i++) {
    gaps.push((+new Date(datesAscending[i]) - +new Date(datesAscending[i - 1])) / DAY_MS);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const medianDays = sorted[Math.floor(sorted.length / 2)];
  const hit = CADENCE_BANDS.find(([, lo, hi]) => medianDays >= lo && medianDays <= hi);
  return { label: hit ? hit[0] : "irregular", medianDays: Math.round(medianDays) };
}

// Forecast occurrence dates: step forward from `lastDate` by `stepDays`
// until the horizon, capped at 24 occurrences as a sanity backstop (a
// monthly series over the max realistic horizon).
export function nextOccurrences(lastDate, stepDays, today, horizonDays = 365) {
  if (!lastDate || !Number.isFinite(stepDays) || stepDays <= 0) return [];
  const horizonISO = addDaysISO(today, horizonDays);
  const out = [];
  let cur = lastDate;
  for (let i = 0; i < 24; i++) {
    cur = addDaysISO(cur, Math.round(stepDays));
    if (cur > horizonISO) break;
    if (cur > today) out.push(cur);
  }
  return out;
}

// The combined, sorted calendar. `giltCashflows` is the `cashflows` array
// already produced by core/gilts.mjs's giltAnalytics() — this module
// doesn't recompute gilt schedules, just folds them in.
export function buildIncomeCalendar({
  incomeEntries = [], txns = [], cashAccounts = [],
  giltCashflows = [], deferredCash = [], today, horizonDays = 365,
} = {}) {
  if (!today) throw new Error("buildIncomeCalendar requires `today` (ISO date) — pure functions don't read the clock themselves.");
  const events = [];
  const horizonISO = addDaysISO(today, horizonDays);

  // 1. Gilts — contractually scheduled, not estimated.
  for (const cf of giltCashflows) {
    if (cf.date > today && cf.date <= horizonISO) {
      events.push({
        date: cf.date, source: cf.type === "redemption" ? "gilt-redemption" : "gilt-coupon",
        label: cf.ticker, amount: cf.amount, certainty: "scheduled", wrapper: cf.wrapper || "GIA",
      });
    }
  }

  // 2. Dividends/interest — per (ticker, kind) cadence forecast. A blank
  // ticker (kind "interest") represents un-attributed interest (e.g. cash
  // interest logged without a specific holding) and is always eligible;
  // a real ticker must still be an open position — a fully sold holding
  // doesn't get projected future dividends.
  const series = new Map();
  for (const e of incomeEntries) {
    if (!e || !e.date || !e.amount) continue;
    const key = `${e.ticker || ""}|${e.kind || "dividend"}`;
    if (!series.has(key)) series.set(key, { ticker: e.ticker || "", kind: e.kind || "dividend", dates: [], amounts: [], wrappers: [] });
    const s = series.get(key);
    s.dates.push(e.date);
    s.amounts.push(+e.amount);
    s.wrappers.push(e.wrapper || "");
  }
  for (const s of series.values()) {
    const order = s.dates.map((_, i) => i).sort((a, b) => (s.dates[a] < s.dates[b] ? -1 : 1));
    const dates = order.map((i) => s.dates[i]);
    const amounts = order.map((i) => s.amounts[i]);
    const wrappers = order.map((i) => s.wrappers[i]);
    if (dates.length < 2) continue;
    if (s.ticker && unitsHeldAt(txns, today, s.ticker) <= 1e-9) continue; // fully sold — no future income
    const cadence = detectCadence(dates);
    if (!cadence || cadence.label === "irregular") continue;
    const recent = amounts.slice(-3);
    const avgAmount = Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 100) / 100;
    // Wrapper attribution: the most recent entry's wrapper — a holding can
    // move accounts (rare, but a re-registration onto ISA/SIPP is real), so
    // the LATEST recorded wrapper is the best guide to where future payments
    // will land, not the earliest. Falls back to GIA (same "unknown wrapper
    // defaults to taxable" convention as core/portfolio.mjs).
    const wrapper = wrappers[wrappers.length - 1] || "GIA";
    for (const d of nextOccurrences(dates[dates.length - 1], cadence.medianDays, today, horizonDays)) {
      events.push({ date: d, source: s.kind === "interest" ? "interest" : "dividend", label: s.ticker || "Interest", amount: avgAmount, certainty: "estimated", cadence: cadence.label, wrapper });
    }
  }

  // 3. Cash account maturities within the horizon — contractually scheduled.
  for (const a of cashAccounts) {
    if (a.rateType !== "fixed" || !a.maturityDate) continue;
    if (a.maturityDate > today && a.maturityDate <= horizonISO) {
      events.push({ date: a.maturityDate, source: "cash-maturity", label: a.label || a.institution || a.wrapper, amount: +a.balance || 0, certainty: "scheduled", wrapper: a.wrapper || "GIA" });
    }
  }

  // 4. Deferred-cash tranche payouts — contractually scheduled cash inflows
  // (core/deferred-cash.mjs already bounds these to future/in-horizon and
  // shapes them; this module doesn't need to know the award record shape).
  // No wrapper: it's employment income taxed via PAYE at payment, not
  // investment income sitting in a GIA/ISA/etc — the UI shows no wrapper
  // tax badge for this source rather than implying one.
  for (const p of deferredCash) {
    if (!p || !p.date) continue;
    if (p.date > today && p.date <= horizonISO) {
      events.push({ date: p.date, source: "deferred-cash", label: p.label || "Deferred cash", amount: +p.amount || 0, certainty: "scheduled", wrapper: null });
    }
  }

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return events;
}

// Headline totals by source, over whatever horizon buildIncomeCalendar was
// called with — for a "expected income next 12 months" summary strip.
export function summariseBySource(events = []) {
  const out = {};
  for (const e of events) {
    (out[e.source] ||= { count: 0, total: 0 });
    out[e.source].count += 1;
    out[e.source].total += e.amount;
  }
  return out;
}
