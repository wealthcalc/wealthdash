import React, { useState, useMemo } from "react";
import { TrendingUp, TrendingDown, AlertTriangle, PieChart } from "lucide-react";
import { WRAPPERS } from "../core/portfolio.mjs";
import {
  store, gbp, gbp0, num, pct, WrapperChip, AllocBar, KIND_LABEL, RateCell, Empty, todayISO,
} from "../ui/shared.jsx";

/* ======================================================================
   HOME — the daily check-in view. Read-only by design: one headline
   number, the invested-value trend (from the automatic valuation
   snapshots), per-wrapper cards, allocation, and anything that needs
   attention (stale or missing prices). All editing lives in the
   dedicated tabs; nothing here can mutate the ledger.
   ====================================================================== */

const DAY = 86400000;
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
// Latest snapshot dated on/before `dateISO`, or null.
const snapshotAtOrBefore = (valuations, dateISO) => {
  let hit = null;
  for (const v of valuations) { if (v.date <= dateISO) hit = v; else break; }
  return hit;
};

/* ------------------------- invested-value chart ----------------------- */
// Pure-SVG area chart over the securities-only valuation series the app
// already records each day all holdings are priced. Time-scaled x axis
// (not index-scaled), so a gap in snapshots looks like a gap.
const RANGES = [["3M", 92], ["1Y", 366], ["All", Infinity]];

function NetWorthChart({ valuations }) {
  const [range, setRange] = useState(() => store.get("cgt.home.range", "All"));
  React.useEffect(() => store.set("cgt.home.range", range), [range]);

  const pts = useMemo(() => {
    const days = (RANGES.find(([k]) => k === range) || RANGES[2])[1];
    const cutoff = days === Infinity ? "0000-00-00" : isoDaysAgo(days);
    return valuations.filter((v) => v.date >= cutoff);
  }, [valuations, range]);

  if (valuations.length < 2) {
    return (
      <div className="text-sm text-[var(--muted)] py-10 text-center">
        The trend chart appears once two daily valuation snapshots exist.
        Snapshots are recorded automatically whenever every holding is priced — fetch prices today and check back tomorrow.
      </div>
    );
  }
  const series = pts.length >= 2 ? pts : valuations; // range too narrow -> fall back to all
  const W = 800, H = 220, PAD_L = 8, PAD_R = 8, PAD_T = 14, PAD_B = 18;
  const t0 = +new Date(series[0].date), t1 = +new Date(series[series.length - 1].date);
  const vs = series.map((s) => s.value);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const padV = (hi - lo) * 0.08;
  lo -= padV; hi += padV;
  const x = (d) => PAD_L + ((+new Date(d) - t0) / Math.max(1, t1 - t0)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B);
  const line = series.map((s, i) => `${i ? "L" : "M"}${x(s.date).toFixed(1)},${y(s.value).toFixed(1)}`).join("");
  const area = `${line}L${x(series[series.length - 1].date).toFixed(1)},${H - PAD_B}L${x(series[0].date).toFixed(1)},${H - PAD_B}Z`;
  const last = series[series.length - 1], first = series[0];
  const up = last.value >= first.value;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs text-[var(--muted)]">
          Invested value (securities only — cash balances have no snapshot history) · {first.date} → {last.date}
        </div>
        <div className="flex gap-1">
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
        aria-label={`Invested value from ${gbp0(first.value)} on ${first.date} to ${gbp0(last.value)} on ${last.date}`}>
        <path d={area} fill={up ? "var(--gain)" : "var(--loss)"} opacity="0.12" />
        <path d={line} fill="none" stroke={up ? "var(--gain)" : "var(--loss)"} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <circle cx={x(last.date)} cy={y(last.value)} r="3.5" fill={up ? "var(--gain)" : "var(--loss)"} />
        <text x={PAD_L} y={PAD_T - 3} fontSize="11" fill="var(--muted)" className="num">{gbp0(hi)}</text>
        <text x={PAD_L} y={H - 4} fontSize="11" fill="var(--muted)" className="num">{gbp0(lo)}</text>
      </svg>
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
export default function HomeTab({ model, valuations = [], returns, priceMeta = {}, setTab }) {
  if (!model) return <Empty msg="Couldn't build the portfolio model — check the Transactions tab for ledger errors." />;
  const { byWrapper, total } = model;

  const last = valuations.length ? valuations[valuations.length - 1] : null;
  const prev = valuations.length > 1 ? valuations[valuations.length - 2] : null;
  const d30 = snapshotAtOrBefore(valuations, isoDaysAgo(30));
  const investedNow = total.unpriced > 0 ? null : total.marketValue;

  // Stale prices: open priced positions whose price is >3 days old.
  const staleTickers = useMemo(() => {
    const open = new Set(model.positions.filter((p) => p.priced).map((p) => p.ticker));
    const limit = isoDaysAgo(3);
    return [...open].filter((tk) => {
      const asOf = priceMeta[tk]?.asOf;
      return asOf && asOf.slice(0, 10) < limit;
    }).sort();
  }, [model, priceMeta]);

  const wrappersPresent = WRAPPERS.filter((w) => byWrapper[w] && (byWrapper[w].positions > 0 || byWrapper[w].cash > 0));

  return (
    <div className="grid gap-4">
      {/* headline + trend */}
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
          <div className="text-sm text-[var(--muted)]">Total wealth (holdings + cash, all wrappers)</div>
          <div className="flex items-baseline gap-3 flex-wrap mt-1">
            <div className="text-3xl font-semibold num">{gbp0(total.total)}</div>
            {investedNow != null && <DeltaChip label="1d" from={prev} to={investedNow} />}
            {investedNow != null && <DeltaChip label="30d" from={d30} to={investedNow} />}
          </div>
          {total.unpriced > 0 && (
            <div className="text-xs text-[var(--m-bb)] mt-1 flex items-center gap-1">
              <AlertTriangle size={12} />
              {total.unpriced} holding{total.unpriced > 1 ? "s" : ""} unpriced ({total.unpricedTickers.join(", ")}) — excluded from market value, so this understates the true total.
            </div>
          )}
          <div className="mt-3">
            <NetWorthChart valuations={valuations} />
          </div>
        </div>

        {/* needs-attention rail */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3">
          <div className="text-sm font-semibold flex items-center gap-1.5"><AlertTriangle size={15} className="text-[var(--m-bb)]" /> Needs attention</div>
          {staleTickers.length > 0 && (
            <button onClick={() => setTab && setTab("wealth")} className="text-left text-xs rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2 hover:border-[var(--accent)]">
              <span className="font-semibold text-[var(--m-bb)]">{staleTickers.length} price{staleTickers.length > 1 ? "s" : ""} &gt;3 days old</span>
              <span className="text-[var(--muted)]"> — {staleTickers.slice(0, 6).join(", ")}{staleTickers.length > 6 ? "…" : ""}. Refresh from the Wealth tab.</span>
            </button>
          )}
          {total.unpriced > 0 && (
            <button onClick={() => setTab && setTab("wealth")} className="text-left text-xs rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2 hover:border-[var(--accent)]">
              <span className="font-semibold text-[var(--loss)]">{total.unpriced} holding{total.unpriced > 1 ? "s" : ""} with no price at all</span>
              <span className="text-[var(--muted)]"> — set a price so snapshots (and this chart) can resume.</span>
            </button>
          )}
          {valuations.length < 2 && (
            <div className="text-xs text-[var(--muted)] rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2">
              No trend yet — snapshots record automatically each day every holding is priced.
            </div>
          )}
          {staleTickers.length === 0 && total.unpriced === 0 && valuations.length >= 2 && (
            <div className="text-xs text-[var(--muted)] rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2">
              All prices fresh, all holdings priced, snapshot recorded {last ? `(${last.date})` : ""}. Nothing needs you today.
            </div>
          )}
          <div className="text-sm font-semibold mt-1 flex items-center gap-1.5"><PieChart size={15} className="text-[var(--accent)]" /> Allocation</div>
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
              <div className="text-[11px] text-[var(--muted)] num">
                {agg.positions > 0 && <>{agg.positions} holding{agg.positions > 1 ? "s" : ""}</>}
                {agg.cash > 0 && <>{agg.positions > 0 ? " · " : ""}cash {gbp0(agg.cash)}</>}
              </div>
              {gain != null && (
                <div className={"text-xs num mt-0.5 " + (gain >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}
                  title={`Unrealised gain on book cost of ${gbp(agg.bookCostPriced)}`}>
                  {gain >= 0 ? "+" : ""}{gbp0(gain)}{agg.bookCostPriced > 0 && ` (${num((gain / agg.bookCostPriced) * 100, 1)}%)`}
                </div>
              )}
              {agg.unpriced > 0 && <div className="text-[11px] text-[var(--m-bb)]">{agg.unpriced} unpriced</div>}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-[var(--muted)]">
        Read-only overview as of {todayISO()}. Prices update from the Wealth tab; cash balances from Pension &amp; LISA / Wealth; the chart tracks securities value only (cash has no snapshot history).
      </p>
    </div>
  );
}
