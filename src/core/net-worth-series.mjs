/* ======================================================================
   NET-WORTH SNAPSHOT SERIES — a daily history of TRUE household net worth
   (investments + cash + property equity + private + RSU − liabilities),
   the number the Home headline already shows but until now never recorded.

   Why a NEW series instead of extending `valuations`: `valuations` is the
   securities-only, all-positions-priced series that makes an EXACT
   portfolio-level TWR possible (core/returns.mjs) — its whole value is
   that it is never recorded from stale or missing prices. This series has
   the opposite contract: record something honest EVERY day the app is
   opened, even when a price is stale or a holding is unpriced, because a
   net-worth trend with gaps every time one pension fund lacks a quote is
   useless as a trend. The two contracts are incompatible in one array, so
   they don't share one. Records where any open position had no price at
   all carry `estimated: true` + the count, and the UI is expected to say
   so — same "don't fabricate precision, don't hide the caveat" principle
   as gilts/XIRR/property throughout the app.

   Pure and node-tested (net-worth-series.test.mjs). One record per day,
   last write wins, exactly like the valuations effect in CgtDashboard.
   ====================================================================== */

const r2 = (x) => Math.round((+x || 0) * 100) / 100;

// Shape one day's record from the two aggregates the shell already
// computes: `total` (buildWealthModel().total) and `netWorth`
// (householdNetWorth()'s output). Returns null when there is genuinely
// nothing to record (a first-run, all-zero state — recording £0 rows
// would draw a misleading flatline predating the user's real data).
export function buildNetWorthSnapshot({ date, total, netWorth }) {
  if (!date || !total || !netWorth) return null;
  const rec = {
    date,
    value: r2(netWorth.netWorth),
    invested: r2(total.marketValue),
    cash: r2(total.cash),
    propertyEquity: r2(netWorth.propertyEquity),
    privateValue: r2(netWorth.privateValue),
    rsuValue: r2(netWorth.rsuValue),
    liabilities: r2((netWorth.otherLiabilities || 0) + (netWorth.creditCardDebt || 0)),
    estimated: (total.unpriced || 0) > 0,
    unpriced: total.unpriced || 0,
  };
  const anything =
    rec.value !== 0 || rec.invested !== 0 || rec.cash !== 0 ||
    rec.propertyEquity !== 0 || rec.privateValue !== 0 || rec.rsuValue !== 0 || rec.liabilities !== 0;
  return anything ? rec : null;
}

// Upsert into the series: one record per date, last write wins, kept
// sorted. Returns the ORIGINAL array reference when the incoming record
// is identical to the one already stored for that date, so callers'
// setState bails without persist/re-render churn (same convention as the
// valuations effect).
export function upsertDailySnapshot(series = [], record) {
  if (!record) return series;
  const existing = series.find((s) => s.date === record.date);
  if (existing && Object.keys(record).every((k) => existing[k] === record[k])
    && Object.keys(existing).length === Object.keys(record).length) return series;
  return [...series.filter((s) => s.date !== record.date), record]
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Latest record dated on/before `dateISO`, or null — the "what was it a
// month ago" lookup for delta chips. Series must be sorted (upsert keeps
// it so).
export function snapshotAtOrBefore(series = [], dateISO) {
  let hit = null;
  for (const s of series) { if (s.date <= dateISO) hit = s; else break; }
  return hit;
}

// Scale a benchmark close series onto a £ value series for overlay:
// benchmark closes are rebased so the first close on/after the value
// series' first date equals the series' first value ("if the whole
// starting balance had been the index instead"). HONESTY CONTRACT: this
// deliberately ignores every later contribution/withdrawal — it answers
// "how did the index move over the same window", not "did I beat it"
// (that's money-weighted vs time-weighted, and the Returns tab's TWR
// comparison is the right tool for it). The UI must caption it as such.
// Returns [] when there's nothing to overlay (no overlap, zero first
// close/value).
export function overlaySeries(benchmarkPrices = [], valueSeries = []) {
  if (!benchmarkPrices.length || valueSeries.length < 2) return [];
  const from = valueSeries[0].date, to = valueSeries[valueSeries.length - 1].date;
  const inRange = benchmarkPrices
    .filter((p) => p.date >= from && p.date <= to && Number.isFinite(+p.close) && +p.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const startValue = +valueSeries[0].value;
  if (!inRange.length || !(startValue > 0)) return [];
  const base = +inRange[0].close;
  return inRange.map((p) => ({ date: p.date, value: r2((+p.close / base) * startValue) }));
}
