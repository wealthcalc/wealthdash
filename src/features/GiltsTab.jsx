import React, { useState, useMemo, useRef } from "react";
import { Landmark, AlertTriangle, Plus, Search, X, TrendingUp } from "lucide-react";
import { ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ScatterChart, Scatter, ZAxis, Legend } from "recharts";
import { gbp, gbp0, WrapperChip, dmoDateToIso, fetchDmoGiltPrices, fetchDmoGiltCatalogue, num, uid, todayISO, Stat, Empty, SegmentedControl, useSort, sortRows, SortTh, TwoStepDelete, FormField, EnterSubmits } from "../ui/shared.jsx";
import { buildGiltLadder } from "../core/gilt-ladder.mjs";
import {
  validateGiltRegistration, unregisterGiltMeta, giltRegistryDiagnostics,
  shapeGiltCatalogue, searchGiltCatalogue, buildGiltTrade,
} from "../core/gilt-registry.mjs";
import {
  portfolioYield, holdingExtras, maturityProfile, yieldCurvePoints, gapSuggestions,
  marginalSavingsRate, isTaxableWrapper,
} from "../core/gilt-portfolio.mjs";
import { investmentIncomeTax, currentTaxYear } from "../core/uk-tax.mjs";
import useAppStore from "../state/appStore.js";

const BLANK_FORM = { ticker: "", name: "", coupon: "", maturity: "", isin: "", indexLinked: false, indexRatio: "", indexRatioDate: "", indexationLagMonths: 3 };

// Raw persisted state from the store via selectors; only DERIVED data
// (`data`, the shell's giltAnalytics output) arrives as a prop — Phase 2.8.
function GiltsTab({ data, onOpenHolding }) {
  const secMeta = useAppStore((s) => s.secMeta), setSecMeta = useAppStore((s) => s.setSecMeta);
  const prices = useAppStore((s) => s.prices), setPrices = useAppStore((s) => s.setPrices);
  const txns = useAppStore((s) => s.txns), setTxns = useAppStore((s) => s.setTxns);
  const dmoReportDate = useAppStore((s) => s.dmoReportDate), setDmoReportDate = useAppStore((s) => s.setDmoReportDate);
  const salary = useAppStore((s) => s.income) || 0;
  const [form, setForm] = React.useState(BLANK_FORM);
  const [editing, setEditing] = React.useState(null);   // ticker being edited, or null
  const [errors, setErrors] = React.useState({});
  const [dmoState, setDmoState] = React.useState({ status: "idle", message: "" }); // idle | loading | done | error
  const [sort, toggleSort] = useSort("maturity", "asc");
  const [targetAnnual, setTargetAnnual] = useState(0);
  const [basis, setBasis] = useState("real");   // real (today's money) | cash
  const registerRef = useRef(null);
  const registered = Object.entries(secMeta).filter(([, m]) => m && m.kind === "gilt");

  // Why an empty ladder is empty. Registration and holding are two separate
  // halves (see core/gilt-registry.mjs) and neither is visible when it's the
  // one that's missing — so the tab has to say which.
  const diag = useMemo(() => giltRegistryDiagnostics({ txns, secMeta }), [txns, secMeta]);

  const focusRegister = (prefill) => {
    if (prefill) { setForm({ ...BLANK_FORM, ...prefill }); setEditing(null); setErrors({}); }
    registerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const registerGilt = () => {
    const r = validateGiltRegistration(form, { secMeta, editing });
    setErrors(r.errors);
    if (!r.ok) return;
    const { ticker, patch } = r.value;
    setSecMeta((m) => {
      const next = { ...m, [ticker]: patch };
      // Renaming during an edit must not leave the old registration behind
      // as a second, holding-less gilt.
      if (editing && editing !== ticker) delete next[editing];
      return next;
    });
    setForm(BLANK_FORM); setEditing(null); setErrors({});
  };

  const startEdit = (tk, m) => {
    setEditing(tk); setErrors({});
    setForm({
      ticker: tk, name: m.name || "", coupon: String(m.coupon ?? ""), maturity: m.maturity || "", isin: m.isin || "",
      indexLinked: !!m.indexLinked, indexRatio: String(m.indexRatio ?? ""), indexRatioDate: m.indexRatioDate || "",
      indexationLagMonths: m.indexationLagMonths ?? 3,
    });
    registerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const unregister = (tk) => {
    setSecMeta((m) => ({ ...m, [tk]: unregisterGiltMeta(m[tk] || {}) }));
    if (editing === tk) { setEditing(null); setForm(BLANK_FORM); setErrors({}); }
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
      const { pricesByTicker, ratiosByTicker, matched, date, total, skipped } = await fetchDmoGiltPrices(targets, { knownReportDate: dmoReportDate, force });
      if (skipped) {
        setDmoState({ status: "done", message: `Already up to date — today's DMO report (${dmoReportDate}) was already fetched. No need to ask the DMO again.`, skippable: true });
        return;
      }
      setPrices((pr) => ({ ...pr, ...pricesByTicker }));
      // Index-linked gilts: the ratio moves with RPI every day, so it's
      // refreshed with the price rather than frozen at registration. The
      // price stored above is already uplifted by it.
      if (ratiosByTicker && Object.keys(ratiosByTicker).length) {
        setSecMeta((m) => {
          const n = { ...m };
          for (const [tk, r] of Object.entries(ratiosByTicker)) n[tk] = { ...n[tk], ...r };
          return n;
        });
      }
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
    () => buildGiltLadder({ cashflows: data?.cashflows || [], targetAnnual: +targetAnnual || 0, field: basis === "cash" ? "amount" : "realAmount" }),
    [data, targetAnnual, basis]
  );

  // Index-linked gilts make "how much is this worth" two questions with two
  // different answers, so the tab picks one explicitly instead of quietly
  // mixing them. `cash` = the money expected to arrive (linker cashflows
  // projected at the plan's inflation rate); otherwise everything is in
  // today's purchasing power, where a linker's stream is FLAT and a
  // conventional gilt's visibly erodes. Only shown when it can matter.
  const anyIL = !!data?.anyIndexLinked;
  const cash = basis === "cash";
  const amt = (f) => (cash ? f.amount : (f.realAmount ?? f.amount));
  const field = cash ? "amount" : "realAmount";
  const asOf = data?.asOf || todayISO();

  /* ---- the ladder as ONE instrument (core/gilt-portfolio.mjs) ---------- */
  // The marginal rate on the NEXT £ of coupon, probed from the same tax
  // engine the Income tab uses, at the stored salary and this ladder's own
  // unsheltered coupon income. That's what decides whether a low-coupon
  // gilt beats a high-coupon one for THIS person, which is the whole UK
  // case for holding gilts directly rather than a bond fund.
  const taxYear = currentTaxYear(asOf);
  const giaCoupons12m = useMemo(
    () => (data?.holdings || []).filter((h) => isTaxableWrapper(h.wrapper)).reduce((s, h) => s + (h.couponIncomeNext12m || 0), 0),
    [data]
  );
  const [taxOverride, setTaxOverride] = useState(null);   // null = follow the engine
  const engineRate = useMemo(
    () => marginalSavingsRate(investmentIncomeTax, { salary: +salary || 0, interest: giaCoupons12m, year: taxYear }) ?? 0,
    [salary, giaCoupons12m, taxYear]
  );
  const taxRate = taxOverride == null ? engineRate : taxOverride;

  const port = useMemo(
    () => portfolioYield({ holdings: data?.holdings || [], cashflows: data?.cashflows || [], asOf, field, taxRate }),
    [data, asOf, field, taxRate]
  );
  const extras = useMemo(() => {
    const m = {};
    for (const h of data?.holdings || []) {
      const rows = txns.filter((t) => t.ticker === h.ticker && (t.wrapper || "GIA").toUpperCase() === h.wrapper);
      m[h.wrapper + h.ticker] = holdingExtras(h, { asOf, rows, taxRate });
    }
    return m;
  }, [data, txns, asOf, taxRate]);
  const profile = useMemo(() => maturityProfile(data?.cashflows || [], field), [data, field]);

  // A failed analytics run must NOT take the registration panel down with
  // it: that was the previous behaviour, and it meant the one screen where
  // a broken gilt could be fixed disappeared exactly when it was needed.
  const liveBase = (data?.holdings || []).filter((h) => h.nominal > 1e-9).sort((a, b) => a.ticker.localeCompare(b.ticker));
  const live = sortRows(liveBase, sort, {
    ticker: (h) => h.ticker, wrapper: (h) => h.wrapper, maturity: (h) => h.maturity, nominal: (h) => h.nominal,
    clean: (h) => prices[h.ticker] ?? null, accrued: (h) => h.accruedPer100, dirty: (h) => h.dirtyValue,
    nextCoupon: (h) => h.nextCoupon?.date ?? null, gry: (h) => h.gry?.semiAnnual ?? null, coupons12m: (h) => h.couponIncomeNext12m,
    duration: (h) => extras[h.wrapper + h.ticker]?.duration?.modified ?? null,
  });
  const aisYears = Object.keys(data?.ais?.byYear || {}).sort();
  const upcoming = (data?.cashflows || []).slice(0, 12);


  return (
    <div className="space-y-4">
      {!data && (
        <Empty msg="Couldn't compute gilt analytics — check the Transactions tab for ledger errors. You can still register, edit and remove gilts below." />
      )}

      <GiltDiagnostics diag={diag} onRegister={focusRegister} onEdit={startEdit} secMeta={secMeta} />

      {data && live.length === 0 && (
        <Empty msg={registered.length
          ? `Nothing held yet. ${registered.map(([t]) => t).join(", ")} ${registered.length === 1 ? "is" : "are"} registered — add the purchase below, or on the Transactions tab (quantity = £ nominal, price = clean per £1 nominal, i.e. £94.23 per £100 → 0.9423).`
          : "No gilts registered yet. Register one below — you can pick it straight off the DMO's own list, so the coupon and redemption date don't have to be typed from memory."} />
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
            <span className="text-xs text-[var(--muted)]">Official DMO daily clean prices (midpoint of their published purchase/sale quotes) — not Alpha Vantage or Yahoo, neither covers individual gilts. DMO publishes once/day, so a same-day re-fetch is skipped automatically.{anyIL ? " For index-linked lines this also refreshes the index ratio, which moves with RPI daily." : ""}</span>
          </div>

          {anyIL && (
            <div className="flex items-center gap-3 flex-wrap">
              <SegmentedControl
                ariaLabel="Show gilt cashflows in"
                value={basis}
                onChange={setBasis}
                options={[
                  ["real", "Today's money", { title: "Index-linked coupons and redemptions at the uplift already earned; conventional gilts discounted back. A linker's line is flat here — that's the point of it." }],
                  ["cash", "Cash expected", { title: `Linker cashflows projected forward at ${num((data.inflation || 0) * 100, 1)}% inflation (from Assumptions). Conventional gilts are contractual and don't move.` }],
                ]}
              />
              <span className="text-xs text-[var(--muted)]">
                {cash
                  ? <>Linker coupons and redemptions projected at <span className="font-medium text-[var(--fg)]">{num((data.inflation || 0) * 100, 1)}%</span> inflation — a forecast, not a contract. Change it on the Assumptions screen.</>
                  : <>Everything in today&apos;s purchasing power: index-linked flows carry the uplift already earned (a published fact), conventional flows are discounted back at {num((data.inflation || 0) * 100, 1)}%.</>}
              </span>
            </div>
          )}

          {data.indexRatiosMissing?.length > 0 && (
            <div className="rounded-xl border border-[color:color-mix(in_srgb,var(--loss)_45%,var(--border))] bg-[color:color-mix(in_srgb,var(--loss)_8%,transparent)] p-3 flex gap-2.5 text-sm">
              <AlertTriangle size={15} className="text-[var(--loss)] shrink-0 mt-0.5" />
              <div className="leading-relaxed">
                <span className="font-medium">No index ratio for {data.indexRatiosMissing.join(", ")}</span> — so {data.indexRatiosMissing.length === 1 ? "it is" : "they are"} being valued at the real quoted price, which is materially low (TG36&apos;s ratio is about 1.59, so ~37% low).
                <span className="text-xs text-[var(--muted)] block">Fetch DMO gilt prices above and it fills itself in.</span>
              </div>
            </div>
          )}

          {/* headline */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Gilt ladder (dirty value)" value={live.every((h) => h.dirtyValue != null) ? gbp(live.reduce((s, h) => s + h.dirtyValue, 0)) : "—"} sub={`${live.length} holding${live.length === 1 ? "" : "s"}; redeems for ${gbp(live.reduce((s, h) => s + (cash ? h.redemptionValue : h.redemptionValueReal), 0))}${anyIL ? cash ? " (linkers projected)" : " in today's money" : ""}`} big />
            <Stat label="of which accrued interest" value={gbp(live.reduce((s, h) => s + h.accruedValue, 0))} sub="actual/actual, to today" />
            <Stat label="Coupon income next 12m" value={gbp(live.reduce((s, h) => s + (cash ? h.couponIncomeNext12m : h.couponIncomeNext12mReal), 0))} sub="taxable as interest where unsheltered" />
            <Stat label="Next cashflow" value={upcoming[0] ? gbp(amt(upcoming[0])) : "—"} sub={upcoming[0] ? `${upcoming[0].ticker} ${upcoming[0].type} · ${upcoming[0].date}` : undefined} />
          </div>

          <PortfolioYield port={port} basis={basis} inflation={data.inflation || 0} salary={salary} taxYear={taxYear}
            engineRate={engineRate} taxRate={taxRate} onTaxRate={setTaxOverride} profile={profile} anyIL={anyIL} />

          {/* ladder — 11 columns didn't fit a laptop, so the right-hand
              ones (GRY, 12m income) were falling off the edge unseen. Four
              columns are folded into cells they belong with rather than
              dropped: the wrapper chip and maturity sit under the ticker,
              and the index ratio under the price it modifies. Accrued
              collapses below xl — it's already inside the value column, and
              its total is in the headline strip. */}
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>
                  <SortTh id="maturity" label="Gilt" sort={sort} onSort={toggleSort} className="px-2.5 py-2 font-medium" />
                  <SortTh id="nominal" label="Nominal" sort={sort} onSort={toggleSort} align="right" className="px-2.5 py-2 font-medium" />
                  <SortTh id="clean" label={anyIL ? "Clean (real)" : "Clean"} sort={sort} onSort={toggleSort} align="right" className="px-2.5 py-2 font-medium" />
                  <SortTh id="accrued" label="Accrued" sort={sort} onSort={toggleSort} align="right" className="px-2.5 py-2 font-medium hidden xl:table-cell" />
                  <SortTh id="dirty" label="Value" sort={sort} onSort={toggleSort} align="right" className="px-2.5 py-2 font-medium" />
                  <SortTh id="nextCoupon" label="Next coupon" sort={sort} onSort={toggleSort} align="right" className="px-2.5 py-2 font-medium" />
                  <SortTh id="gry" label={taxRate > 0 ? "GRY / net" : "GRY"} sort={sort} onSort={toggleSort} align="right" className="px-2.5 py-2 font-medium" />
                  <SortTh id="duration" label="Duration" sort={sort} onSort={toggleSort} align="right" className="px-2.5 py-2 font-medium hidden lg:table-cell" />
                  <SortTh id="coupons12m" label="12m income" sort={sort} onSort={toggleSort} align="right" className="px-2.5 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {live.map((h) => { const x = extras[h.wrapper + h.ticker] || {}; return (
                  <tr key={h.wrapper + h.ticker} className="hover:bg-[var(--panel2)] align-top">
                    <td className="px-2.5 py-2" title={`${h.name} · ${h.isin}`}>
                      <div className="font-medium whitespace-nowrap">
                        {onOpenHolding
                          ? <button onClick={() => onOpenHolding(h.ticker)} className="hover:text-[var(--accent)] underline-offset-2 hover:underline" title={`Everything about ${h.ticker}`}>{h.ticker}</button>
                          : h.ticker}
                        {h.indexLinked && <span className="ml-1.5 text-[10px] font-semibold px-1 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)] align-middle" title="Index-linked: quoted in real terms, uplifted by the index ratio. CGT-exempt including the whole inflation uplift (TCGA 1992 s115); only the coupon is taxable.">IL</span>}
                        {h.exDiv && <span className="ml-1.5 text-[10px] font-semibold px-1 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--m-bb)_18%,transparent)] text-[var(--m-bb)] align-middle" title="In the ex-dividend window (7 business days before the coupon; bank holidays not modelled) — accrued is negative (rebate); the registered holder at ex-div gets the coupon">ex-div</span>}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <WrapperChip wrapper={h.wrapper} />
                        <span className="num text-[11px] text-[var(--muted)] whitespace-nowrap">{h.maturity}</span>
                        {x.yearsToMaturity > 0 && <span className="num text-[11px] text-[var(--muted)] whitespace-nowrap" title={`${num(x.yearsToMaturity, 2)} years to redemption`}>· {num(x.yearsToMaturity, 1)}y</span>}
                      </div>
                    </td>
                    <td className="px-2.5 py-2 num text-right whitespace-nowrap">{gbp(h.nominal)}</td>
                    <td className="px-2.5 py-2 text-right">
                      <input type="number" step="0.0001" value={h.realClean100 != null ? +h.realClean100.toFixed(4) : ""} placeholder="—"
                        onChange={(e) => setPrices((pr) => ({ ...pr, [h.ticker]: e.target.value === "" ? undefined : (+e.target.value * (h.indexRatio || 1)) / 100 }))}
                        className="input num w-20 text-right py-1 text-xs"
                        title={h.indexLinked
                          ? `The REAL clean price per £100, as quoted. Stored uplifted by the index ratio (${num(h.indexRatio, 5)}), which is what it's actually worth — ${num(h.clean100, 2)} per £100.`
                          : "Clean price per £100 nominal (stored per £1 for consistency with the rest of the app)"} />
                      {h.indexLinked && (
                        <div className="num text-[11px] mt-0.5 whitespace-nowrap">
                          {h.indexRatioMissing
                            ? <span className="text-[var(--loss)]" title="Without it this holding is valued at its real price — materially low. Fetch DMO prices, or set it on the registration below.">no ratio</span>
                            : <span className="text-[var(--muted)]" title={`Index ratio ${num(h.indexRatio, 5)}${h.indexRatioDate ? ` as at ${h.indexRatioDate}` : ""} — cash value ${num(h.clean100, 2)} per £100 nominal`}>×{num(h.indexRatio, 4)} = {num(h.clean100, 2)}</span>}
                        </div>
                      )}
                    </td>
                    <td className={"px-2.5 py-2 num text-right hidden xl:table-cell " + (h.accruedPer100 < 0 ? "text-[var(--m-bb)]" : "text-[var(--muted)]")}>{num(h.accruedPer100, 4)}</td>
                    <td className="px-2.5 py-2 num text-right whitespace-nowrap" title={`Includes ${gbp(h.accruedValue)} accrued interest`}>{h.dirtyValue != null ? gbp(h.dirtyValue) : "—"}</td>
                    <td className="px-2.5 py-2 num text-right whitespace-nowrap text-xs">
                      {h.nextCoupon ? <>{gbp(h.nextCoupon.amount)}<span className="block text-[11px] text-[var(--muted)]">{h.nextCoupon.date}</span></> : "—"}
                    </td>
                    <td className="px-2.5 py-2 num text-right whitespace-nowrap">{h.gry && h.gry.semiAnnual != null
                      ? <>
                        <span title={`Effective annual ${num(h.gry.effectiveAnnual * 100, 3)}% · dirty ${num(h.gry.dirty, 4)}/£100 (real)${h.gry.real ? ". This is a REAL yield — the return ABOVE inflation. Add expected inflation before comparing it with a conventional gilt." : ""}`}>
                          {num(h.gry.semiAnnual * 100, 2)}%{h.gry.real && <span className="ml-0.5 text-[10px] text-[var(--m-bb)] font-semibold align-super">real</span>}
                        </span>
                        {/* The number that decides between two gilts for THIS
                            person: coupons taxed at the marginal savings rate,
                            the pull to par left alone (s115). A sheltered line
                            has nothing to subtract, so it says so instead of
                            repeating the gross figure as if it were a result. */}
                        {x.netYield?.semiAnnual != null && (
                          <span className="block text-[11px] text-[var(--muted)]"
                            title={x.taxRateApplied > 0
                              ? `Net of ${num(x.taxRateApplied * 100, 0)}% on the coupons; the pull to par is CGT-exempt (TCGA 1992 s115). Costs ${num((h.gry.semiAnnual - x.netYield.semiAnnual) * 10000, 0)}bp.`
                              : `${h.wrapper} — no tax on the coupons, so net is the gross figure.`}>
                            {x.taxRateApplied > 0 ? `${num(x.netYield.semiAnnual * 100, 2)}% net` : "tax-free"}
                          </span>
                        )}
                        {x.yieldOnCost?.semiAnnual != null && (
                          <span className="block text-[11px] text-[var(--muted)]"
                            title={`Yield locked in at the ${x.yieldOnCost.purchases} purchase${x.yieldOnCost.purchases === 1 ? "" : "s"} you actually made, nominal-weighted — the GRY at each trade's own date and price.${x.yieldOnCost.approx ? " Approximate for a linker: historic index ratios aren't kept, so today's stands in." : ""}`}>
                            {num(x.yieldOnCost.semiAnnual * 100, 2)}% on cost
                          </span>
                        )}
                      </> : "—"}</td>
                    <td className="px-2.5 py-2 num text-right whitespace-nowrap hidden lg:table-cell">
                      {x.duration?.modified != null ? (
                        <span title={`Modified duration ${num(x.duration.modified, 2)} (Macaulay ${num(x.duration.macaulay, 2)}). Not the same as ${num(x.yearsToMaturity, 1)} years to maturity — coupons pull it in.`}>
                          {num(x.duration.modified, 1)}
                          {x.valuePer1pct != null && (
                            <span className="block text-[11px] text-[var(--muted)]" title={`If yields rise 1 percentage point this holding falls about ${gbp0(Math.abs(x.valuePer1pct))} — and recovers it by maturity, since gilts redeem at par.`}>
                              {gbp0(x.valuePer1pct)}/1%
                            </span>
                          )}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-2.5 py-2 num text-right text-[var(--muted)] whitespace-nowrap">{gbp(cash ? h.couponIncomeNext12m : h.couponIncomeNext12mReal)}</td>
                  </tr>
                ); })}
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
                  <span className="num">{gbp(amt(f))}</span>
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
                  A flat (not inflation-uprated) target is a REAL need, so the honest like-for-like is the &ldquo;Today&apos;s money&rdquo; basis — where a conventional gilt&apos;s fixed cash visibly erodes and an index-linked one holds its ground. Switch to &ldquo;Cash expected&rdquo; and both the ladder and the target should be read as future pounds. A gap means either buying more gilts maturing in that year or funding it from elsewhere — and the DMO publishes the whole list, so the button below can say which gilts actually mature then.
                </p>
                <GapFinder ladderRows={ladder.rows} asOf={asOf} />
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

      {/* add a holding — the second half of getting a gilt onto this tab */}
      {registered.length > 0 && <AddGiltTrade registered={registered} onAdd={(row) => setTxns((t) => [...t, { id: uid(), ...row }])} />}

      {/* register */}
      <div ref={registerRef} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
        <RegisteredGilts registered={registered} editing={editing} onEdit={startEdit} onRemove={unregister} diag={diag} />

        <div className="text-sm font-medium pt-1">{editing ? `Edit ${editing}` : "Register a gilt"}</div>
        <GiltPicker dmoDate={dmoReportDate} onPick={(row) => {
          setForm((f) => ({
            ...f, name: row.name, coupon: String(row.coupon), maturity: row.maturity, isin: row.isin,
            indexLinked: row.indexLinked,
            indexRatio: row.indexRatio != null ? String(row.indexRatio) : "",
            indexRatioDate: row.reportDateIso || "",
            indexationLagMonths: row.indexationLagMonths ?? 3,
          }));
          setErrors({});
        }} />

        <EnterSubmits onSubmit={registerGilt} className="grid gap-2 sm:grid-cols-[7rem_1fr_7rem_10rem_11rem_auto] items-start">
          <FormField label="Ticker" error={errors.ticker}>
            <input className="input w-full" placeholder="TG30" value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} aria-invalid={!!errors.ticker} />
          </FormField>
          <FormField label="Name" error={errors.name}>
            <input className="input w-full" placeholder="0.375% Treasury Gilt 2030" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </FormField>
          <FormField label="Coupon %" error={errors.coupon}>
            <input className="input num w-full" inputMode="decimal" placeholder="0.375" value={form.coupon} onChange={(e) => setForm({ ...form, coupon: e.target.value })} aria-invalid={!!errors.coupon} />
          </FormField>
          <FormField label="Redemption" error={errors.maturity}>
            <input className="input w-full" type="date" value={form.maturity} onChange={(e) => setForm({ ...form, maturity: e.target.value })} aria-invalid={!!errors.maturity} />
          </FormField>
          <FormField label="ISIN" error={errors.isin}>
            <input className="input w-full" placeholder="GB00…" value={form.isin} onChange={(e) => setForm({ ...form, isin: e.target.value })} aria-invalid={!!errors.isin} />
          </FormField>
          <FormField label={null}>
            <div className="flex gap-2">
              <button className="btn-accent" onClick={registerGilt}>{editing ? "Save" : "Add"}</button>
              {(editing || form.ticker || form.isin) && (
                <button className="text-xs text-[var(--muted)] hover:text-[var(--fg)] px-1" onClick={() => { setEditing(null); setForm(BLANK_FORM); setErrors({}); }}>Cancel</button>
              )}
            </div>
          </FormField>
        </EnterSubmits>

        <div className="flex flex-wrap items-start gap-3 pt-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!form.indexLinked}
              onChange={(e) => setForm({ ...form, indexLinked: e.target.checked })} />
            Index-linked
          </label>
          {form.indexLinked && (
            <>
              <FormField label="Index ratio" error={errors.indexRatio}>
                <input className="input num w-32 text-right" inputMode="decimal" placeholder="1.59440"
                  value={form.indexRatio} onChange={(e) => setForm({ ...form, indexRatio: e.target.value })} aria-invalid={!!errors.indexRatio} />
              </FormField>
              <FormField label="Ratio as at">
                <input className="input w-40" type="date" value={form.indexRatioDate || ""} onChange={(e) => setForm({ ...form, indexRatioDate: e.target.value })} />
              </FormField>
            </>
          )}
          {errors.indexLinked && <span role="alert" className="text-[11px] text-[var(--loss)] leading-snug self-center max-w-md">{errors.indexLinked}</span>}
        </div>
        {form.indexLinked && (
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Index-linked gilts are quoted in <strong>real</strong> terms, so enter the coupon (0.125 for TG36) and the quoted price as normal — the index ratio is what converts both into money. It&apos;s RPI now ÷ RPI at issue, published daily by the DMO, and it&apos;s refreshed every time you fetch prices. Getting it wrong is not a rounding error: TG36&apos;s ratio is about 1.59, so a missing one values the holding ~37% low. Only 3-month-lag (post-2005) linkers are supported.
          </p>
        )}

        <p className="text-xs text-[var(--muted)] leading-relaxed">
          Registering marks the ticker CGT-exempt (TCGA 1992 s115) and interest-paying, and drives the whole coupon schedule. The ticker must match the one your ledger uses, character for character — that's how the two halves find each other. Conventions: semi-annual coupons anchored at maturity, actual/actual accrued, ex-div 7 business days (weekends only — UK bank holidays not modelled). Either kind is CGT-exempt, and for a linker the exemption covers the whole inflation uplift — only the coupon is taxable.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------ sub-views ----------------------------- */

// The ladder priced as ONE instrument. A list of per-gilt GRYs doesn't
// answer "what am I earning on the £X I have in gilts?" — averaging them
// by value is wrong (a 2-year 4% and a 20-year 4% are not the same 4%), so
// this is a single XIRR over every remaining cashflow against today's
// total dirty value. See core/gilt-portfolio.mjs.
function PortfolioYield({ port, basis, inflation, salary, taxYear, engineRate, taxRate, onTaxRate, profile, anyIL }) {
  const [open, setOpen] = useState(false);
  if (port.semiAnnual == null) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 text-xs text-[var(--muted)]">
        Portfolio yield needs a price for every holding{port.unpriced.length ? ` — ${port.unpriced.join(", ")} ${port.unpriced.length === 1 ? "has" : "have"} none yet` : ""}. Fetch DMO prices above.
      </div>
    );
  }
  const kindLabel = port.kind === "real" ? "real" : port.kind === "nominal-projected" ? "nominal (projected)" : "nominal";
  const gap = port.semiAnnual - (port.netSemiAnnual ?? port.semiAnnual);
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div className="text-sm font-medium flex items-center gap-2"><TrendingUp size={15} className="text-[var(--accent)]" /> Yield to maturity — the ladder as one instrument</div>
        <span className="text-xs text-[var(--muted)]">{port.count} priced holding{port.count === 1 ? "" : "s"}{port.unpriced.length ? ` · ${port.unpriced.join(", ")} unpriced and excluded` : ""}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat big
          label={`Portfolio YTM (${kindLabel})`}
          value={`${num(port.semiAnnual * 100, 2)}%`}
          sub={port.weightedGry != null ? `value-weighted GRY ${num(port.weightedGry * 100, 2)}% as a cross-check` : "one XIRR over every remaining cashflow"} />
        <Stat
          label={taxRate > 0 ? "After tax on coupons" : "No tax on the coupons"}
          value={port.netSemiAnnual != null && taxRate > 0 ? `${num(port.netSemiAnnual * 100, 2)}%` : "—"}
          tone={taxRate > 0 && gap > 0.005 ? "loss" : undefined}
          sub={taxRate > 0 ? `${num(taxRate * 100, 0)}% marginal savings rate costs ${num(gap * 10000, 0)}bp; the pull to par is exempt` : "every gilt here sits in a sheltered wrapper"} />
        <Stat
          label="Modified duration"
          value={port.modifiedDuration != null ? num(port.modifiedDuration, 1) : "—"}
          sub={port.valuePer1pct != null ? `${gbp0(port.valuePer1pct)} if yields rise 1% — recovered by maturity` : undefined} />
        <Stat
          label="Cash still to come"
          value={gbp0(port.cashToCome)}
          sub={`${gbp0(port.totalDirty)} today → ${gbp0(port.remainingGain)} of return left, to ${port.finalMaturity}`} />
      </div>

      <div className="flex items-center gap-3 flex-wrap text-xs">
        <label className="flex items-center gap-1.5 text-[var(--muted)]">
          Coupon tax rate
          <select className="input py-0.5 text-xs" value={taxOverrideValue(taxRate, engineRate)} onChange={(e) => onTaxRate(e.target.value === "auto" ? null : +e.target.value)}>
            <option value="auto">From your salary ({num(engineRate * 100, 0)}%)</option>
            {[0, 0.2, 0.4, 0.45].map((r) => <option key={r} value={r}>{num(r * 100, 0)}%</option>)}
          </select>
        </label>
        <span className="text-[var(--muted)]">
          Derived from the {gbp0(salary)} salary on the Income tab for {taxYear}, on top of this ladder&apos;s own {gbp0(port.taxableCoupons ? port.taxableCoupons : 0)} of unsheltered coupons to maturity.
        </span>
        <button onClick={() => setOpen((o) => !o)} className="text-[var(--accent)] hover:underline ml-auto">{open ? "Hide" : "What these mean, and the maturity profile"}</button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-[var(--border)] pt-3">
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            <strong className="text-[var(--fg)]">Portfolio YTM</strong> is what you earn if you hold every gilt here to redemption: one internal rate of return over today&apos;s {gbp0(port.totalDirty)} dirty value against every coupon and redemption on its own date, quoted semi-annually like the DMO does. It is <em>not</em> the average of the individual GRYs — that average ignores that money committed for twenty years isn&apos;t the same as money committed for two — so the value-weighted figure is shown beside it as a check rather than as the answer.
            {port.kind === "real" && " On today's-money basis this is a REAL yield: what you earn above inflation."}
            {port.kind === "nominal-projected" && ` This is a nominal figure, but your index-linked lines' future cash rests on the ${num(inflation * 100, 1)}% inflation assumption — switch to today's money for the figure that doesn't.`}
            {port.kind === "nominal" && " These are contractual cashflows, so nothing here is forecast."}
          </p>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            <strong className="text-[var(--fg)]">After tax</strong> is the UK reason to hold gilts directly rather than a bond fund: the coupon is taxable savings income unsheltered, the pull from a sub-par price back to £100 is free of CGT (TCGA 1992 s115). So a low-coupon gilt bought at a discount and a high-coupon one bought at a premium can share a gross yield and differ by more than a percentage point net. <strong className="text-[var(--fg)]">Modified duration</strong> is price sensitivity, not time: {port.modifiedDuration != null ? `a 1% rise in yields knocks about ${gbp0(Math.abs(port.valuePer1pct))} off this ladder` : "—"}, which matters if you might sell early and doesn&apos;t if you hold to maturity, because gilts redeem at par regardless.
          </p>
          <MaturityProfileChart profile={profile} basis={basis} anyIL={anyIL} />
        </div>
      )}
    </div>
  );
}
const taxOverrideValue = (taxRate, engineRate) => (taxRate === engineRate ? "auto" : String(taxRate));

// The ladder as a picture: what arrives each calendar year, coupons
// stacked under redemptions. A ladder's whole purpose is the shape of
// this, and it was previously only readable as twelve rows of dates.
function MaturityProfileChart({ profile, basis, anyIL }) {
  if (!profile || profile.length < 2) return null;
  const label = basis === "cash" ? "cash expected" : "today's money";
  return (
    <div>
      <div className="text-xs font-medium mb-1">Maturity profile — {label}{anyIL ? "" : ""}</div>
      <div style={{ height: 180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={profile} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="year" tick={{ fontSize: 11, fill: "var(--muted)" }} />
            <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} width={44} />
            <Tooltip
              contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              formatter={(v, n) => [gbp0(v), n === "coupons" ? "Coupons" : "Redemptions"]}
              labelFormatter={(y) => { const r = profile.find((p) => p.year === y); return r?.redeeming?.length ? `${y} — ${r.redeeming.join(", ")} redeems` : String(y); }} />
            <Bar dataKey="coupons" stackId="a" fill="var(--accent)" radius={[0, 0, 0, 0]} />
            <Bar dataKey="redemptions" stackId="a" fill="var(--m-bb)" radius={[3, 3, 0, 0]} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[11px] text-[var(--muted)] mt-1">Coupons in accent, redemptions on top — a lumpy profile is a reinvestment decision landing all at once; a flat one is a ladder doing its job.</div>
    </div>
  );
}

// The gap years the coverage table just named, matched against the DMO's
// own list of every gilt in issue. Opt-in (it's a fetch), and it only ever
// suggests — the app has no dealing link and shouldn't pretend to.
function GapFinder({ ladderRows, asOf }) {
  const [state, setState] = useState({ status: "idle", curve: null, date: null, message: "" });

  const load = async () => {
    setState({ status: "loading", curve: null, date: null, message: "" });
    try {
      const body = await fetchDmoGiltCatalogue();
      const { rows, date } = shapeGiltCatalogue(body);
      const curve = yieldCurvePoints(rows, asOf);
      setState({ status: "done", curve, date, message: curve.conventional.length ? "" : "The DMO report came back without readable prices." });
    } catch (e) {
      setState({ status: "error", curve: null, date: null, message: (e && e.message) || "Fetch failed." });
    }
  };

  if (state.status === "idle") {
    return <button className="text-xs text-[var(--accent)] hover:underline flex items-center gap-1.5" onClick={load}><Search size={13} /> Find gilts that mature in the gap years, and see today&apos;s yield curve</button>;
  }
  if (state.status !== "done") {
    return <div className={"text-xs " + (state.status === "error" ? "text-[var(--loss)]" : "text-[var(--muted)]")}>{state.status === "loading" ? "Fetching the DMO's list…" : state.message}</div>;
  }
  const gaps = gapSuggestions({ ladderRows, curve: state.curve });
  const withCandidates = gaps.filter((g) => g.candidates.length);
  return (
    <div className="space-y-3 border-t border-[var(--border)] pt-3">
      <YieldCurve curve={state.curve} date={state.date} />
      {gaps.length === 0 ? (
        <div className="text-xs text-[var(--gain)]">No gap years to fill — the ladder covers the target every year.</div>
      ) : (
        <div>
          <div className="text-xs font-medium mb-1">Gilts maturing in your gap years</div>
          <div className="rounded-lg border border-[var(--border)] overflow-x-auto max-h-64 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide sticky top-0">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium">Gap year</th>
                  <th className="text-left px-3 py-1.5 font-medium">Gilt</th>
                  <th className="text-right px-3 py-1.5 font-medium">GRY</th>
                  <th className="text-right px-3 py-1.5 font-medium">Nominal to close it</th>
                  <th className="text-right px-3 py-1.5 font-medium">Cost today</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {withCandidates.flatMap((g) => g.candidates.map((c, i) => (
                  <tr key={g.year + c.isin}>
                    <td className="px-3 py-1.5 num">{i === 0 ? g.year : ""}<span className="block text-[11px] text-[var(--muted)]">{i === 0 ? `${gbp0(g.shortfall)} short` : ""}</span></td>
                    <td className="px-3 py-1.5">{c.name}{c.indexLinked && <span className="ml-1.5 text-[10px] font-semibold text-[var(--accent)]">IL</span>}<span className="block text-[11px] text-[var(--muted)] num">{c.isin} · {c.maturity}</span></td>
                    <td className="px-3 py-1.5 num text-right">{num(c.gry * 100, 2)}%{c.indexLinked && <span className="ml-0.5 text-[10px] text-[var(--m-bb)] align-super">real</span>}</td>
                    <td className="px-3 py-1.5 num text-right">{gbp0(c.nominal)}</td>
                    <td className="px-3 py-1.5 num text-right">{gbp0(c.cost)}</td>
                  </tr>
                )))}
                {withCandidates.length === 0 && <tr><td colSpan={5} className="px-3 py-2 text-xs text-[var(--muted)]">Nothing in issue matures in {gaps.map((g) => g.year).join(", ")} — those years have to be funded from elsewhere.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[var(--muted)] leading-relaxed mt-1">
            Nominal is the face value whose redemption plus final coupon covers that year&apos;s shortfall; cost is that nominal at today&apos;s DMO clean price, and accrued interest is on top. Index-linked lines are shown at their real yield and their nominal ignores future uplift, so they will over-deliver rather than under. This is arithmetic on the DMO&apos;s published list, not advice — nothing here knows your other assets, your tax position beyond the coupon rate above, or what you think rates will do.
          </p>
        </div>
      )}
    </div>
  );
}

// Every gilt in issue, yield against years to maturity, with the two
// families kept apart: a linker's yield is real and a conventional gilt's
// is nominal, so one axis with both would invite exactly the wrong
// comparison.
function YieldCurve({ curve, date }) {
  const conv = curve.conventional.filter((p) => !p.rump);
  if (!conv.length) return null;
  const il = curve.indexLinked.filter((p) => !p.rump);
  return (
    <div>
      <div className="text-xs font-medium mb-1">UK gilt yield curve <span className="font-normal text-[var(--muted)]">— DMO prices dated {date}</span></div>
      <div style={{ height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis type="number" dataKey="years" name="Years" domain={[0, "dataMax"]} tick={{ fontSize: 11, fill: "var(--muted)" }} tickFormatter={(v) => `${Math.round(v)}y`} />
            <YAxis type="number" dataKey="gry" name="GRY" tick={{ fontSize: 11, fill: "var(--muted)" }} tickFormatter={(v) => `${num(v * 100, 1)}%`} width={46} />
            <ZAxis range={[28, 28]} />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              formatter={(v, n) => (n === "GRY" ? [`${num(v * 100, 2)}%`, "GRY"] : [`${num(v, 1)}y`, "To maturity"])}
              labelFormatter={() => ""}
              content={({ payload }) => {
                const p = payload && payload[0] && payload[0].payload;
                if (!p) return null;
                return (
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-xs">
                    <div className="font-medium">{p.name}</div>
                    <div className="num text-[var(--muted)]">{p.maturity} · {num(p.years, 1)}y · {num(p.clean, 2)} clean</div>
                    <div className="num">{num(p.gry * 100, 2)}% {p.indexLinked ? "real" : "GRY"}</div>
                  </div>
                );
              }} />
            {il.length > 0 && <Legend wrapperStyle={{ fontSize: 11 }} />}
            <Scatter name="Conventional (nominal)" data={conv} fill="var(--accent)" />
            {il.length > 0 && <Scatter name="Index-linked (real)" data={il} fill="var(--m-bb)" />}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[11px] text-[var(--muted)] mt-1">{conv.length} conventional{il.length ? ` and ${il.length} index-linked` : ""} gilts in issue. Rump stocks are left out — they barely trade and their quoted yields are not obtainable.</div>
    </div>
  );
}

// Why the ladder is empty, in the specific terms of this user's data. Silent
// on a healthy setup.
function GiltDiagnostics({ diag, onRegister, onEdit, secMeta }) {
  if (diag.clean) return null;
  const Box = ({ children }) => (
    <div className="rounded-xl border border-[color:color-mix(in_srgb,var(--m-bb)_45%,var(--border))] bg-[color:color-mix(in_srgb,var(--m-bb)_8%,transparent)] p-3 flex gap-2.5 text-sm">
      <AlertTriangle size={15} className="text-[var(--m-bb)] shrink-0 mt-0.5" />
      <div className="space-y-1 leading-relaxed">{children}</div>
    </div>
  );
  return (
    <div className="space-y-2">
      {diag.isinConflicts.map((c) => (
        <Box key={c.isin + c.heldAs}>
          <div><span className="font-medium">{c.registeredAs} and {c.heldAs} are the same stock</span> — both carry ISIN {c.isin}, but only {c.registeredAs} is registered as a gilt and only {c.heldAs} has any transactions ({gbp(c.qty)} nominal).</div>
          <div className="text-xs text-[var(--muted)]">Nothing can show until they agree. Either register {c.heldAs} instead, or rename the ledger rows to {c.registeredAs} on the Transactions tab. Broker imports match by ISIN, so this is usually an import that used the broker&apos;s own name for it.</div>
          <button className="text-xs text-[var(--accent)] hover:underline" onClick={() => onRegister({ ticker: c.heldAs, isin: c.isin, coupon: String(secMeta[c.registeredAs]?.coupon ?? ""), maturity: secMeta[c.registeredAs]?.maturity || "", name: secMeta[c.registeredAs]?.name || "" })}>
            Register {c.heldAs} with {c.registeredAs}&apos;s coupon and maturity →
          </button>
        </Box>
      ))}
      {diag.unregistered.map((u) => (
        <Box key={u.ticker}>
          <div><span className="font-medium">{u.ticker} looks like a gilt but isn&apos;t registered as one</span> — {gbp(u.qty)} nominal in your ledger{u.firstDate ? ` since ${u.firstDate}` : ""}.</div>
          <div className="text-xs text-[var(--muted)]">Until it is, it&apos;s treated as an ordinary share: CGT applies to it, and it has no coupon schedule, no accrued interest and no place in the ladder.</div>
          <button className="text-xs text-[var(--accent)] hover:underline" onClick={() => onRegister({ ticker: u.ticker, isin: u.isin || "", name: u.name === u.ticker ? "" : u.name })}>Register {u.ticker} →</button>
        </Box>
      ))}
      {diag.registeredUnheld.map((r) => (
        <Box key={r.ticker}>
          <div><span className="font-medium">{r.ticker} is registered but you don&apos;t hold any</span> — there are no transactions under that exact ticker.</div>
          <div className="text-xs text-[var(--muted)]">Add the purchase below, or if you bought it under a different ticker, <button className="text-[var(--accent)] hover:underline" onClick={() => onEdit(r.ticker, { ...r })}>correct the registration</button> to match the ledger.</div>
        </Box>
      ))}
    </div>
  );
}

function RegisteredGilts({ registered, editing, onEdit, onRemove, diag }) {
  if (!registered.length) return null;
  const unheld = new Set(diag.registeredUnheld.map((r) => r.ticker));
  return (
    <div>
      <div className="text-sm font-medium mb-1.5">Registered gilts</div>
      <div className="rounded-lg border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Ticker</th>
              <th className="text-left px-3 py-1.5 font-medium">Name</th>
              <th className="text-right px-3 py-1.5 font-medium">Coupon</th>
              <th className="text-left px-3 py-1.5 font-medium">Redemption</th>
              <th className="text-left px-3 py-1.5 font-medium">ISIN</th>
              <th className="px-3 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {registered.map(([tk, m]) => (
              <tr key={tk} className={editing === tk ? "bg-[color:color-mix(in_srgb,var(--accent)_10%,transparent)]" : ""}>
                <td className="px-3 py-1.5 font-medium">{tk}{unheld.has(tk) && <span className="ml-1.5 text-[11px] text-[var(--muted)]">not held</span>}</td>
                <td className="px-3 py-1.5 text-[var(--muted)] truncate max-w-56">{m.name || "—"}</td>
                <td className="px-3 py-1.5 num text-right">{num(+m.coupon, 3)}%</td>
                <td className="px-3 py-1.5 num text-xs">{m.maturity}</td>
                <td className="px-3 py-1.5 num text-xs text-[var(--muted)]">{m.isin || <span title="No ISIN, so DMO price fetches will skip it">—</span>}</td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  <button className="text-xs text-[var(--accent)] hover:underline mr-3" onClick={() => onEdit(tk, m)}>Edit</button>
                  <TwoStepDelete onConfirm={() => onRemove(tk)} label={`Un-register ${tk}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Pick a gilt off the DMO's own daily list instead of typing its coupon and
// redemption date. Both are load-bearing: a wrong coupon misprices every
// projected cashflow, and neither is verifiable from inside the app.
function GiltPicker({ onPick, dmoDate }) {
  const [state, setState] = useState({ status: "idle", rows: [], date: null, message: "" });
  const [q, setQ] = useState("");

  const load = async () => {
    setState((s) => ({ ...s, status: "loading", message: "" }));
    try {
      const body = await fetchDmoGiltCatalogue();
      const { rows, date } = shapeGiltCatalogue(body);
      setState({ status: "done", rows, date, dateIso: date ? dmoDateToIso(date) : null, message: rows.length ? "" : "The DMO report came back without any readable coupons — type the gilt in below instead." });
    } catch (e) {
      setState({ status: "error", rows: [], date: null, message: (e && e.message) || "Fetch failed — type the gilt in below instead." });
    }
  };

  const hits = useMemo(() => searchGiltCatalogue(state.rows, q).slice(0, 40), [state.rows, q]);

  if (state.status === "idle") {
    return (
      <button className="text-xs text-[var(--accent)] hover:underline flex items-center gap-1.5" onClick={load}>
        <Search size={13} /> Find it in the DMO&apos;s list instead of typing the coupon and date
      </button>
    );
  }
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel2)] p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <input className="input flex-1 min-w-48" autoFocus placeholder="Search by year, coupon, name or ISIN — e.g. 2030" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="text-[var(--muted)] hover:text-[var(--fg)]" onClick={() => setState({ status: "idle", rows: [], date: null, message: "" })} title="Close" aria-label="Close the gilt picker"><X size={15} /></button>
      </div>
      {state.status === "loading" && <div className="text-xs text-[var(--muted)]">Fetching the DMO&apos;s gilt list…</div>}
      {state.message && <div className="text-xs text-[var(--loss)]">{state.message}</div>}
      {state.status === "done" && state.rows.length > 0 && (
        <>
          <div className="max-h-64 overflow-y-auto rounded border border-[var(--border)] divide-y divide-[var(--border)]">
            {hits.map((r) => (
              <button key={r.isin} disabled={!r.supported}
                onClick={() => r.supported && onPick({ ...r, reportDateIso: state.dateIso || dmoDate || "" })}
                title={r.unsupportedReason || `Fill the form from the DMO's record for ${r.isin}`}
                className={"w-full text-left px-3 py-1.5 text-sm flex items-baseline justify-between gap-3 " + (r.supported ? "hover:bg-[var(--panel)]" : "opacity-45 cursor-not-allowed")}>
                <span>
                  {r.name}
                  {r.indexLinked && r.supported && <span className="ml-1.5 text-[11px] font-semibold text-[var(--accent)]" title={`Index ratio ${num(r.indexRatio, 5)} — worth ${num(r.cashClean, 2)} per £100 nominal, not ${num(r.clean, 2)}`}>IL</span>}
                  {!r.supported && <span className="ml-1.5 text-[11px] text-[var(--m-bb)]">not supported</span>}
                </span>
                <span className="num text-xs text-[var(--muted)] whitespace-nowrap">{r.maturity} · {r.clean != null ? num(r.clean, 2) : "—"}{r.indexLinked && r.cashClean != null ? ` (${num(r.cashClean, 2)} cash)` : ""}</span>
              </button>
            ))}
            {hits.length === 0 && <div className="px-3 py-2 text-xs text-[var(--muted)]">Nothing matches &ldquo;{q}&rdquo;.</div>}
          </div>
          <p className="text-[11px] text-[var(--muted)] leading-relaxed">
            {state.rows.length} gilts in the DMO report dated {state.date}. Picking one fills in the coupon, redemption date, ISIN, name and — for index-linked lines — the index ratio, all from the issuer&apos;s own record — you still supply the ticker, because the DMO doesn&apos;t publish one and it has to match whatever your ledger and broker use. Gilts whose coupon couldn&apos;t be read from the report are left out rather than guessed at.
          </p>
        </>
      )}
    </div>
  );
}

// The other half: creating the holding. Entered in contract-note units (£
// nominal and a clean price per £100), because that's what's on the note and
// the conversion to the app's per-£1 unit is a 100x waiting to happen.
function AddGiltTrade({ registered, onAdd }) {
  const [f, setF] = useState({ ticker: registered[0]?.[0] || "", date: todayISO(), side: "BUY", wrapper: "GIA", nominal: "", clean100: "", fees: "" });
  const [errors, setErrors] = useState({});
  const [done, setDone] = useState("");
  const preview = buildGiltTrade(f);

  const submit = () => {
    const r = buildGiltTrade(f);
    setErrors(r.errors);
    if (!r.ok) return;
    onAdd(r.row);
    setDone(`Added: ${r.row.side} ${gbp(r.row.quantity)} nominal ${r.row.ticker} for ${gbp(r.row.gbpAmount)}.`);
    setF((x) => ({ ...x, nominal: "", clean100: "", fees: "" }));
    setErrors({});
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
      <div className="text-sm font-medium flex items-center gap-2"><Plus size={15} className="text-[var(--accent)]" /> Add a gilt trade</div>
      <EnterSubmits onSubmit={submit} className="grid gap-2 sm:grid-cols-[8rem_9rem_6rem_6rem_8rem_9rem_7rem_auto] items-start">
        <FormField label="Gilt" error={errors.ticker}>
          <select className="input w-full" value={f.ticker} onChange={(e) => setF({ ...f, ticker: e.target.value })}>
            {registered.map(([tk, m]) => <option key={tk} value={tk}>{tk} — {m.coupon}% {String(m.maturity).slice(0, 4)}</option>)}
          </select>
        </FormField>
        <FormField label="Date" error={errors.date}>
          <input className="input w-full" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </FormField>
        <FormField label="Side">
          <select className="input w-full" value={f.side} onChange={(e) => setF({ ...f, side: e.target.value })}><option>BUY</option><option>SELL</option></select>
        </FormField>
        <FormField label="Wrapper">
          <select className="input w-full" value={f.wrapper} onChange={(e) => setF({ ...f, wrapper: e.target.value })}>
            {["GIA", "ISA", "SIPP", "LISA"].map((w) => <option key={w}>{w}</option>)}
          </select>
        </FormField>
        <FormField label="£ nominal" error={errors.nominal}>
          <input className="input num w-full text-right" inputMode="decimal" placeholder="20000" value={f.nominal} onChange={(e) => setF({ ...f, nominal: e.target.value })} aria-invalid={!!errors.nominal} />
        </FormField>
        <FormField label="Clean /£100" error={errors.clean100}>
          <input className="input num w-full text-right" inputMode="decimal" placeholder="84.12" value={f.clean100} onChange={(e) => setF({ ...f, clean100: e.target.value })} aria-invalid={!!errors.clean100} />
        </FormField>
        <FormField label="Fees">
          <input className="input num w-full text-right" inputMode="decimal" placeholder="0" value={f.fees} onChange={(e) => setF({ ...f, fees: e.target.value })} />
        </FormField>
        <FormField label={null}><button className="btn-accent" onClick={submit}>Add</button></FormField>
      </EnterSubmits>
      <p className="text-xs text-[var(--muted)] leading-relaxed">
        {preview.ok
          ? <>Cost recorded: <span className="num font-medium text-[var(--fg)]">{gbp(preview.row.gbpAmount)}</span> ({gbp(preview.consideration)} clean{+f.fees > 0 ? ` + ${gbp(+f.fees)} fees` : ""}). </>
          : <>£ nominal is the face value you bought, not the cash you paid; the price is the clean price per £100 nominal straight off the contract note. </>}
        Accrued interest paid on the purchase is deliberately not added to cost — it&apos;s interest, not price, and it&apos;s handled by the Accrued Income Scheme section above.
        {done && <span className="block text-[var(--gain)] mt-1">{done}</span>}
      </p>
    </div>
  );
}

/* --------------------------- Holdings tab --------------------------- */

export default GiltsTab;
