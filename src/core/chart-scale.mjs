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
