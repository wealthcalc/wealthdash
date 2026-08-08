/* ======================================================================
   CHART SCALE — turning a raw data range into an axis a person can read.

   A value chart with only its min and max labelled shows shape but not
   scale: you can see the line rose, not what it rose to. Gridlines fix
   that, but only if they sit on numbers a human would have chosen. An axis
   reading 847,213 / 903,559 / 959,905 is arithmetically even and useless.

   So ticks snap to 1, 2, 2.5 or 5 times a power of ten — the steps people
   actually count in — and stay strictly inside the data's range so a
   gridline never implies a value the chart doesn't cover.
   Pure and node-tested (chart-scale.test.mjs).
   ====================================================================== */
/* Compact axis label for a value, given the STEP between gridlines.

   The step matters because precision has to be enough to keep adjacent
   labels distinct. At a £50k step, one decimal renders 1,150,000 and
   1,200,000 as "£1.2m" and "£1.2m" — an axis that reads as though it
   doesn't move. Millions therefore carry two decimals as standard, and
   thousands gain decimals when the step is finer than £1k.

   Deliberately abbreviated rather than exact: the full figure belongs in
   the headline, not repeated four times down the side of a chart. */
export function axisLabel(v, step = 0) {
  const a = Math.abs(v);
  const s = Math.abs(+step) || 0;
  if (a >= 1e6 || (s > 0 && s >= 1e6)) {
    // Two decimals by default so a fine step can't produce repeated labels;
    // more only if the step is finer still.
    const dp = s > 0 && s < 1e4 ? 3 : 2;
    return `£${(v / 1e6).toFixed(dp)}m`;
  }
  if (a >= 1e3) {
    const dp = s > 0 && s < 100 ? 2 : s > 0 && s < 1e3 ? 1 : 0;
    return `£${(v / 1e3).toFixed(dp)}k`;
  }
  return `£${Math.round(v)}`;
}

export function niceTicks(lo, hi, count = 4) {
  const span = hi - lo;
  if (!Number.isFinite(span) || span <= 0) return Number.isFinite(lo) ? [lo] : [];
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 2 ? 2.5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
