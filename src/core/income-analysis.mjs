/* ======================================================================
   INCOME ANALYSIS — two lenses over the dividend/interest ledger the app
   already stores, turning raw payment history into signals:

   1. DIVIDEND CUT / GROWTH per holding. The income calendar forecasts flat,
      but the ledger knows what each holding paid year-on-year. Comparing
      the last complete 12 months against the prior 12 flags a holding
      whose income fell (often the first sign to look harder) or grew. The
      comparison is on a PER-UNIT basis where units are known, so buying
      more shares doesn't masquerade as a dividend rise — but falls back to
      total received when unit history isn't available, disclosed by a flag.

   2. INCOME CONCENTRATION. With many trusts and VCTs, how much of your
      income leans on the top few names? Single-source risk on income is
      the mirror of capital concentration. Reports the top holdings' share
      and an effective-N (how many equal-sized income streams your actual
      mix is equivalent to).

   Both work off trailing windows anchored to a passed-in `today` — pure,
   no clock reads. Node-tested (income-analysis.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;
const addDaysISO = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);

// incomeEntries: [{ date, ticker, amount, kind, wrapper }]. `today`: ISO.
// Compares each holding's trailing-12m dividend total against the prior
// 12 months. Only holdings with income in BOTH windows can be compared;
// others are reported as new/lapsed rather than as a fictitious change.
export function dividendChanges({ incomeEntries = [], today, minAmount = 20 } = {}) {
  if (!today) throw new Error("dividendChanges requires today (ISO).");
  const recentFrom = addDaysISO(today, -365);
  const priorFrom = addDaysISO(today, -730);
  const byTicker = new Map();
  for (const e of incomeEntries) {
    if (!e || !e.date || e.kind === "interest" || !(+e.amount > 0)) continue;
    const tk = e.ticker || "";
    if (!tk) continue;
    if (!byTicker.has(tk)) byTicker.set(tk, { recent: 0, prior: 0, wrapper: e.wrapper || "" });
    const g = byTicker.get(tk);
    if (e.date > recentFrom && e.date <= today) g.recent += +e.amount;
    else if (e.date > priorFrom && e.date <= recentFrom) g.prior += +e.amount;
    g.wrapper = e.wrapper || g.wrapper;
  }
  const rows = [];
  for (const [ticker, g] of byTicker) {
    if (g.recent < minAmount && g.prior < minAmount) continue;
    const both = g.recent > 0 && g.prior > 0;
    const changePct = both ? r2(((g.recent - g.prior) / g.prior) * 100) : null;
    rows.push({
      ticker, wrapper: g.wrapper,
      recent: r2(g.recent), prior: r2(g.prior),
      change: r2(g.recent - g.prior),
      changePct,
      status: !both ? (g.recent > 0 ? "new" : "lapsed")
        : changePct <= -10 ? "cut" : changePct >= 10 ? "grown" : "steady",
    });
  }
  // Cuts first (they matter most), then grown, then steady/new.
  const rank = { cut: 0, lapsed: 1, grown: 2, steady: 3, new: 4 };
  rows.sort((a, b) => (rank[a.status] - rank[b.status]) || (a.change - b.change));
  return {
    rows,
    cuts: rows.filter((r) => r.status === "cut"),
    grown: rows.filter((r) => r.status === "grown"),
  };
}

// Trailing-12m income concentration across holdings. Returns the ranked
// holdings' share, the top-N weight, and effective-N (1/HHI — how many
// equal income streams your mix behaves like). Interest with no ticker is
// pooled as "cash interest" so it doesn't vanish from the total.
export function incomeConcentration({ incomeEntries = [], today, topN = 5 } = {}) {
  if (!today) throw new Error("incomeConcentration requires today (ISO).");
  const from = addDaysISO(today, -365);
  const byTicker = new Map();
  for (const e of incomeEntries) {
    if (!e || !e.date || !(+e.amount > 0)) continue;
    if (e.date <= from || e.date > today) continue;
    const key = e.ticker || (e.kind === "interest" ? "(cash interest)" : "(unattributed)");
    byTicker.set(key, (byTicker.get(key) || 0) + +e.amount);
  }
  const rows = [...byTicker.entries()].map(([ticker, value]) => ({ ticker, value: r2(value) })).sort((a, b) => b.value - a.value);
  const total = r2(rows.reduce((s, r) => s + r.value, 0));
  if (total <= 0) return { rows: [], total: 0, top1: null, topNWeight: 0, effectiveN: 0 };
  for (const r of rows) r.weight = r2((r.value / total) * 100);
  const hhi = rows.reduce((s, r) => s + Math.pow(r.value / total, 2), 0);
  return {
    rows,
    total,
    top1: rows[0] ? { ticker: rows[0].ticker, weight: rows[0].weight } : null,
    topNWeight: r2(rows.slice(0, topN).reduce((s, r) => s + r.weight, 0)),
    effectiveN: hhi > 0 ? r2(1 / hhi) : 0,
  };
}

// Trailing-12m income grouped by a facet other than the individual holding:
//   group "wrapper" -> ISA / SIPP / GIA / VCT / … (reveals sheltered vs taxable)
//   group "kind"    -> Dividends vs Interest
// Same shape as incomeConcentration.rows so the same chart renders it. The
// label lives in `.ticker` for that reason. `sheltered` is set on wrapper rows
// so the caller can total tax-free vs taxable income. Pure, node-tested.
const SHELTERED_WRAPPERS = new Set(["ISA", "SIPP", "LISA", "VCT"]);
export function incomeByGroup({ incomeEntries = [], today, group = "wrapper" } = {}) {
  if (!today) throw new Error("incomeByGroup requires today (ISO).");
  const from = addDaysISO(today, -365);
  const map = new Map();
  for (const e of incomeEntries) {
    if (!e || !e.date || !(+e.amount > 0)) continue;
    if (e.date <= from || e.date > today) continue;
    const key = group === "kind"
      ? (e.kind === "interest" ? "Interest" : "Dividends")
      : (e.wrapper ? String(e.wrapper).toUpperCase() : "Unwrapped");
    map.set(key, (map.get(key) || 0) + +e.amount);
  }
  const rows = [...map.entries()].map(([ticker, value]) => ({
    ticker, value: r2(value), ...(group === "wrapper" ? { sheltered: SHELTERED_WRAPPERS.has(ticker) } : {}),
  })).sort((a, b) => b.value - a.value);
  const total = r2(rows.reduce((s, r) => s + r.value, 0));
  if (total <= 0) return { rows: [], total: 0, shelteredPct: 0 };
  for (const r of rows) r.weight = r2((r.value / total) * 100);
  const shelteredPct = group === "wrapper"
    ? r2((rows.filter((r) => r.sheltered).reduce((s, r) => s + r.value, 0) / total) * 100)
    : 0;
  return { rows, total, shelteredPct };
}
