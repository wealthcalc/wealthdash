import React, { useState, useMemo, useRef } from "react";
import { Landmark, AlertTriangle, Plus, Search, X } from "lucide-react";
import { gbp, WrapperChip, dmoDateToIso, fetchDmoGiltPrices, fetchDmoGiltCatalogue, num, uid, todayISO, Stat, Empty, useSort, sortRows, SortTh, TwoStepDelete } from "../ui/shared.jsx";
import { buildGiltLadder } from "../core/gilt-ladder.mjs";
import {
  validateGiltRegistration, unregisterGiltMeta, giltRegistryDiagnostics,
  shapeGiltCatalogue, searchGiltCatalogue, buildGiltTrade,
} from "../core/gilt-registry.mjs";
import useAppStore from "../state/appStore.js";

const BLANK_FORM = { ticker: "", name: "", coupon: "", maturity: "", isin: "" };

// Raw persisted state from the store via selectors; only DERIVED data
// (`data`, the shell's giltAnalytics output) arrives as a prop — Phase 2.8.
function GiltsTab({ data }) {
  const secMeta = useAppStore((s) => s.secMeta), setSecMeta = useAppStore((s) => s.setSecMeta);
  const prices = useAppStore((s) => s.prices), setPrices = useAppStore((s) => s.setPrices);
  const txns = useAppStore((s) => s.txns), setTxns = useAppStore((s) => s.setTxns);
  const dmoReportDate = useAppStore((s) => s.dmoReportDate), setDmoReportDate = useAppStore((s) => s.setDmoReportDate);
  const [form, setForm] = React.useState(BLANK_FORM);
  const [editing, setEditing] = React.useState(null);   // ticker being edited, or null
  const [errors, setErrors] = React.useState({});
  const [dmoState, setDmoState] = React.useState({ status: "idle", message: "" }); // idle | loading | done | error
  const [sort, toggleSort] = useSort("maturity", "asc");
  const [targetAnnual, setTargetAnnual] = useState(0);
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
    setForm({ ticker: tk, name: m.name || "", coupon: String(m.coupon ?? ""), maturity: m.maturity || "", isin: m.isin || "" });
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

  // A failed analytics run must NOT take the registration panel down with
  // it: that was the previous behaviour, and it meant the one screen where
  // a broken gilt could be fixed disappeared exactly when it was needed.
  const liveBase = (data?.holdings || []).filter((h) => h.nominal > 1e-9).sort((a, b) => a.ticker.localeCompare(b.ticker));
  const live = sortRows(liveBase, sort, {
    ticker: (h) => h.ticker, wrapper: (h) => h.wrapper, maturity: (h) => h.maturity, nominal: (h) => h.nominal,
    clean: (h) => prices[h.ticker] ?? null, accrued: (h) => h.accruedPer100, dirty: (h) => h.dirtyValue,
    nextCoupon: (h) => h.nextCoupon?.date ?? null, gry: (h) => h.gry?.semiAnnual ?? null, coupons12m: (h) => h.couponIncomeNext12m,
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

      {/* add a holding — the second half of getting a gilt onto this tab */}
      {registered.length > 0 && <AddGiltTrade registered={registered} onAdd={(row) => setTxns((t) => [...t, { id: uid(), ...row }])} />}

      {/* register */}
      <div ref={registerRef} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
        <RegisteredGilts registered={registered} editing={editing} onEdit={startEdit} onRemove={unregister} diag={diag} />

        <div className="text-sm font-medium pt-1">{editing ? `Edit ${editing}` : "Register a gilt"}</div>
        <GiltPicker onPick={(row) => {
          setForm((f) => ({ ...f, name: row.name, coupon: String(row.coupon), maturity: row.maturity, isin: row.isin }));
          setErrors({});
        }} />

        <div className="grid gap-2 sm:grid-cols-[7rem_1fr_7rem_10rem_11rem_auto] items-start">
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
        </div>

        <p className="text-xs text-[var(--muted)] leading-relaxed">
          Registering marks the ticker CGT-exempt (TCGA 1992 s115) and interest-paying, and drives the whole coupon schedule. The ticker must match the one your ledger uses, character for character — that's how the two halves find each other. Conventions: semi-annual coupons anchored at maturity, actual/actual accrued, ex-div 7 business days (weekends only — UK bank holidays not modelled). Index-linked gilts are NOT supported: the schedules here assume fixed cash coupons and par redemption, so an IL gilt's figures would be wrong.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------ sub-views ----------------------------- */

// A labelled control that shows WHY it was rejected. The whole point: the
// old form's only response to a bad field was to do nothing at all.
// `label={null}` reserves the same vertical space for a button, so controls
// on the row still line up.
function FormField({ label, error, children }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wide text-[var(--muted)] mb-1" aria-hidden={label == null || undefined}>
        {label == null ? " " : label}
      </span>
      {children}
      {error && <span role="alert" className="block text-[11px] text-[var(--loss)] mt-1 leading-snug">{error}</span>}
    </label>
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
function GiltPicker({ onPick }) {
  const [state, setState] = useState({ status: "idle", rows: [], date: null, message: "" });
  const [q, setQ] = useState("");

  const load = async () => {
    setState((s) => ({ ...s, status: "loading", message: "" }));
    try {
      const body = await fetchDmoGiltCatalogue();
      const { rows, date } = shapeGiltCatalogue(body);
      setState({ status: "done", rows, date, message: rows.length ? "" : "The DMO report came back without any readable coupons — type the gilt in below instead." });
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
                onClick={() => r.supported && onPick(r)}
                title={r.unsupportedReason || `Fill the form from the DMO's record for ${r.isin}`}
                className={"w-full text-left px-3 py-1.5 text-sm flex items-baseline justify-between gap-3 " + (r.supported ? "hover:bg-[var(--panel)]" : "opacity-45 cursor-not-allowed")}>
                <span>{r.name}{!r.supported && <span className="ml-1.5 text-[11px] text-[var(--m-bb)]">not supported</span>}</span>
                <span className="num text-xs text-[var(--muted)] whitespace-nowrap">{r.maturity} · {r.clean != null ? num(r.clean, 2) : "—"}</span>
              </button>
            ))}
            {hits.length === 0 && <div className="px-3 py-2 text-xs text-[var(--muted)]">Nothing matches &ldquo;{q}&rdquo;.</div>}
          </div>
          <p className="text-[11px] text-[var(--muted)] leading-relaxed">
            {state.rows.length} gilts in the DMO report dated {state.date}. Picking one fills in the coupon, redemption date, ISIN and name from the issuer&apos;s own record — you still supply the ticker, because the DMO doesn&apos;t publish one and it has to match whatever your ledger and broker use. Gilts whose coupon couldn&apos;t be read from the report are left out rather than guessed at.
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
      <div className="grid gap-2 sm:grid-cols-[8rem_9rem_6rem_6rem_8rem_9rem_7rem_auto] items-start">
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
      </div>
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
