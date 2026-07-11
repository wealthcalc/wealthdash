/* ======================================================================
   EXPOSURE & CONCENTRATION — the "how many eggs, how few baskets" module.

   Two jobs:
   1. concentration(): top-holding / top-5 weights, HHI and its reciprocal
      ("effective number of holdings" — a portfolio of 20 lines where one
      is 60% behaves like ~2.6 holdings, and this number says so), plus
      single-stock alerts. Individual equities only for alerts — a 40%
      position in a global tracker is a choice, a 40% position in one
      company is a risk, and the distinction is the whole point. RSU-held
      employer shares are folded in via `extras` and MERGED with any
      ledger position in the same ticker, because employer stock split
      across "RSU tab" and "GIA holding" is still one company risk.
   2. exposureByTag(): market value rolled up by a hand-tagged secMeta
      field ("region" / "sector") — look-through v0. The app's domicile
      "geography" is honest but nearly useless for diversification (an
      Irish-domiciled world ETF reports as Ireland); a hand tag is the
      user's own claim about what a fund actually holds. Untagged value
      is surfaced as its own bucket, never hidden or redistributed —
      same "don't fabricate precision" principle as everywhere else.
      Real factsheet-driven look-through stays a Phase 2 item.

   Pure and node-tested (exposure.test.mjs).
   ====================================================================== */

export const CONCENTRATION_ALERT = 0.10; // 10% of priced wealth in ONE company

const r2 = (x) => Math.round(x * 100) / 100;

// positions: buildWealthModel().positions (uses .priced/.marketValue/.kind).
// extras: [{ ticker, value, kind = "equity", label }] — e.g. RSU-held
// shares valued by the RSU module, which live outside `positions`.
export function concentration({ positions = [], extras = [], alertThreshold = CONCENTRATION_ALERT } = {}) {
  const byTicker = new Map();
  const addRow = (ticker, value, kind, label) => {
    if (!ticker || !(value > 0)) return;
    const cur = byTicker.get(ticker) || { ticker, value: 0, kind, label };
    cur.value += value;
    if (kind === "equity") cur.kind = "equity"; // equity risk dominates a merge
    byTicker.set(ticker, cur);
  };
  for (const p of positions) if (p.priced) addRow(p.ticker, p.marketValue, p.kind || "unknown");
  for (const e of extras) addRow(e.ticker, +e.value || 0, e.kind || "equity", e.label);

  const rows = [...byTicker.values()].sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (total <= 0) return { total: 0, rows: [], top1: null, top5Weight: 0, hhi: 0, effectiveN: 0, alerts: [] };

  for (const r of rows) r.weight = r.value / total;
  const hhi = rows.reduce((s, r) => s + r.weight * r.weight, 0);
  return {
    total: r2(total),
    rows,
    top1: { ticker: rows[0].ticker, weight: rows[0].weight },
    top5Weight: rows.slice(0, 5).reduce((s, r) => s + r.weight, 0),
    hhi,
    effectiveN: 1 / hhi,
    alerts: rows
      .filter((r) => r.kind === "equity" && r.weight >= alertThreshold)
      .map((r) => ({ ticker: r.ticker, value: r2(r.value), weight: r.weight })),
  };
}

// Roll priced market value up by a hand-tagged secMeta field. Tags are
// free text, trimmed; empty/missing lands in "untagged" (kept visible).
export function exposureByTag({ positions = [], secMeta = {}, field } = {}) {
  const buckets = new Map();
  let total = 0, untaggedValue = 0, untaggedCount = 0;
  const seenUntagged = new Set();
  for (const p of positions) {
    if (!p.priced || !(p.marketValue > 0)) continue;
    const tag = String(secMeta[p.ticker]?.[field] || "").trim();
    const key = tag || "untagged";
    if (!tag) { untaggedValue += p.marketValue; if (!seenUntagged.has(p.ticker)) { seenUntagged.add(p.ticker); untaggedCount++; } }
    buckets.set(key, (buckets.get(key) || 0) + p.marketValue);
    total += p.marketValue;
  }
  return {
    buckets: [...buckets.entries()]
      .map(([key, marketValue]) => ({ key, marketValue: r2(marketValue), pct: total > 0 ? marketValue / total : 0 }))
      .sort((a, b) => b.marketValue - a.marketValue),
    total: r2(total),
    untaggedValue: r2(untaggedValue),
    untaggedCount,
    untaggedPct: total > 0 ? untaggedValue / total : 0,
  };
}
