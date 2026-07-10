import React, { useState, useMemo, useEffect, useRef } from "react";
import { TrendingUp, TrendingDown, AlertTriangle, PieChart, RefreshCw, CalendarClock, ListChecks, CalendarDays } from "lucide-react";
import { WRAPPERS } from "../core/portfolio.mjs";
import { mortgagesEndingSoon } from "../core/property.mjs";
import { snapshotAtOrBefore, overlaySeries } from "../core/net-worth-series.mjs";
import { accountsMaturingSoon } from "../core/cash.mjs";
import { allocationDrift } from "../core/rebalancing.mjs";
import { buildActionQueue } from "../core/action-queue.mjs";
import PlanHealthCard from "../ui/PlanHealthCard.jsx";
import {
  store, gbp, gbp0, num, pct, WrapperChip, AllocBar, KIND_LABEL, RateCell, Empty, todayISO,
} from "../ui/shared.jsx";
import { refreshAllPrices } from "../ui/priceRefresh.js";

// Labels for core/tax-year-end.mjs's checklist item ids — kept in the UI
// layer (not the pure core module) so the core module stays plain data.
const TAX_YEAR_END_LABELS = {
  isa: () => "ISA/LISA allowance unused this year",
  aea: () => "CGT annual exempt amount unused — harvest gains tax-free",
  "dividend-allowance": () => "Dividend allowance unused",
  psa: () => "Personal Savings Allowance unused",
  "pension-carry-forward": (item) => `Pension carry-forward from ${item.expiringYear} expires at this year-end`,
};

/* --------------------------- first-run experience ----------------------- */
// Shown instead of the normal (all-zero) dashboard the very first time
// someone opens the app with nothing entered anywhere — investments, cash,
// property. A brand-new user landing on a wall of "£0" and "nothing needs
// you today" has no idea what to do next; this replaces that with a short
// explanation and direct links to the three real starting points. It steps
// aside permanently the moment ANY data exists (even one manually-added
// transaction), so it's a one-time first impression, not a recurring nag.
const FIRST_RUN_ACTIONS = [
  { tab: "import", title: "Import a CSV", body: "Have an IBKR/broker export, or a spreadsheet of trades? Bring it in as a batch, with duplicate detection." },
  { tab: "ledger", title: "Add a transaction by hand", body: "Enter buys, sells and transfers one at a time — good for a handful of holdings or getting started before an import." },
  { tab: "property", title: "Add property, a mortgage, or cash", body: "Net worth isn't just investments — property equity, mortgages and named cash accounts all count." },
  { tab: "plan", title: "Explore the retirement projection", body: "Works from assumptions alone, so you can try it before any real data is entered." },
];

function FirstRunPanel({ setTab }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Welcome — let's get your numbers in</h2>
        <p className="text-sm text-[var(--muted)] mt-1 max-w-2xl">
          This dashboard tracks true net worth across every wrapper (GIA · ISA · SIPP · LISA · VCT) plus property, works out UK Capital Gains Tax to HMRC's exact share-identification rules, and projects retirement outcomes. Nothing's been entered yet — pick a starting point below; you can mix and match all four later.
        </p>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        {FIRST_RUN_ACTIONS.map((a) => (
          <button key={a.tab} onClick={() => setTab && setTab(a.tab)}
            className="text-left rounded-xl border border-[var(--border)] bg-[var(--panel2)] p-4 hover:border-[var(--accent)] transition">
            <div className="text-sm font-semibold text-[var(--accent)]">{a.title}</div>
            <div className="text-xs text-[var(--muted)] mt-1 leading-relaxed">{a.body}</div>
          </button>
        ))}
      </div>
      <p className="text-xs text-[var(--muted)]">Everything is stored locally in this browser (plus an IndexedDB mirror) — nothing is sent anywhere except live price/FX/gilt/HPI lookups you trigger. Use the download icon above to back up any time.</p>
    </div>
  );
}

function TaxYearEndBanner({ taxYearEnd, setTab }) {
  if (!taxYearEnd || !taxYearEnd.active || !taxYearEnd.items.length) return null;
  return (
    <div className="rounded-xl border p-4 space-y-2"
      style={{ background: "color-mix(in srgb, var(--accent) 8%, transparent)", borderColor: "color-mix(in srgb, var(--accent) 35%, transparent)" }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold flex items-center gap-1.5"><CalendarClock size={15} className="text-[var(--accent)]" /> Tax year-end mode — {taxYearEnd.daysLeft} day{taxYearEnd.daysLeft === 1 ? "" : "s"} left in {taxYearEnd.year}</div>
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        {taxYearEnd.items.map((item) => (
          <button key={item.id} onClick={() => setTab && setTab(item.tab)}
            className="text-left text-xs rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 hover:border-[var(--accent)]">
            <span className="font-semibold num text-[var(--accent)]">{gbp0(item.amount)}</span>
            <span className="text-[var(--muted)]"> — {(TAX_YEAR_END_LABELS[item.id] || (() => item.id))(item)}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-[var(--muted)]">Use-it-or-lose-it allowances only — none of these carry forward past 5 April (except pension annual allowance, whose oldest carried year is what's shown expiring here).</p>
    </div>
  );
}

/* ======================================================================
   HOME — the daily check-in view. Read-only by design: one headline
   number, the invested-value trend (from the automatic valuation
   snapshots), per-wrapper cards, allocation, and anything that needs
   attention (stale or missing prices). All editing lives in the
   dedicated tabs; nothing here can mutate the ledger.
   ====================================================================== */

const DAY = 86400000;
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
// (snapshotAtOrBefore moved to core/net-worth-series.mjs — one generic
// "latest record on/before this date" helper shared by both series.)

/* ---------------------------- trend chart ------------------------------ */
// Pure-SVG area chart with two selectable series and an optional index
// overlay. Time-scaled x axis (not index-scaled), so a gap in snapshots
// looks like a gap.
//  - "Net worth": the full household series (core/net-worth-series.mjs) —
//    investments + cash + property + private/RSU − liabilities, recorded
//    every day the app opens, estimated days flagged rather than skipped.
//  - "Invested": the legacy securities-only `valuations` series (exact,
//    all-priced days only — the TWR source). Kept selectable because it's
//    the longer history for existing users and the purer market signal.
// The benchmark overlay rebases an index to the first visible point —
// "how did the index move over this window", deliberately ignoring later
// contributions (see overlaySeries' honesty contract; money-vs-index
// judgement lives in the Returns tab's TWR comparison, not here).
const RANGES = [["3M", 92], ["1Y", 366], ["All", Infinity]];

function TrendChart({ valuations, snapshots }) {
  const canNetWorth = snapshots.length >= 2;
  const [range, setRange] = useState(() => store.get("cgt.home.range", "All"));
  React.useEffect(() => store.set("cgt.home.range", range), [range]);
  const [seriesMode, setSeriesMode] = useState(() => store.get("cgt.home.series", "networth"));
  React.useEffect(() => store.set("cgt.home.series", seriesMode), [seriesMode]);
  const mode = canNetWorth && seriesMode === "networth" ? "networth" : "invested";
  const source = mode === "networth" ? snapshots : valuations;

  const [showBench, setShowBench] = useState(() => store.get("cgt.home.bench", false));
  React.useEffect(() => store.set("cgt.home.bench", showBench), [showBench]);
  const benchSymbol = store.get("cgt.benchmark.symbol", "VWRL.L"); // shared with the Returns tab's picker
  const [bench, setBench] = useState(null); // { symbol, from, to, prices } | { symbol, error }
  const benchCache = useRef({});

  const pts = useMemo(() => {
    const days = (RANGES.find(([k]) => k === range) || RANGES[2])[1];
    const cutoff = days === Infinity ? "0000-00-00" : isoDaysAgo(days);
    return source.filter((v) => v.date >= cutoff);
  }, [source, range]);
  const series = pts.length >= 2 ? pts : source; // range too narrow -> fall back to all
  const first = series.length ? series[0] : null;
  const last = series.length ? series[series.length - 1] : null;

  // Fetch the benchmark for the visible span, cached per (symbol,from,to)
  // so range flips don't re-hit the proxy. Failures degrade to a small
  // inline note — never block the chart itself.
  useEffect(() => {
    if (!showBench || !first || !last || first.date === last.date) { setBench(null); return; }
    const key = `${benchSymbol}|${first.date}|${last.date}`;
    if (benchCache.current[key]) { setBench(benchCache.current[key]); return; }
    let dead = false;
    (async () => {
      try {
        const r = await fetch(`/api/benchmark?symbol=${encodeURIComponent(benchSymbol)}&from=${encodeURIComponent(first.date)}&to=${encodeURIComponent(last.date)}`);
        const j = await r.json();
        const val = r.ok ? { symbol: benchSymbol, prices: j.prices || [] } : { symbol: benchSymbol, error: j.error || `HTTP ${r.status}` };
        benchCache.current[key] = val;
        if (!dead) setBench(val);
      } catch (e) {
        if (!dead) setBench({ symbol: benchSymbol, error: e?.message || "fetch failed" });
      }
    })();
    return () => { dead = true; };
  }, [showBench, benchSymbol, first?.date, last?.date]);

  const overlay = useMemo(
    () => (showBench && bench?.prices ? overlaySeries(bench.prices, series) : []),
    [showBench, bench, series]
  );

  if (source.length < 2) {
    return (
      <div className="text-sm text-[var(--muted)] py-10 text-center">
        The trend chart appears once two daily snapshots exist — one is recorded automatically each day you open the app (even if some holdings are unpriced), so check back tomorrow.
      </div>
    );
  }

  const W = 800, H = 220, PAD_L = 8, PAD_R = 8, PAD_T = 14, PAD_B = 18;
  const t0 = +new Date(first.date), t1 = +new Date(last.date);
  const vs = [...series.map((s) => s.value), ...overlay.map((p) => p.value)];
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const padV = (hi - lo) * 0.08;
  lo -= padV; hi += padV;
  const x = (d) => PAD_L + ((+new Date(d) - t0) / Math.max(1, t1 - t0)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B);
  const pathOf = (arr) => arr.map((s, i) => `${i ? "L" : "M"}${x(s.date).toFixed(1)},${y(s.value).toFixed(1)}`).join("");
  const line = pathOf(series);
  const area = `${line}L${x(last.date).toFixed(1)},${H - PAD_B}L${x(first.date).toFixed(1)},${H - PAD_B}Z`;
  const up = last.value >= first.value;
  const estimatedDays = mode === "networth" ? series.filter((s) => s.estimated).length : 0;

  const modeLabel = mode === "networth"
    ? "Net worth (all assets − liabilities)"
    : "Invested value (securities only — cash balances have no snapshot history)";

  return (
    <div>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
        <div className="text-xs text-[var(--muted)]">
          {modeLabel} · {first.date} → {last.date}
          {estimatedDays > 0 && <span className="text-[var(--m-bb)]" title="Days where at least one holding had no price — the total carries the last known values and understates by the unpriced part."> · {estimatedDays} day{estimatedDays > 1 ? "s" : ""} estimated</span>}
        </div>
        <div className="flex gap-1 items-center flex-wrap">
          {canNetWorth && (
            <div className="flex gap-1 mr-2" role="group" aria-label="Chart series">
              {[["networth", "Net worth"], ["invested", "Invested"]].map(([k, lbl]) => (
                <button key={k} onClick={() => setSeriesMode(k)} aria-pressed={mode === k}
                  className={"px-2 py-0.5 text-xs rounded border " +
                    (mode === k ? "border-[var(--accent)] text-[var(--fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
                  {lbl}
                </button>
              ))}
            </div>
          )}
          <button onClick={() => setShowBench((b) => !b)} aria-pressed={showBench}
            title={`Overlay ${benchSymbol}, rebased to the first day shown — index movement over the same window, NOT a performance comparison (contributions are ignored; see the Returns tab for TWR vs benchmark). Change the symbol on the Returns tab.`}
            className={"px-2 py-0.5 text-xs rounded border mr-2 " +
              (showBench ? "border-[var(--m-same)] text-[var(--fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
            vs {benchSymbol}
          </button>
          {RANGES.map(([k]) => (
            <button key={k} onClick={() => setRange(k)}
              className={"px-2 py-0.5 text-xs rounded border " +
                (range === k ? "border-[var(--accent)] text-[var(--fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
              {k}
            </button>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label={`${mode === "networth" ? "Net worth" : "Invested value"} from ${gbp0(first.value)} on ${first.date} to ${gbp0(last.value)} on ${last.date}${overlay.length ? `, with ${benchSymbol} overlay` : ""}`}>
        <path d={area} fill={up ? "var(--gain)" : "var(--loss)"} opacity="0.12" />
        <path d={line} fill="none" stroke={up ? "var(--gain)" : "var(--loss)"} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {overlay.length >= 2 && (
          <path d={pathOf(overlay)} fill="none" stroke="var(--m-same)" strokeWidth="1.5" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" opacity="0.9" />
        )}
        <circle cx={x(last.date)} cy={y(last.value)} r="3.5" fill={up ? "var(--gain)" : "var(--loss)"} />
        <text x={PAD_L} y={PAD_T - 3} fontSize="11" fill="var(--muted)" className="num">{gbp0(hi)}</text>
        <text x={PAD_L} y={H - 4} fontSize="11" fill="var(--muted)" className="num">{gbp0(lo)}</text>
      </svg>
      {showBench && (
        <div className="text-xs text-[var(--muted)] mt-0.5">
          {bench?.error
            ? <>Couldn't load {benchSymbol}: {bench.error}</>
            : overlay.length >= 2
              ? <><span style={{ color: "var(--m-same)" }}>┄</span> {benchSymbol} rebased to {gbp0(overlay[0].value)} on {overlay[0].date} — index movement over this window, not a like-for-like performance comparison (your later contributions/withdrawals are ignored; the Returns tab's TWR comparison is the fair fight).</>
              : bench ? <>No {benchSymbol} data inside this window.</> : <>Loading {benchSymbol}…</>}
        </div>
      )}
    </div>
  );
}

/* ----------------------------- action queue ---------------------------- */
// Labels for core/action-queue.mjs item ids — UI layer, same pattern as
// TAX_YEAR_END_LABELS above. Each returns { head, rest } so the £ figure
// leads the line. Clicking an item can pre-select a sub-tab via a plain
// localStorage write BEFORE the tab switch (CgtSection reads its sub-tab
// key in a useState initialiser, and switching tabs remounts it).
const ACTION_LABELS = {
  "mortgage-expired": (i) => ({ head: gbp0(i.amount), rest: ` — ${i.lender} fixed rate EXPIRED, likely on SVR now. Rate-shop, then update the Property tab.` }),
  "mortgage-ending": (i) => ({ head: gbp0(i.amount), rest: ` — ${i.lender} fixed rate ends in ${i.days} days. New deals can usually be locked ~6 months ahead.` }),
  "cash-matured": (i) => ({ head: gbp0(i.amount), rest: ` — "${i.label}" fixed term has matured; it's probably earning a reversion rate. Re-fix or move it.` }),
  "cash-maturing": (i) => ({ head: gbp0(i.amount), rest: ` — "${i.label}" fixed term matures in ${i.days} days. Line up the next home for it.` }),
  "isa-headroom": (i) => ({ head: gbp0(i.amount), rest: ` — ISA allowance still unused, ${i.daysLeft} days left this tax year. Sheltered beats taxable for the same holding.` }),
  "aea-harvest": (i) => ({ head: gbp0(i.amount), rest: ` — gains harvestable within this year's CGT allowance (${gbp0(i.aeaLeft)} AEA left). Mind the 30-day rule on rebuys.` }),
  "allocation-drift": (i) => ({ head: gbp0(i.amount), rest: ` — ${i.overweight ? "overweight" : "underweight"} ${i.bucket} (${i.driftPct > 0 ? "+" : ""}${i.driftPct.toFixed(1)}pp vs target). Rebalance tax-aware, not market-timed.` }),
  "concentration": (i) => ({ head: gbp0(i.amount), rest: ` — ${i.weightPct.toFixed(0)}% of invested wealth is ${i.ticker} alone (RSU shares included). One company shouldn't be able to ruin the plan.` }),
};
// Items that land on a CGT sub-tab pre-select it.
const ACTION_SUBTAB = { "aea-harvest": "planning", "allocation-drift": "rebalance" };

function ActionQueueCard({ queue, setTab, dataLine }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-2">
      <div className="text-sm font-semibold flex items-center gap-1.5">
        <ListChecks size={15} className="text-[var(--accent)]" /> Needs a decision
      </div>
      {queue.length === 0 && (
        <div className="text-xs text-[var(--muted)] rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2">
          No money decisions pending — allowances on track, no fixes or terms ending soon.
        </div>
      )}
      {queue.map((item) => {
        const { head, rest } = (ACTION_LABELS[item.id] || (() => ({ head: gbp0(item.amount), rest: ` — ${item.id}` })))(item);
        const urgent = item.score >= 80;
        return (
          <button key={item.id + (item.label || item.lender || item.ticker || "")}
            onClick={() => { if (ACTION_SUBTAB[item.id]) store.set("cgt.cgtsubtab", ACTION_SUBTAB[item.id]); setTab && setTab(item.tab); }}
            className="text-left text-xs rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2 hover:border-[var(--accent)]">
            <span className={"font-semibold num " + (urgent ? "text-[var(--loss)]" : "text-[var(--accent)]")}>{head}</span>
            <span className="text-[var(--muted)]">{rest}</span>
          </button>
        );
      })}
      {dataLine}
    </div>
  );
}

/* --------------------------- 90-day income strip ------------------------ */
// Reuses the shell's forward income calendar (core/income-calendar.mjs) —
// a compact "what's landing soon" digest; the full table lives on the
// Income tab. Estimated (cadence-forecast) amounts are marked ≈; cash
// maturities are principal coming back, not income, so they're excluded
// from the total here (the action queue already covers them).
function IncomeStripCard({ incomeCalendar = [], setTab }) {
  const today = todayISO();
  const horizon = new Date(today + "T00:00:00Z");
  horizon.setUTCDate(horizon.getUTCDate() + 90);
  const horizonISO = horizon.toISOString().slice(0, 10);
  const events = incomeCalendar.filter((e) => e.date <= horizonISO && e.source !== "cash-maturity");
  const total = events.reduce((s, e) => s + (+e.amount || 0), 0);
  const anyEstimated = events.some((e) => e.certainty === "estimated");
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-sm font-semibold flex items-center gap-1.5"><CalendarDays size={15} className="text-[var(--accent)]" /> Income · next 90 days</div>
        <button onClick={() => setTab && setTab("income")} className="text-xs text-[var(--accent)] underline underline-offset-2 shrink-0">Calendar →</button>
      </div>
      <div className="text-lg font-semibold num">{anyEstimated ? "≈ " : ""}{gbp0(total)}</div>
      {events.length === 0 ? (
        <p className="text-xs text-[var(--muted)] mt-1 leading-relaxed">
          Nothing scheduled or forecast — coupons, recurring dividends and interest appear here once the ledger has enough history to spot their cadence.
        </p>
      ) : (
        <div className="mt-1.5 space-y-1">
          {events.slice(0, 4).map((e, idx) => (
            <div key={idx} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-[var(--muted)] truncate">
                <span className="num">{e.date.slice(5)}</span> · {e.label}
              </span>
              <span className="num shrink-0">{e.certainty === "estimated" ? "≈" : ""}{gbp0(e.amount)}</span>
            </div>
          ))}
          {events.length > 4 && <div className="text-xs text-[var(--muted)]">+ {events.length - 4} more on the Income tab</div>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ deltas -------------------------------- */
function DeltaChip({ label, from, to }) {
  if (from == null || to == null || from.value == null) return null;
  const d = to - from.value;
  const p = from.value > 0 ? d / from.value : null;
  const up = d >= 0;
  return (
    <span className={"inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded " + (up ? "text-[var(--gain)]" : "text-[var(--loss)]")}
      style={{ background: `color-mix(in srgb, var(--${up ? "gain" : "loss"}) 12%, transparent)` }}
      title={`vs ${from.date}`}>
      {up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {label}: {up ? "+" : ""}{gbp0(d)}{p != null && <span className="num">({pct(p)})</span>}
    </span>
  );
}

/* ------------------------------- home ---------------------------------- */
export default function HomeTab({
  model, valuations = [], netWorthSnapshots = [], returns, priceMeta = {}, setTab,
  netWorth, mortgages = [], taxYearEnd = null,
  cashAccounts = [], actionData = null, incomeCalendar = [], planInputs = null, concentration = null,
  // price-refresh plumbing (same engine as the Wealth/Holdings panels)
  txns = [], secMeta = {}, avKey = "", avMeta = {},
  setPrices, setPriceMeta, dmoReportDate, setDmoReportDate,
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");

  // ALL hooks must run before the null-model guard below (React's rules of
  // hooks) — so everything here is written null-safe.
  const positions = model?.positions || [];

  // Stale prices: open priced positions whose price is >3 days old.
  // Pension/LISA fund units (secMeta kind "fund") are excluded — there is no
  // live source for them at all (insurer-administered, not exchange-traded;
  // see LivePricesPanel/refreshAllPrices, which skip them for the same
  // reason), so "Refresh prices" can never bring their `asOf` current and
  // this warning would otherwise nag permanently for entirely manual data
  // that isn't actually wrong, just not date-stamped by a live quote.
  const staleTickers = useMemo(() => {
    const open = new Set(positions.filter((p) => p.priced && secMeta[p.ticker]?.kind !== "fund").map((p) => p.ticker));
    const limit = isoDaysAgo(3);
    return [...open].filter((tk) => {
      const asOf = priceMeta[tk]?.asOf;
      return asOf && asOf.slice(0, 10) < limit;
    }).sort();
  }, [model, priceMeta, secMeta]);
  // Doesn't depend on `model` at all, but every hook still has to run before
  // the early-return guard below (rules of hooks) — this file has already
  // been bitten once by a memo placed after an early return (see README).
  const mortgagesSoon = useMemo(() => mortgagesEndingSoon(mortgages, todayISO(), 180), [mortgages]);
  const cashMaturing = useMemo(() => accountsMaturingSoon(cashAccounts, todayISO(), 90), [cashAccounts]);
  // Rebalance targets are owned by the CGT tab's Rebalance sub-tab (same
  // localStorage key). Read once per mount — Home remounts on every tab
  // switch, so a target edited over there is always fresh by the time
  // anyone is back here looking at the queue.
  const rebalanceTargets = useMemo(() => store.get("cgt.rebalance.targets", {}), []);
  const drift = useMemo(
    () => allocationDrift({ positions, targets: rebalanceTargets }),
    [model, rebalanceTargets] // positions derives from model
  );
  const queue = useMemo(() => buildActionQueue({
    today: todayISO(),
    hasIsaWrapper: ["ISA", "LISA"].some((w) => {
      const agg = model?.byWrapper?.[w];
      return agg && (agg.positions > 0 || agg.cash > 0);
    }),
    isaSubscribed: actionData?.isaSubscribed ?? 0,
    aeaLeft: actionData?.aeaLeft ?? 0,
    harvestable: actionData?.harvestable ?? 0,
    driftRows: drift.rows, targetsSumTo100: drift.targetsSumTo100,
    mortgagesSoon, cashMaturing,
    concentrationAlerts: concentration?.alerts ?? [],
    taxYearEndActive: !!(taxYearEnd && taxYearEnd.active),
  }), [model, actionData, drift, mortgagesSoon, cashMaturing, concentration, taxYearEnd]);

  if (!model) return <Empty msg="Couldn't build the portfolio model — check the Transactions tab for ledger errors." />;
  const { byWrapper, total } = model;

  const openTickers = [...new Set(positions.filter((p) => p.qty > 1e-9).map((p) => p.ticker))];
  const canRefresh = !!setPrices && !!setPriceMeta && openTickers.length > 0;
  const doRefresh = async () => {
    if (!canRefresh || refreshing) return;
    setRefreshing(true); setRefreshMsg("");
    const res = await refreshAllPrices({
      tickers: openTickers, txns, secMeta, avMeta, avKey, dmoReportDate,
      setPrices, setPriceMeta, setDmoReportDate, onProgress: setRefreshMsg,
    });
    setRefreshMsg(res.message);
    setRefreshing(false);
  };

  const last = valuations.length ? valuations[valuations.length - 1] : null;
  const investedNow = total.unpriced > 0 ? null : total.marketValue;
  // Headline deltas track the same quantity as the headline: full net worth
  // once its series exists (today's record is written by the shell's effect,
  // so "prev" = the latest record BEFORE today), falling back to the legacy
  // invested-only deltas for anyone whose net-worth series is <2 days old.
  const nwLast = netWorthSnapshots.length ? netWorthSnapshots[netWorthSnapshots.length - 1] : null;
  const useNwDeltas = netWorthSnapshots.length >= 2 && nwLast;
  const deltaTo = useNwDeltas ? nwLast.value : investedNow;
  const deltaPrev = useNwDeltas
    ? snapshotAtOrBefore(netWorthSnapshots, isoDaysAgo(1))
    : (valuations.length > 1 ? valuations[valuations.length - 2] : null);
  const delta30 = snapshotAtOrBefore(useNwDeltas ? netWorthSnapshots : valuations, isoDaysAgo(30));

  const wrappersPresent = WRAPPERS.filter((w) => byWrapper[w] && (byWrapper[w].positions > 0 || byWrapper[w].cash > 0));
  // Property/liabilities haven't been entered for most existing users, in
  // which case netWorth.netWorth === total.total exactly (zero property
  // equity, zero other liabilities) — the breakdown line only earns its
  // place once there's something to break down.
  const hasBalanceSheetExtras = !!netWorth && (netWorth.propertyValue > 0 || netWorth.otherLiabilities > 0 || netWorth.privateValue > 0 || netWorth.rsuValue > 0 || netWorth.creditCardDebt > 0);
  const headlineValue = netWorth ? netWorth.netWorth : total.total;

  // Truly nothing entered anywhere (investments, cash, property/liabilities)
  // -> first-run welcome instead of a wall of zeroes. Falls away permanently
  // the moment any of these becomes non-zero.
  const isFirstRun = positions.length === 0 && total.cash === 0 && !hasBalanceSheetExtras;
  if (isFirstRun) return <FirstRunPanel setTab={setTab} />;

  return (
    <div className="grid gap-4">
      <TaxYearEndBanner taxYearEnd={taxYearEnd} setTab={setTab} />

      {/* headline + trend */}
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
          <div className="text-sm text-[var(--muted)]">{hasBalanceSheetExtras ? "Net worth (assets − liabilities)" : "Total wealth (holdings + cash, all wrappers)"}</div>
          <div className="flex items-baseline gap-3 flex-wrap mt-1">
            <div className="text-3xl font-semibold num">{gbp0(headlineValue)}</div>
            {deltaTo != null && <DeltaChip label="1d" from={deltaPrev} to={deltaTo} />}
            {deltaTo != null && <DeltaChip label="30d" from={delta30} to={deltaTo} />}
          </div>
          {hasBalanceSheetExtras && (
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[var(--muted)] mt-1.5 num">
              <span>Investments + cash <span className="font-medium text-[var(--fg)]">{gbp0(total.total)}</span></span>
              <span>Property equity <span className="font-medium text-[var(--fg)]">{gbp0(netWorth.propertyEquity)}</span></span>
              {netWorth.privateValue > 0 && <span>Private holdings <span className="font-medium text-[var(--fg)]">{gbp0(netWorth.privateValue)}</span></span>}
              {netWorth.rsuValue > 0 && <span>RSU holdings <span className="font-medium text-[var(--fg)]">{gbp0(netWorth.rsuValue)}</span></span>}
              {netWorth.otherLiabilities > 0 && <span>Other liabilities <span className="font-medium text-[var(--loss)]">−{gbp0(netWorth.otherLiabilities)}</span></span>}
              {netWorth.creditCardDebt > 0 && <span>Credit cards <span className="font-medium text-[var(--loss)]">−{gbp0(netWorth.creditCardDebt)}</span></span>}
            </div>
          )}
          {total.unpriced > 0 && (
            <div className="text-xs text-[var(--m-bb)] mt-1 flex items-center gap-1">
              <AlertTriangle size={12} />
              {total.unpriced} holding{total.unpriced > 1 ? "s" : ""} unpriced ({total.unpricedTickers.join(", ")}) — excluded from market value, so this understates the true total.
            </div>
          )}
          <div className="mt-3">
            <TrendChart valuations={valuations} snapshots={netWorthSnapshots} />
          </div>
        </div>

        {/* action queue — MONEY decisions, ranked (core/action-queue.mjs).
            Data plumbing (stale/unpriced prices, refresh) is deliberately
            demoted to the single status line at the bottom of this card:
            "your money needs a decision" and "the app would like a refresh
            click" are different classes of message. */}
        <ActionQueueCard queue={queue} setTab={setTab} dataLine={
          <div className="mt-auto pt-2 border-t border-[var(--border)]">
            <div className="flex items-start justify-between gap-2">
              <div className="text-xs text-[var(--muted)] leading-snug">
                {refreshMsg || (
                  <>
                    {staleTickers.length > 0 || total.unpriced > 0 ? (
                      <>
                        {staleTickers.length > 0 && <>{staleTickers.length} price{staleTickers.length > 1 ? "s" : ""} &gt;3d old</>}
                        {staleTickers.length > 0 && total.unpriced > 0 && " · "}
                        {total.unpriced > 0 && <button onClick={() => setTab && setTab("wealth")} className="underline underline-offset-2 hover:text-[var(--fg)]">{total.unpriced} unpriced</button>}
                      </>
                    ) : (
                      <>Prices fresh{last ? ` · snapshot ${last.date}` : ""}</>
                    )}
                  </>
                )}
              </div>
              {canRefresh && (
                <button onClick={doRefresh} disabled={refreshing}
                  className="shrink-0 inline-flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--fg)] disabled:opacity-50"
                  title="Fetch fresh prices for every open holding — DMO for gilts, Yahoo then Alpha Vantage for the rest (pension fund units stay manual)">
                  <RefreshCw size={11} className={refreshing ? "animate-spin" : ""} aria-hidden="true" /> Refresh
                </button>
              )}
            </div>
          </div>
        } />
      </div>

      {/* plan health · upcoming income · allocation */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <PlanHealthCard planInputs={planInputs} onOpenPlan={() => setTab && setTab("plan")} />
        <IncomeStripCard incomeCalendar={incomeCalendar} setTab={setTab} />
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3">
          <div className="text-sm font-semibold flex items-center gap-1.5"><PieChart size={15} className="text-[var(--accent)]" /> Allocation</div>
          <AllocBar title="By asset class" buckets={model.allocation.assetClass} labelOf={(k) => KIND_LABEL[k] || k} />
          <AllocBar title="By wrapper" buckets={model.allocation.wrapper} />
        </div>
      </div>

      {/* wrapper strip */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
        {wrappersPresent.map((w) => {
          const agg = byWrapper[w];
          const r = returns?.byWrapper?.[w];
          const gain = agg.priced > 0 ? agg.unrealised : null;
          return (
            <div key={w} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
              <div className="flex items-center justify-between">
                <WrapperChip wrapper={w} />
                {r?.xirr && <span className="text-xs" title="Money-weighted return (XIRR), annualised"><RateCell r={r.xirr} /></span>}
              </div>
              <div className="text-lg font-semibold num mt-1.5">{gbp0(agg.total)}</div>
              <div className="text-xs text-[var(--muted)] num">
                {agg.positions > 0 && <>{agg.positions} holding{agg.positions > 1 ? "s" : ""}</>}
                {agg.cash > 0 && <>{agg.positions > 0 ? " · " : ""}cash {gbp0(agg.cash)}</>}
              </div>
              {gain != null && (
                <div className={"text-xs num mt-0.5 " + (gain >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}
                  title={`Unrealised gain on book cost of ${gbp(agg.bookCostPriced)}`}>
                  {gain >= 0 ? "+" : ""}{gbp0(gain)}{agg.bookCostPriced > 0 && ` (${num((gain / agg.bookCostPriced) * 100, 1)}%)`}
                </div>
              )}
              {agg.unpriced > 0 && <div className="text-xs text-[var(--m-bb)]">{agg.unpriced} unpriced</div>}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-[var(--muted)]">
        Read-only overview as of {todayISO()}. Prices update from the Wealth tab; cash balances from Pension &amp; LISA / Wealth. The chart's "Net worth" series records daily from whatever you've entered (estimated days flagged); "Invested" is the exact securities-only series used for TWR.
      </p>
    </div>
  );
}
