import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKET_HISTORY, HISTORY_FROM, HISTORY_TO, historyPairs } from "../core/market-history.mjs";
import { sequenceHeatmap, replayWindow, MIN_PARTIAL_YEARS } from "../core/sequence-heatmap.mjs";

test("market history: 100 contiguous years, sane values, landmark years correct", () => {
  const pairs = historyPairs();
  assert.equal(HISTORY_FROM, 1926);
  assert.equal(HISTORY_TO, 2025);
  assert.equal(pairs.length, 100);
  for (let i = 1; i < pairs.length; i++) assert.equal(pairs[i].year, pairs[i - 1].year + 1, "contiguous");
  for (const p of pairs) {
    assert.ok(p.ret > -60 && p.ret < 70, `return sane ${p.year}`);
    assert.ok(p.infl > -15 && p.infl < 25, `inflation sane ${p.year}`);
  }
  // spot-check transcription against the fetched source
  assert.deepEqual(MARKET_HISTORY[1931], [-43.34, -9.32]);
  assert.deepEqual(MARKET_HISTORY[1974], [-26.47, 12.34]);
  assert.deepEqual(MARKET_HISTORY[2008], [-37.00, 0.09]);
  assert.deepEqual(MARKET_HISTORY[2022], [-18.11, 6.45]);
});

// Hand-built plan surface: £1m pot, 30 years of withdrawals starting at
// 5.5% and uprated 3%/yr nominal (the deterministic schedule shape).
const P = { retireAge: 65, growthPost: 4.5, fee: 0.4, inflation: 3, inflMode: "cpi", rpiWedge: 1 };
const DET = {
  wealthAtRetire: 1000000,
  withdrawSchedule: Array.from({ length: 30 }, (_, i) => 55000 * Math.pow(1.03, i)),
};

test("heatmap covers every start year with enough history; partials flagged", () => {
  const { windows, summary } = sequenceHeatmap(P, DET);
  // full windows: starts 1926..1996 (30-year horizons) = 71
  assert.equal(summary.fullWindows, 71);
  // partial: starts 1997..(2025-15+1=2011) get assumption tails, ≥15 hist years
  assert.equal(summary.partialWindows, windows.length - 71);
  assert.ok(windows.every((w) => w.histYears >= Math.min(30, MIN_PARTIAL_YEARS)));
  assert.equal(windows[0].startYear, 1926);
});

test("the classic result: 1966-style starts fail, mid-1970s starts survive", () => {
  const { windows } = sequenceHeatmap(P, DET);
  const byYear = Object.fromEntries(windows.map((w) => [w.startYear, w]));
  assert.equal(byYear[1966].lasts, false, "retiring into stagflation at 5.5% should fail");
  assert.equal(byYear[1929].lasts, false, "retiring into the Depression at 5.5% should fail");
  assert.equal(byYear[1975].lasts, true, "retiring into the recovery should survive");
  assert.equal(byYear[1982].lasts, true, "retiring into the 80s bull should survive");
});

test("inflation re-pricing matters: 1966 window depletes EARLIER than a fixed-inflation replay would", () => {
  const pairs = historyPairs();
  const idx1966 = pairs.findIndex((x) => x.year === 1966);
  const real = replayWindow(P, DET, pairs, idx1966);
  // same returns, but inflation pinned to the plan's 3% (strip the infl series)
  const pinned = pairs.map((x) => ({ ...x, infl: 3 }));
  const fixed = replayWindow(P, DET, pinned, idx1966);
  assert.ok(real.depletion !== null);
  assert.ok(fixed.depletion === null || fixed.depletion > real.depletion,
    `historical inflation should bite: real ${real.depletion} vs pinned ${fixed.depletion}`);
});

test("summary picks the worst full-window start; success rate is full-windows-only", () => {
  const { summary } = sequenceHeatmap(P, DET);
  assert.ok(summary.successRate > 0 && summary.successRate < 1);
  assert.ok(summary.worstStart >= 1926 && summary.worstStart <= 1996);
  assert.ok(summary.worstDepletionAge >= P.retireAge);
});

test("degenerate inputs return empty, not a crash", () => {
  assert.equal(sequenceHeatmap(P, { wealthAtRetire: 0, withdrawSchedule: [] }).summary, null);
});
