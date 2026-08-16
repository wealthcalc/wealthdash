/* ======================================================================
   RETURNS BY PERIOD — "how did 2024 go, versus 2025?"

   The app could show a cumulative TWR line and an annualised XIRR, but
   neither answers the question people actually ask first: what did each
   YEAR do. A cumulative curve hides a bad year inside a good decade, and an
   annualised figure averages it away entirely.

   Built from the same TWR periods the portfolio return already uses, so the
   yearly figures COMPOUND back to the headline number rather than being a
   second, differently-derived answer. Each period carries a growth `factor`
   with contributions already neutralised, which is what makes this a
   time-weighted return per year rather than "how much did my balance move"
   — the latter would credit a year for money paid in, not for performance.

   Partial periods (the current year, or the first year if tracking began
   mid-year) are FLAGGED rather than annualised. Scaling three weeks of data
   up to a yearly rate produces confident nonsense.
   Pure and node-tested (period-returns.test.mjs).
   ====================================================================== */

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r2 = (x) => Math.round(x * 100) / 100;

const keyOf = (date, by) => (by === "month" ? String(date).slice(0, 7) : String(date).slice(0, 4));

/* periods: [{ from, to, factor }] from core/returns.mjs twrFromValuations.
   values: optional [{ date, value }] so each period can also report the £
   move, which is what most people read first.
   by: "year" (default) | "month". */
export function returnsByPeriod({ periods = [], values = [], by = "year", today = null } = {}) {
  const buckets = new Map();

  for (const p of periods) {
    if (!p || !Number.isFinite(+p.factor) || p.factor <= 0) continue;
    // A period is attributed to the bucket it ENDS in: a return is realised
    // over the interval, and the closing date is what a reader associates it
    // with ("December's move" belongs to December).
    const k = keyOf(p.to, by);
    const b = buckets.get(k) || { key: k, factor: 1, periods: 0, from: p.from, to: p.to };
    b.factor *= +p.factor;
    b.periods += 1;
    if (p.from < b.from) b.from = p.from;
    if (p.to > b.to) b.to = p.to;
    buckets.set(k, b);
  }

  // £ start/end per bucket, for the money figure beside the percentage.
  const sorted = [...values].filter((v) => v && v.date).sort((a, b) => a.date.localeCompare(b.date));
  const valueAt = (date, dir) => {
    if (!sorted.length) return null;
    if (dir === "before") {
      let out = null;
      for (const v of sorted) { if (v.date <= date) out = v; else break; }
      return out ? +out.value : null;
    }
    for (const v of sorted) if (v.date >= date) return +v.value;
    return null;
  };

  const nowKey = today ? keyOf(today, by) : null;
  const rows = [...buckets.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => {
      const startValue = valueAt(b.from, "after");
      const endValue = valueAt(b.to, "before");
      return {
        key: b.key,
        label: by === "month" ? b.key : b.key,
        from: b.from,
        to: b.to,
        return: r4(b.factor - 1),
        // The £ move over the same window. Note this INCLUDES contributions,
        // unlike the return — they answer different questions and the UI
        // labels them separately rather than pretending they reconcile.
        valueChange: startValue != null && endValue != null ? r2(endValue - startValue) : null,
        startValue: startValue != null ? r2(startValue) : null,
        endValue: endValue != null ? r2(endValue) : null,
        periods: b.periods,
        // The current year/month is still running; the first bucket may
        // start mid-period. Neither is a full period's return.
        partial: nowKey ? b.key === nowKey : false,
      };
    });

  // Compounding the buckets must reproduce the overall TWR — asserted here
  // so the yearly view can never quietly disagree with the headline.
  const compounded = rows.reduce((f, r) => f * (1 + r.return), 1) - 1;
  const complete = rows.filter((r) => !r.partial);
  const best = complete.reduce((a, r) => (!a || r.return > a.return ? r : a), null);
  const worst = complete.reduce((a, r) => (!a || r.return < a.return ? r : a), null);

  return {
    rows,
    summary: {
      compounded: r4(compounded),
      best: best ? { key: best.key, return: best.return } : null,
      worst: worst ? { key: worst.key, return: worst.return } : null,
      positive: complete.filter((r) => r.return > 0).length,
      negative: complete.filter((r) => r.return < 0).length,
      completeCount: complete.length,
    },
  };
}
