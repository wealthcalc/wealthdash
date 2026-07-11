import React, { useState, useMemo, useCallback, useRef } from "react";
import { Landmark } from "lucide-react";
import { gbp, WrapperChip, dmoDateToIso, fetchDmoGiltPrices, num, NumberInput, uid, todayISO, Field, Stat, Empty, useSort, sortRows, SortTh } from "../ui/shared.jsx";
import { buildGiltLadder } from "../core/gilt-ladder.mjs";
import useAppStore from "../state/appStore.js";

// Raw persisted state from the store via selectors; only DERIVED data
// (`data`, the shell's giltAnalytics output) arrives as a prop — Phase 2.8.
function GiltsTab({ data }) {
  const secMeta = useAppStore((s) => s.secMeta), setSecMeta = useAppStore((s) => s.setSecMeta);
  const prices = useAppStore((s) => s.prices), setPrices = useAppStore((s) => s.setPrices);
  const dmoReportDate = useAppStore((s) => s.dmoReportDate), setDmoReportDate = useAppStore((s) => s.setDmoReportDate);
  const [form, setForm] = React.useState({ ticker: "", name: "", coupon: "", maturity: "", isin: "" });
  const [dmoState, setDmoState] = React.useState({ status: "idle", message: "" }); // idle | loading | done | error
  const [sort, toggleSort] = useSort("maturity", "asc");
  const [targetAnnual, setTargetAnnual] = useState(0);
  const registered = Object.entries(secMeta).filter(([, m]) => m && m.kind === "gilt");
  const registerGilt = () => {
    const tk = form.ticker.toUpperCase().trim();
    if (!tk || !Number.isFinite(+form.coupon) || !/^\d{4}-\d{2}-\d{2}$/.test(form.maturity)) return;
    setSecMeta((m) => ({
      ...m,
      [tk]: { ...m[tk], kind: "gilt", coupon: +form.coupon, maturity: form.maturity, domicile: "GB", eri: false,
        name: form.name.trim() || tk, isin: form.isin.toUpperCase().trim() || (m[tk] && m[tk].isin) || "" },
    }));
    setForm({ ticker: "", name: "", coupon: "", maturity: "", isin: "" });
  };

  // Live gilt prices from the DMO's own official daily Purchase & Sale Service
  // prices (see api/gilt-prices.mjs) — neither Alpha Vantage nor Yahoo Finance
  // covers individual gilts by ISIN, verified by hand before building this.
  // DMO publishes once/day, so a same-day re-fetch is skipped by default
  // (see fetchDmoGiltPrices) — "Force refresh" bypasses that if ever needed.
  const fetchDmoPrices = async (force = false) => {
    const targets = registered.map(([tk, m]) => ({ ticker: tk, isin: m.isin }));
    if (!targets.some((t) => t.isin)) { setDmoState({ status: "error", message: "No registered gilt has an ISIN to look up." }); return; }
    setDmoState({ status: "loading", message: "" });
    try {
      const { pricesByTicker, matched, date, total, skipped } = await fetchDmoGiltPrices(targets, { knownReportDate: dmoReportDate, force });
      if (skipped) {
        setDmoState({ status: "done", message: `Already up to date — today's DMO report (${dmoReportDate}) was already fetched. No need to ask the DMO again.`, skippable: true });
        return;
      }
      setPrices((pr) => ({ ...pr, ...pricesByTicker }));
      if (matched) setDmoReportDate(dmoDateToIso(date));
      setDmoState({
        status: "done",
        message: matched
          ? `Updated ${matched}/${total} gilt${total === 1 ? "" : "s"} from the DMO report dated ${date}.`
          : `DMO report dated ${date} didn't include any of your registered ISINs.`,
      });
    } catch (e) {
      setDmoState({ status: "error", message: e.message || "Fetch failed." });
    }
  };

  // Ladder-vs-need matching: groups every projected gilt cashflow (coupons
  // + redemptions, already computed by giltAnalytics()) by calendar year
  // and checks it against a flat target income need the user types in —
  // see gilt-ladder.mjs's header for why this only covers gilts already
  // held, not a browsable universe of gilts to buy.
  const ladder = useMemo(
    () => buildGiltLadder({ cashflows: data?.cashflows || [], targetAnnual: +targetAnnual || 0 }),
    [data, targetAnnual]
  );

  if (!data) return <Empty msg="Couldn't compute gilt analytics — check the Transactions tab for ledger errors." />;
  const liveBase = data.holdings.filter((h) => h.nominal > 1e-9).sort((a, b) => a.ticker.localeCompare(b.ticker));
  const live = sortRows(liveBase, sort, {
    ticker: (h) => h.ticker, wrapper: (h) => h.wrapper, maturity: (h) => h.maturity, nominal: (h) => h.nominal,
    clean: (h) => prices[h.ticker] ?? null, accrued: (h) => h.accruedPer100, dirty: (h) => h.dirtyValue,
    nextCoupon: (h) => h.nextCoupon?.date ?? null, gry: (h) => h.gry?.semiAnnual ?? null, coupons12m: (h) => h.couponIncomeNext12m,
  });
  const aisYears = Object.keys(data.ais.byYear).sort();
  const upcoming = data.cashflows.slice(0, 12);

  return (
    <div className="space-y-4">
      {live.length === 0 && (
        <Empty msg={`No gilt holdings yet. Buy an individual gilt in any wrapper using a registered ticker (${registered.map(([t]) => t).join(", ") || "none registered"}) on the Transactions tab, or register another gilt below. Quantity = £ nominal (face value); price = clean price per £1 nominal (e.g. £94.23 per £100 → 0.9423 — the live price feed for LSE gilt lines already lands in this unit).`} />
      )}

      {live.length > 0 && (
        <>
          {/* DMO live price fetch */}
          <div className="flex items-center gap-3 flex-wrap">
            <button className="btn-accent" onClick={() => fetchDmoPrices(false)} disabled={dmoState.status === "loading"}>
              <Landmark size={15} /> {dmoState.status === "loading" ? "Fetching…" : "Fetch DMO gilt prices"}
            </button>
            {dmoState.skippable && (
              <button onClick={() => fetchDmoPrices(true)} className="text-xs text-[var(--accent)] hover:underline">Force refresh anyway</button>
            )}
            {dmoState.status === "done" && <span className="text-sm text-[var(--gain)]">{dmoState.message}</span>}
            {dmoState.status === "error" && <span className="text-sm text-[var(--loss)]">{dmoState.message}</span>}
            <span className="text-xs text-[var(--muted)]">Official DMO daily clean prices (midpoint of their published purchase/sale quotes) — not Alpha Vantage or Yahoo, neither covers individual gilts. DMO publishes once/day, so a same-day re-fetch is skipped automatically.</span>
          </div>

          {/* headline */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Gilt ladder (dirty value)" value={live.every((h) => h.dirtyValue != null) ? gbp(live.reduce((s, h) => s + h.dirtyValue, 0)) : "—"} sub={`${live.length} holding${live.length === 1 ? "" : "s"}; par at maturity ${gbp(live.reduce((s, h) => s + h.nominal, 0))}`} big />
            <Stat label="of which accrued interest" value={gbp(live.reduce((s, h) => s + h.accruedValue, 0))} sub="actual/actual, to today" />
            <Stat label="Coupon income next 12m" value={gbp(live.reduce((s, h) => s + h.couponIncomeNext12m, 0))} sub="taxable as interest where unsheltered" />
            <Stat label="Next cashflow" value={upcoming[0] ? gbp(upcoming[0].amount) : "—"} sub={upcoming[0] ? `${upcoming[0].ticker} ${upcoming[0].type} · ${upcoming[0].date}` : undefined} />
          </div>

          {/* ladder */}
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>
                  <SortTh id="ticker" label="Gilt" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium" />
                  <SortTh id="wrapper" label="Wrapper" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium" />
                  <SortTh id="maturity" label="Maturity" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium" />
                  <SortTh id="nominal" label="Nominal" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
                  <SortTh id="clean" label="Clean /£100" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
                  <SortTh id="accrued" label="Accrued /£100" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
                  <SortTh id="dirty" label="Dirty value" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
                  <SortTh id="nextCoupon" label="Next coupon" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
                  <SortTh id="gry" label="GRY (semi)" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
                  <SortTh id="coupons12m" label="12m coupons" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {live.map((h) => (
                  <tr key={h.wrapper + h.ticker} className="hover:bg-[var(--panel2)]">
                    <td className="px-3 py-2 font-medium" title={`${h.name} · ${h.isin}`}>
                      {h.ticker}
                      {h.exDiv && <span className="ml-1.5 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--m-bb)_18%,transparent)] text-[var(--m-bb)] align-middle" title="In the ex-dividend window (7 business days before the coupon; bank holidays not modelled) — accrued is negative (rebate); the registered holder at ex-div gets the coupon">ex-div</span>}
                    </td>
                    <td className="px-3 py-2"><WrapperChip wrapper={h.wrapper} /></td>
                    <td className="px-3 py-2 num text-[var(--muted)] whitespace-nowrap text-xs">{h.maturity}</td>
                    <td className="px-3 py-2 num text-right">{gbp(h.nominal)}</td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" step="0.0001" value={prices[h.ticker] != null ? +(prices[h.ticker] * 100).toFixed(4) : ""} placeholder="—"
                        onChange={(e) => setPrices((pr) => ({ ...pr, [h.ticker]: e.target.value === "" ? undefined : +e.target.value / 100 }))}
                        className="input num w-24 text-right py-1" title="Clean price per £100 nominal (stored per £1 for consistency with the rest of the app)" />
                    </td>
                    <td className={"px-3 py-2 num text-right " + (h.accruedPer100 < 0 ? "text-[var(--m-bb)]" : "text-[var(--muted)]")}>{num(h.accruedPer100, 4)}</td>
                    <td className="px-3 py-2 num text-right">{h.dirtyValue != null ? gbp(h.dirtyValue) : "—"}</td>
                    <td className="px-3 py-2 num text-right whitespace-nowrap">{h.nextCoupon ? <span className="text-xs">{gbp(h.nextCoupon.amount)} <span className="text-[var(--muted)]">on {h.nextCoupon.date}</span></span> : "—"}</td>
                    <td className="px-3 py-2 num text-right">{h.gry && h.gry.semiAnnual != null ? <span title={`Effective annual ${num(h.gry.effectiveAnnual * 100, 3)}% · dirty ${num(h.gry.dirty, 4)}/£100`}>{num(h.gry.semiAnnual * 100, 2)}%</span> : "—"}</td>
                    <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(h.couponIncomeNext12m)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* coupon calendar */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
            <div className="text-sm font-medium flex items-center gap-2 mb-2"><Landmark size={15} className="text-[var(--accent)]" /> Upcoming cashflows <span className="text-xs font-normal text-[var(--muted)]">— next {upcoming.length} of {data.cashflows.length} to final maturity</span></div>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
              {upcoming.map((f, i) => (
                <div key={i} className="flex items-baseline justify-between text-sm border-b border-[var(--border)] last:border-0 py-1">
                  <span className="num text-[var(--muted)]">{f.date}</span>
                  <span className="font-medium">{f.ticker}<span className={"ml-1.5 text-[11px] px-1 py-0.5 rounded " + (f.type === "redemption" ? "bg-[color:color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)]" : "bg-[var(--chip)] text-[var(--muted)]")}>{f.type}</span></span>
                  <span className="num">{gbp(f.amount)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ladder vs income need */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="text-sm font-medium flex items-center gap-2"><Landmark size={15} className="text-[var(--accent)]" /> Ladder coverage vs. an income need</div>
              <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
                Target income
                <input type="number" step="500" min="0" value={targetAnnual || ""} placeholder="£/yr"
                  onChange={(e) => setTargetAnnual(e.target.value === "" ? 0 : +e.target.value)}
                  className="input num w-28 text-right py-1" />
                £/yr
              </label>
            </div>
            {targetAnnual > 0 ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Stat label="Years fully covered" value={`${ladder.yearsFullyCovered} / ${ladder.totalYears}`} sub={`${ladder.fromYear}–${ladder.toYear}`} />
                  <Stat label="First gap year" value={ladder.firstGapYear ?? "none"} sub={ladder.fullyCovered ? "ladder covers every year to final maturity" : "target exceeds gilt income from here"} />
                  <Stat label="Total shortfall" value={gbp(ladder.totalShortfall)} sub="summed across every uncovered year" />
                  <Stat label="Total gilt income" value={gbp(ladder.totalGiltIncome)} sub={`${ladder.fromYear}–${ladder.toYear}`} />
                </div>
                <div className="rounded-lg border border-[var(--border)] overflow-x-auto max-h-64 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-1.5 font-medium">Year</th>
                        <th className="text-right px-3 py-1.5 font-medium">Gilt income</th>
                        <th className="text-right px-3 py-1.5 font-medium">Target</th>
                        <th className="text-right px-3 py-1.5 font-medium">Surplus / shortfall</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {ladder.rows.map((r) => (
                        <tr key={r.year} className={r.covered ? "" : "bg-[color:color-mix(in_srgb,var(--loss)_8%,transparent)]"}>
                          <td className="px-3 py-1.5 num">{r.year}</td>
                          <td className="px-3 py-1.5 num text-right">{gbp(r.giltIncome)}</td>
                          <td className="px-3 py-1.5 num text-right text-[var(--muted)]">{gbp(r.target)}</td>
                          <td className={"px-3 py-1.5 num text-right font-medium " + (r.covered ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.surplus >= 0 ? "+" : "−"}{gbp(Math.abs(r.surplus))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-[var(--muted)] leading-relaxed">
                  Nominal, fixed-coupon cash compared against a flat (not inflation-uprated) target — the honest like-for-like, since the ladder itself doesn't grow with inflation. Only covers gilts you already hold: there's no browsable universe of every UK gilt in this app to suggest new purchases from (DMO's daily price report only covers ISINs you've registered above), so a gap here means either buying more gilts maturing in that year or funding it from elsewhere.
                </p>
              </>
            ) : (
              <p className="text-xs text-[var(--muted)]">Enter a target annual income need to see which years your existing ladder covers and where the gaps are.</p>
            )}
          </div>

          {/* AIS */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
            <div className="text-sm font-medium">Accrued Income Scheme (GIA trades only)</div>
            {aisYears.length === 0 ? (
              <p className="text-xs text-[var(--muted)]">No GIA gilt transfers — nothing to adjust.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-[var(--muted)] text-xs uppercase tracking-wide">
                  <tr><th className="text-left py-1 font-medium">Tax year of next coupon</th><th className="text-right font-medium">Transfers</th><th className="text-right font-medium">Net adjustment to taxable interest</th></tr>
                </thead>
                <tbody>
                  {aisYears.map((y) => (
                    <tr key={y} className="border-t border-[var(--border)]">
                      <td className="py-1.5 num">{y}</td>
                      <td className="py-1.5 num text-right text-[var(--muted)]">{data.ais.byYear[y].items.length}</td>
                      <td className={"py-1.5 num text-right font-medium " + (data.ais.byYear[y].net >= 0 ? "text-[var(--loss)]" : "text-[var(--gain)]")}>{data.ais.byYear[y].net >= 0 ? "+" : "−"}{gbp(Math.abs(data.ais.byYear[y].net)).slice(1)} {data.ais.byYear[y].net >= 0 ? "profit" : "relief"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              Estimates from trade dates (gilts settle T+1, so a trade near a coupon or the ex-div boundary can shift a day's accrual or flip cum/ex — check contract notes). Adjustments are taxed in the tax year the <em>next coupon</em> falls, pooled across all your AIS securities. {data.ais.smallHoldingsLikelyExcluded ? "Your peak GIA gilt nominal is within the £5,000 small-holdings limit, so the scheme likely doesn't apply to you at all — figures shown for completeness." : "The £5,000 small-holdings exclusion doesn't apply to you (peak GIA nominal " + gbp(data.ais.maxNominalGIA) + "), so these adjustments belong on your return alongside the coupons themselves."} These figures are not yet folded into the Income tab's tax computation — they're the disclosure-ready numbers for boxes on the Ai pages.
            </p>
          </div>
        </>
      )}

      {/* register */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
        <div className="text-sm font-medium">Register a gilt</div>
        <div className="flex flex-wrap gap-2">
          <input className="input w-24" placeholder="Ticker" value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} />
          <input className="input flex-1 min-w-40" placeholder="Name (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input w-28" type="number" step="0.001" placeholder="Coupon %" value={form.coupon} onChange={(e) => setForm({ ...form, coupon: e.target.value })} />
          <input className="input w-40" type="date" title="Maturity date" value={form.maturity} onChange={(e) => setForm({ ...form, maturity: e.target.value })} />
          <input className="input w-40" placeholder="ISIN (optional)" value={form.isin} onChange={(e) => setForm({ ...form, isin: e.target.value })} />
          <button className="btn-accent" onClick={registerGilt}>Add</button>
        </div>
        <p className="text-xs text-[var(--muted)] leading-relaxed">
          Registered: {registered.length ? registered.map(([t, m]) => `${t} (${m.coupon}% ${m.maturity})`).join(" · ") : "none"}. Registering marks the ticker CGT-exempt (TCGA 1992 s115) and interest-paying, and drives the coupon schedule — coupon and maturity must come from the DMO/your broker, not memory. Conventions: semi-annual coupons anchored at maturity, actual/actual accrued, ex-div 7 business days (weekends only — UK bank holidays not modelled). Index-linked gilts are NOT supported: schedules here assume fixed cash coupons and par redemption, so an IL gilt's figures would be wrong — leave those unregistered.
        </p>
      </div>
    </div>
  );
}

/* --------------------------- Holdings tab --------------------------- */

export default GiltsTab;
