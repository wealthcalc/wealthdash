/* ======================================================================
   SINCE YOU LAST OPENED — what changed while you were away.

   The dashboard records a net-worth snapshot every day it's opened and logs
   every dividend, but nothing ever told you what had HAPPENED between
   visits. You had to remember your own numbers to notice a move. This turns
   the data already being collected into the one line most worth reading
   first.

   Honesty rules, because a "welcome back" line is exactly where it's
   tempting to overstate:
   - The comparison is against the last snapshot STRICTLY BEFORE this visit.
     If you've already opened the app today, there is nothing new to report
     and this says so rather than comparing today with itself.
   - A gap of one day is described as "yesterday", not "since your last
     visit", because the two read very differently.
   - Snapshots flagged `estimated` (recorded while a holding was unpriced)
     are still used, but the result is marked so the UI can hedge — the
     alternative, silently skipping them, would produce a change measured
     over a window the user didn't expect.
   - Nothing is reported at all on a first run, or when the only snapshot is
     today's. An invented baseline is worse than silence.
   Pure and node-tested (since-last-visit.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;
const DAY = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/* snapshots: [{date, value, estimated}] (core/net-worth-series.mjs)
   incomeEntries: the dividend/interest ledger
   priceMeta: { ticker: { asOf } } — used to count what's gone stale
   today: ISO. `staleDays` matches the app's own freshness threshold. */
export function sinceLastVisit({
  snapshots = [], incomeEntries = [], priceMeta = {}, today, staleDays = 3,
} = {}) {
  if (!today) throw new Error("sinceLastVisit requires `today` (ISO).");

  const sorted = [...snapshots].filter((s) => s && s.date).sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1] || null;
  // The baseline is the newest snapshot from BEFORE today. Comparing today
  // against itself would report a £0 change as though it were news.
  const prior = [...sorted].reverse().find((s) => s.date < today) || null;

  if (!prior || !latest) return { available: false, reason: "no earlier snapshot to compare against" };

  const current = latest.date >= today ? latest : prior;
  if (current.date === prior.date) return { available: false, reason: "already opened today" };

  const gapDays = daysBetween(prior.date, current.date);
  const change = r2((+current.value || 0) - (+prior.value || 0));
  const pct = prior.value ? r2((change / Math.abs(prior.value)) * 100) : null;

  // Income actually received in the window — money that arrived while away,
  // which is the part people most like to see.
  const income = incomeEntries.filter((e) => e && e.date && e.date > prior.date && e.date <= current.date);
  const incomeTotal = r2(income.reduce((s, e) => s + (+e.amount || 0), 0));

  // Prices that have gone stale — a reason the change figure may be
  // understated, so it belongs beside it rather than in a separate nag.
  const staleCutoff = new Date(Date.parse(today) - staleDays * DAY).toISOString().slice(0, 10);
  const stale = Object.entries(priceMeta)
    .filter(([, m]) => m && m.asOf && String(m.asOf).slice(0, 10) < staleCutoff)
    .map(([ticker]) => ticker)
    .sort();

  return {
    available: true,
    from: prior.date,
    to: current.date,
    gapDays,
    // "yesterday" and "over the last three weeks" deserve different wording.
    span: gapDays <= 1 ? "yesterday" : gapDays <= 7 ? "this week" : gapDays <= 31 ? "this month" : "since your last visit",
    previousValue: r2(+prior.value || 0),
    currentValue: r2(+current.value || 0),
    change,
    changePct: pct,
    direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
    income: { total: incomeTotal, count: income.length, entries: income },
    stalePrices: stale,
    estimated: !!(prior.estimated || current.estimated),
  };
}
