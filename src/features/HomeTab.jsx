import React, { useState, useMemo } from "react";
import { TrendingUp, TrendingDown, AlertTriangle, PieChart, RefreshCw, CalendarClock } from "lucide-react";
import { WRAPPERS } from "../core/portfolio.mjs";
import { mortgagesEndingSoon } from "../core/property.mjs";
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
      <p className="text-[11px] text-[var(--muted)]">Everything is stored locally in this browser (plus an IndexedDB mirror) — nothing is sent anywhere except live price/FX/gilt/HPI lookups you trigger. Use the download icon above to back up any time.</p>
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
      <p className="text-[11px] text-[var(--muted)]">Use-it-or-lose-it allowances only — none of these carry forward past 5 April (except pension annual allowance, whose oldest carried year is what's shown expiring here).</p>
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
export default function HomeTab({
  model, valuations = [], returns, priceMeta = {}, setTab,
  netWorth, mortgages = [], taxYearEnd = null,
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
  const prev = valuations.length > 1 ? valuations[valuations.length - 2] : null;
  const d30 = snapshotAtOrBefore(valuations, isoDaysAgo(30));
  const investedNow = total.unpriced > 0 ? null : total.marketValue;

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
            {investedNow != null && <DeltaChip label="1d" from={prev} to={investedNow} />}
            {investedNow != null && <DeltaChip label="30d" from={d30} to={investedNow} />}
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
            <NetWorthChart valuations={valuations} />
          </div>
        </div>

        {/* needs-attention rail */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold flex items-center gap-1.5"><AlertTriangle size={15} className="text-[var(--m-bb)]" /> Needs attention</div>
            {canRefresh && (
              <button onClick={doRefresh} disabled={refreshing}
                className="btn-accent !h-auto !py-1.5 text-xs disabled:opacity-50"
                title="Fetch fresh prices for every open holding — DMO for gilts, Yahoo then Alpha Vantage for the rest (pension fund units stay manual)">
                <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} /> Refresh prices
              </button>
            )}
          </div>
          {refreshMsg && <div className="text-[11px] text-[var(--muted)] leading-snug">{refreshMsg}</div>}
          {staleTickers.length > 0 && (
            <div className="text-left text-xs rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2">
              <span className="font-semibold text-[var(--m-bb)]">{staleTickers.length} price{staleTickers.length > 1 ? "s" : ""} &gt;3 days old</span>
              <span className="text-[var(--muted)]"> — {staleTickers.slice(0, 6).join(", ")}{staleTickers.length > 6 ? "…" : ""}. Use Refresh prices above, or set them manually on the Wealth tab.</span>
            </div>
          )}
          {total.unpriced > 0 && (
            <button onClick={() => setTab && setTab("wealth")} className="text-left text-xs rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2 hover:border-[var(--accent)]">
              <span className="font-semibold text-[var(--loss)]">{total.unpriced} holding{total.unpriced > 1 ? "s" : ""} with no price at all</span>
              <span className="text-[var(--muted)]"> — try Refresh prices; anything without a live source (pension funds) needs manual entry on the Wealth tab.</span>
            </button>
          )}
          {mortgagesSoon.length > 0 && (
            <button onClick={() => setTab && setTab("property")} className="text-left text-xs rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2 hover:border-[var(--accent)]">
              <span className="font-semibold text-[var(--m-bb)]">{mortgagesSoon.length} fixed-rate mortgage{mortgagesSoon.length > 1 ? "s" : ""} {mortgagesSoon.some((m) => m.expired) ? "expired or " : ""}ending within 180 days</span>
              <span className="text-[var(--muted)]"> — check the Property tab; an expired fixed deal usually reverts to a much higher SVR.</span>
            </button>
          )}
          {valuations.length < 2 && (
            <div className="text-xs text-[var(--muted)] rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2">
              No trend yet — snapshots record automatically each day every holding is priced.
            </div>
          )}
          {staleTickers.length === 0 && total.unpriced === 0 && mortgagesSoon.length === 0 && valuations.length >= 2 && (
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
