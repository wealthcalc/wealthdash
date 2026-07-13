import React, { useMemo } from "react";
import { AlertTriangle, Check, Info } from "lucide-react";
import { ukTaxYear } from "../core/cgt-engine.mjs";
import { aeaForYear, investmentIncomeTax } from "../core/uk-tax.mjs";
import {
  ISA_LIMIT, LISA_LIMIT, isaSubscriptionsByYear, pensionAllowanceStatus, realisedForYear,
} from "../core/allowances.mjs";
import { gbp0, num, todayISO, CurrencyInput, Field } from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";

/* ======================================================================
   ALLOWANCES HUB — one screen for the annual limits that actually drive
   UK tax planning: ISA/LISA subscriptions, pension annual allowance
   (taper + carry-forward), CGT annual exempt amount, dividend allowance
   and personal savings allowance. Everything is computed from the ledger
   where possible, with the caveats stated inline, and a manual override
   wherever the ledger can't know the truth.

   `overrides`/`setOverrides` are lifted to the app store (see
   state/appStore.js's `allowanceOverrides`) rather than owned locally —
   they used to live in component state backed by their own ad-hoc
   localStorage write, which meant they were invisible to the IndexedDB
   durable mirror, the daily snapshot, AND the JSON backup/restore. A user
   who saved a backup, restored it, or hit a localStorage eviction would
   silently lose their override figures while everything else came back.
   ====================================================================== */

function Gauge({ label, used, limit, sub, warnOver = true }) {
  const pctUsed = limit > 0 ? Math.min(1, used / limit) : 0;
  const over = warnOver && used > limit + 0.005;
  const left = Math.max(0, limit - used);
  const colour = over ? "var(--loss)" : pctUsed > 0.9 ? "var(--m-bb)" : "var(--gain)";
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold">{label}</div>
        <div className="text-xs text-[var(--muted)] num">{gbp0(used)} / {gbp0(limit)}</div>
      </div>
      <div className="mt-2 h-2 rounded-full bg-[var(--panel2)] overflow-hidden" role="progressbar"
        aria-valuenow={Math.round(pctUsed * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full" style={{ width: `${pctUsed * 100}%`, background: colour }} />
      </div>
      <div className={"mt-1.5 text-xs num " + (over ? "text-[var(--loss)] font-semibold" : "text-[var(--muted)]")}>
        {over ? <>Over by {gbp0(used - limit)} — check the figures below</> : <>{gbp0(left)} remaining</>}
      </div>
      {sub && <div className="mt-1 text-xs text-[var(--muted)] leading-snug">{sub}</div>}
    </div>
  );
}

// Phase 2.8 de-drilling: raw state from the store; derived (eriTxns,
// taxableDisposals) stays props from the shell.
export default function AllowancesTab({ eriTxns = [], taxableDisposals = [] }) {
  const txns = useAppStore((s) => s.txns);
  const pensionCashflows = useAppStore((s) => s.pensionCashflows);
  const incomeEntries = useAppStore((s) => s.incomeEntries);
  const income = useAppStore((s) => s.income);
  const overrides = useAppStore((s) => s.allowanceOverrides), setOverrides = useAppStore((s) => s.setAllowanceOverrides);
  const year = ukTaxYear(todayISO());
  const ov = overrides[year] || {};
  const setOv = (k, v) => setOverrides && setOverrides((o) => ({ ...o, [year]: { ...(o[year] || {}), [k]: v } }));

  // --- ISA / LISA — a SINGLE combined £20,000 allowance; LISA subscriptions
  // count inside it, they don't sit alongside it. Overriding either figure
  // must feed the same combined total, so the two overrides are kept
  // separate (ISA-only, LISA-only) and summed for the combined check —
  // previously the "isa" override was treated as if it already included
  // LISA, so overriding LISA alone left the combined figure stale (the
  // actual bug behind "limits should be looked at across").
  const isaByYear = useMemo(() => isaSubscriptionsByYear(txns), [txns]);
  const computedIsa = isaByYear[year] || { ISA: 0, LISA: 0, total: 0 };
  const isaOnlyUsed = ov.isaOnly != null ? +ov.isaOnly : computedIsa.ISA;
  const lisaUsed = ov.lisa != null ? +ov.lisa : computedIsa.LISA;
  const combinedIsaUsed = isaOnlyUsed + lisaUsed;

  // --- pension AA ---
  const pension = useMemo(
    () => pensionAllowanceStatus({ cashflows: pensionCashflows, year, adjustedIncome: income }),
    [pensionCashflows, year, income]
  );
  const pensionUsed = ov.pension != null ? +ov.pension : pension.used;
  const pensionHeadroom = Math.max(0, pension.aa - pensionUsed);

  // --- CGT AEA ---
  const aea = aeaForYear(year);
  const realised = useMemo(() => realisedForYear(taxableDisposals, year, aea), [taxableDisposals, year, aea]);

  // --- dividend allowance + PSA (GIA-taxable income only) ---
  const taxableIncome = useMemo(() => {
    let dividends = 0, interest = 0;
    for (const e of incomeEntries) {
      if (!e.date || !e.amount || ukTaxYear(e.date) !== year) continue;
      if ((e.wrapper || "GIA") !== "GIA") continue;
      if (e.kind === "interest") interest += +e.amount; else dividends += +e.amount;
    }
    for (const t of eriTxns) {
      if (!t.date || ukTaxYear(t.date) !== year) continue;
      if (t._eri?.treatment === "interest") interest += t._gbp || 0; else dividends += t._gbp || 0;
    }
    return { dividends, interest };
  }, [incomeEntries, eriTxns, year]);
  const incomeTax = useMemo(
    () => investmentIncomeTax({ salary: income, interest: taxableIncome.interest, dividends: taxableIncome.dividends, year }),
    [income, taxableIncome, year]
  );

  const daysToYearEnd = useMemo(() => {
    const endYear = Number(year.split("/")[0]) + 1;
    return Math.max(0, Math.ceil((Date.UTC(endYear, 3, 5) - Date.now()) / 86400000));
  }, [year]);

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold">Tax-year allowances — {year}</h2>
        <div className={"text-xs " + (daysToYearEnd <= 60 ? "text-[var(--m-bb)] font-semibold" : "text-[var(--muted)]")}>
          {daysToYearEnd} days until 5 April
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Gauge label="ISA + LISA combined" used={combinedIsaUsed} limit={ISA_LIMIT}
          sub={<>ISA-only {gbp0(isaOnlyUsed)} + LISA {gbp0(lisaUsed)} = {gbp0(combinedIsaUsed)} of the single {gbp0(ISA_LIMIT)} allowance — LISA doesn't sit alongside it, it's carved out of it. Derived from ISA/LISA purchases this tax year — an upper bound, since purchases funded by sales inside the ISA aren't new subscriptions. Override either figure below if you know the true numbers.</>} />
        <Gauge label="LISA (within the combined limit)" used={lisaUsed} limit={LISA_LIMIT}
          sub={<>25% government bonus on contributions until age 50; the {gbp0(LISA_LIMIT)} cap sits inside the combined {gbp0(ISA_LIMIT)} allowance above, not alongside it.</>} />
        <Gauge label={`Pension annual allowance${pension.tapered ? " (tapered)" : ""}`} used={pensionUsed} limit={pension.aa} warnOver={false}
          sub={<>
            From recorded contributions ({gbp0(pension.used)}). Taper tested against the app's income figure ({gbp0(income)}) as a proxy for <em>adjusted</em> income — add employer contributions to that figure mentally, or override below.
            {pensionUsed > pension.aa && (pensionUsed - pension.aa <= pension.carryTotal
              ? <> Over this year&apos;s allowance by {gbp0(pensionUsed - pension.aa)}, covered by carry-forward.</>
              : <> <span className="text-[var(--loss)] font-semibold">Exceeds allowance + carry-forward by {gbp0(pensionUsed - pension.aa - pension.carryTotal)} — an annual allowance charge likely applies.</span></>)}
          </>} />
        <Gauge label="CGT annual exempt amount" used={Math.max(0, realised.net)} limit={aea}
          sub={<>Net realised gains so far: gains {gbp0(realised.gains)} − losses {gbp0(realised.losses)}. {realised.aeaLeft > 0 ? <>Room to harvest {gbp0(realised.aeaLeft)} of gains tax-free — see CGT ▸ Bed &amp; ISA.</> : <>AEA fully used.</>}</>} />
        <Gauge label="Dividend allowance" used={taxableIncome.dividends} limit={incomeTax.divAllow} warnOver={false}
          sub={<>GIA dividends + ERI treated as dividends. Above the allowance they're taxed at your marginal dividend rate ({incomeTax.band} band). Estimated dividend tax this year: {gbp0(incomeTax.dividendTax)}.</>} />
        <Gauge label="Personal savings allowance" used={taxableIncome.interest} limit={incomeTax.psa} warnOver={false}
          sub={<>GIA interest incl. gilt coupons. {incomeTax.psa === 0 ? "Additional-rate taxpayers get no PSA." : `£${num(incomeTax.psa, 0)} at your band.`} Estimated interest tax this year: {gbp0(incomeTax.interestTax)}.</>} />
      </div>

      {/* pension carry-forward detail */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="text-sm font-semibold mb-2">Pension carry-forward (three previous years)</div>
        <table className="text-sm w-full max-w-lg">
          <thead>
            <tr className="text-xs text-[var(--muted)] text-left">
              <th className="py-1 pr-4">Tax year</th><th className="py-1 pr-4 text-right">Allowance</th>
              <th className="py-1 pr-4 text-right">Contributed</th><th className="py-1 text-right">Unused</th>
            </tr>
          </thead>
          <tbody>
            {pension.carry.map((c) => (
              <tr key={c.year} className="border-t border-[var(--border)]">
                <td className="py-1 pr-4">{c.year}</td>
                <td className="py-1 pr-4 text-right num">{gbp0(c.allowance)}</td>
                <td className="py-1 pr-4 text-right num">{gbp0(c.used)}</td>
                <td className={"py-1 text-right num " + (c.unused > 0 ? "text-[var(--gain)]" : "text-[var(--muted)]")}>{gbp0(c.unused)}</td>
              </tr>
            ))}
            <tr className="border-t border-[var(--border)] font-semibold">
              <td className="py-1 pr-4">Total available {year}</td>
              <td className="py-1 pr-4 text-right num">{gbp0(pension.aa)}</td>
              <td className="py-1 pr-4 text-right num">{gbp0(pensionUsed)}</td>
              <td className="py-1 text-right num text-[var(--gain)]">{gbp0(pensionHeadroom + pension.carryTotal)}</td>
            </tr>
          </tbody>
        </table>
        <p className="text-xs text-[var(--muted)] mt-2 leading-snug flex items-start gap-1">
          <Info size={12} className="mt-0.5 shrink-0" />
          Carry-forward requires membership of a registered scheme in the year carried from (usually true), is used earliest-year-first, and each year's taper is tested against that year's adjusted income — shown here using the current income figure as a proxy for all years. Contributions must also not exceed relevant UK earnings for personal tax relief.
        </p>
      </div>

      {/* manual overrides */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="text-sm font-semibold mb-2">Overrides (where the ledger can&apos;t know)</div>
        <div className="flex flex-wrap gap-4">
          <Field label={`ISA-only subscribed ${year} (blank = computed ${gbp0(computedIsa.ISA)})`}>
            <CurrencyInput value={ov.isaOnly ?? computedIsa.ISA} onChange={(v) => setOv("isaOnly", v)} />
          </Field>
          <Field label={`LISA paid in ${year} (blank = computed ${gbp0(computedIsa.LISA)})`}>
            <CurrencyInput value={ov.lisa ?? computedIsa.LISA} onChange={(v) => setOv("lisa", v)} />
          </Field>
          <Field label={`Pension input ${year} incl. employer (blank = recorded ${gbp0(pension.used)})`}>
            <CurrencyInput value={ov.pension ?? pension.used} onChange={(v) => setOv("pension", v)} />
          </Field>
          {(ov.isaOnly != null || ov.lisa != null || ov.pension != null) && setOverrides && (
            <button className="btn-accent self-end" onClick={() => setOverrides((o) => ({ ...o, [year]: {} }))}>
              <Check size={14} /> Reset to computed
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-[var(--muted)] leading-relaxed flex items-start gap-1">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        Estimates to support your own planning, not tax advice. Allowance figures are the app&apos;s configured {year} parameters — verify against current HMRC guidance, especially after a Budget.
      </p>
    </div>
  );
}
