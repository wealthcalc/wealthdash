import React, { useState, useMemo, useCallback, useRef } from "react";
import { AlertCircle, Download, Wand2, FlaskConical, Check, Printer, Info, Scale } from "lucide-react";
import { ukTaxYear } from "../core/cgt-engine.mjs";
import { cfgFor, aeaForYear, paFor, liabilityForYear, sharesForTargetGain, nextTaxYear, optimiseDisposals } from "../core/uk-tax.mjs";
import { ISA_LIMIT, isaSubscriptionsByYear, realisedForYear, bedAndIsaPlan } from "../core/allowances.mjs";
import { rebalancePlan, BUCKETS, BUCKET_LABEL } from "../core/rebalancing.mjs";
import { KIND_LABEL, store, fmtRate, gbp, gbp0, WrapperChip, SubTabs, num, uid, todayISO, METHOD, CurrencyInput, NumberInput, Field, Stat, Row, MethodChip, Empty } from "../ui/shared.jsx";

function CgtSection(props) {
  const { taxYears, activeYear, setYear, yearDisposals, liab, income, setIncome, carried, setCarried,
    carryForward, exemptGiltDisposalCount, pools, disposals, prices, setPrices, txns,
    allTxns, secMeta, setTxns, positions, yearlyLiab } = props;
  const [sub, setSub] = useState(() => store.get("cgt.cgtsubtab", "summary"));
  React.useEffect(() => store.set("cgt.cgtsubtab", sub), [sub]);
  return (
    <div>
      <SubTabs
        tabs={[["summary", "Summary"], ["planning", "Planning"], ["bedisa", "Bed & ISA"], ["rebalance", "Rebalance"], ["report", "Report"], ["whatif", "What-if"]]}
        active={sub} onChange={setSub}
      />
      {sub === "summary" && <CgtTab {...{ taxYears, activeYear, setYear, yearDisposals, liab, income, setIncome, carried, setCarried, carryForward, exemptGiltDisposalCount }} />}
      {sub === "planning" && <PlanningTab {...{ pools, prices, setPrices, disposals, txns, income }} />}
      {sub === "bedisa" && <BedIsaTab {...{ pools, prices, disposals, income, allTxns, secMeta, setTxns }} />}
      {sub === "rebalance" && <RebalanceTab {...{ positions: positions || [], disposals, income }} />}
      {sub === "report" && <ReportTab {...{ taxYears, disposals, income, carried, yearlyLiab }} />}
      {sub === "whatif" && <WhatIfTab {...{ pools, disposals, income, carried, prices }} />}
    </div>
  );
}

/* --------------------------- Rebalance tool --------------------------- */
// Phase 2, step 6 (redesigned: two-bucket bonds/gilts vs equities, VCTs
// excluded entirely — see core/rebalancing.mjs header for the full
// rationale). Target allocation is just the bonds/equities split, drift vs.
// today's full (all-wrapper, ex-VCT) portfolio, and specific sell candidates
// ranked by tax cost. Targets are persisted per-browser (not part of the
// ledger/backup — they're a live planning input, not portfolio data).
const TARGETS_KEY = "cgt.rebalance.targets";

function RebalanceTab({ positions = [], disposals = [], income = 0 }) {
  const year = ukTaxYear(todayISO());
  const aea = aeaForYear(year);
  const realised = useMemo(() => realisedForYear(disposals, year, aea), [disposals, year, aea]);
  const [aeaOverride, setAeaOverride] = useState(null);
  const effAea = aeaOverride ?? realised.aeaLeft;

  const [targets, setTargets] = useState(() => store.get(TARGETS_KEY, {}));
  React.useEffect(() => store.set(TARGETS_KEY, targets), [targets]);
  const setTarget = (bucket, v) => setTargets((t) => ({ ...t, [bucket]: v === "" ? undefined : +v }));

  const plan = useMemo(() => rebalancePlan({ positions, targets, aeaLeft: effAea }), [positions, targets, effAea]);

  const cfg = cfgFor(year);
  const rate = cfg.rates[cfg.rates.length - 1];
  const marginal = Math.max(0, income - paFor(cfg.pa, income)) > cfg.basicLimit ? rate.higher : rate.basic;

  const vctExcludedValue = useMemo(() => positions
    .filter((p) => p.priced && p.marketValue > 0 && String(p.wrapper).toUpperCase() === "VCT")
    .reduce((s, p) => s + p.marketValue, 0), [positions]);

  if (!plan.total) {
    return <Empty msg="No priced bond/gilt or equity holdings yet — rebalancing needs the Wealth tab's live prices for at least one eligible position (VCTs, cash and unclassified holdings aren't part of this bonds-vs-equities decision)." />;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel2)] text-[var(--muted)]">
        <Info size={14} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
        <span>Spans every wrapper (ISA/SIPP/LISA/GIA), unlike the rest of this tab — rebalancing is a whole-portfolio question, and selling in a sheltered wrapper costs nothing in tax, which is exactly the point of ranking sells the way this does. This is purely a bonds/gilts vs equities decision — VCT holdings are excluded entirely (5-year minimum hold to keep income-tax relief, and a much thinner market to sell in), so they never appear as sell or buy candidates{vctExcludedValue > 0 && <> — currently {gbp0(vctExcludedValue)} of VCT holdings are excluded</>}.</span>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2">Target split — bonds/gilts vs equities</h3>
        <div className="rounded-xl border border-[var(--border)] overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
              <tr>{["Bucket", "Current", "Target %", "Drift"].map((h, i) => (
                <th key={i} className={"px-3 py-2 font-medium " + (i === 0 ? "text-left" : "text-right")}>{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
              {BUCKETS.map((bucket) => {
                const row = plan.rows.find((r) => r.bucket === bucket) || { currentPct: 0, currentValue: 0, driftValue: 0 };
                return (
                  <tr key={bucket}>
                    <td className="px-3 py-2 font-medium">{BUCKET_LABEL[bucket]}</td>
                    <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp0(row.currentValue)} ({row.currentPct.toFixed(1)}%)</td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" min="0" max="100" step="1" value={targets[bucket] ?? ""} onChange={(e) => setTarget(bucket, e.target.value)}
                        className="input num w-20 text-right" placeholder="0" />
                    </td>
                    <td className={"px-3 py-2 num text-right font-medium " + (row.driftValue > 0.5 ? "text-[var(--loss)]" : row.driftValue < -0.5 ? "text-[var(--gain)]" : "text-[var(--muted)]")}>
                      {row.driftValue > 0.5 ? `sell ${gbp0(row.driftValue)}` : row.driftValue < -0.5 ? `buy ${gbp0(-row.driftValue)}` : "on target"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className={"text-xs mt-2 " + (plan.targetsSumTo100 ? "text-[var(--muted)]" : "text-[var(--m-bb)] font-medium")}>
          Targets sum to {plan.targetTotalPct.toFixed(1)}%{!plan.targetsSumTo100 && " — should be 100% for the drift figures above to mean what they say"}.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label={`AEA remaining ${year}`} value={gbp0(realised.aeaLeft)} sub={`net realised so far ${gbp0(Math.max(0, realised.net))} of ${gbp0(aea)}`} />
        <Field label="AEA to use for this plan"><CurrencyInput value={effAea} onChange={setAeaOverride} /></Field>
        <Stat label="Gain realised by sell plan" value={gbp(plan.sells.rows.reduce((s, r) => s + r.estGain, 0))} tone={plan.sells.rows.length ? "loss" : undefined} />
        <Stat label="AEA left after plan" value={gbp0(plan.sells.aeaLeftAfter)} sub={plan.sells.aeaUsed ? `${gbp0(plan.sells.aeaUsed)} used by this plan` : undefined} />
      </div>

      {plan.sells.rows.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Sell candidates — cheapest tax cost first</h3>
          <div className="rounded-xl border border-[var(--border)] overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>{["Ticker", "Wrapper", "Kind", "Sell", "Est. gain", "Tax impact"].map((h, i) => (
                  <th key={i} className={"px-3 py-2 font-medium " + (i <= 2 ? "text-left" : i === 5 ? "text-left" : "text-right")}>{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {plan.sells.rows.map((r) => (
                  <tr key={r.wrapper + r.ticker}>
                    <td className="px-3 py-2 font-medium">{r.ticker}{r.wholePosition && <span className="text-[var(--muted)]"> (all)</span>}</td>
                    <td className="px-3 py-2"><WrapperChip wrapper={r.wrapper} /></td>
                    <td className="px-3 py-2 text-[var(--muted)]">{KIND_LABEL?.[r.kind] || r.kind}</td>
                    <td className="px-3 py-2 num text-right">{gbp(r.sellValue)}</td>
                    <td className={"px-3 py-2 num text-right " + (r.estGain > 0 ? "text-[var(--gain)]" : "text-[var(--muted)]")}>{gbp(r.estGain)}</td>
                    <td className="px-3 py-2 text-xs text-[var(--muted)]">{r.taxImpact}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--muted)] mt-2">
            Est. gain assumes a Section 104 pool disposal — a partial sale realises gain strictly pro-rata to the fraction of the holding sold. Sells beyond your remaining AEA would cost up to {fmtRate(marginal)} at your marginal CGT rate; consider spreading them across tax years (see Planning ▸ multi-year optimiser) or a Bed &amp; ISA move instead of a straight sale.
          </p>
        </div>
      )}

      {plan.buys.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Underweight — where new money could go</h3>
          <div className="rounded-xl border border-[var(--border)] overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>{["Bucket", "Amount needed", "Existing holdings you could add to"].map((h, i) => (
                  <th key={i} className={"px-3 py-2 font-medium " + (i === 1 ? "text-right" : "text-left")}>{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {plan.buys.map((b) => (
                  <tr key={b.bucket}>
                    <td className="px-3 py-2 font-medium">{BUCKET_LABEL[b.bucket]}</td>
                    <td className="px-3 py-2 num text-right text-[var(--gain)]">{gbp(b.amountNeeded)}</td>
                    <td className="px-3 py-2 text-xs text-[var(--muted)]">
                      {b.existingHoldings.length
                        ? b.existingHoldings.map((h) => `${h.ticker} (${h.wrapper}, ${gbp0(h.marketValue)})`).join(", ")
                        : "no existing holding in this bucket — this app won't recommend a specific new fund; pick one that fits your own criteria"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-[11px] text-[var(--muted)] leading-relaxed flex items-start gap-1">
        <Scale size={12} className="mt-0.5 shrink-0" />
        This is a mechanical calculation from targets you set — not a recommendation on what your allocation should be. Sell ranking: sheltered-wrapper and CGT-exempt-gilt holdings first (no tax cost), then GIA holdings at a loss (banks the loss), then GIA gains smallest-gain-fraction first (raises the most cash per pound of AEA used). The 30-day rule still applies to any repurchase of the same line in the GIA — see Planning for that warning.
      </p>
    </div>
  );
}

/* --------------------------- Bed & ISA tool -------------------------- */
// Sell in the GIA, rebuy inside the ISA: gains crystallise against the AEA
// (tax-free up to the remaining exempt amount), the base cost resets, and
// future growth is sheltered. The 30-day rule does NOT match an ISA
// repurchase against the GIA disposal — that's what makes this work.
function BedIsaTab({ pools = {}, prices = {}, disposals = [], income = 0, allTxns = [], secMeta = {}, setTxns }) {
  const year = ukTaxYear(todayISO());
  const aea = aeaForYear(year);
  const realised = useMemo(() => realisedForYear(disposals, year, aea), [disposals, year, aea]);
  const isaUsed = useMemo(() => (isaSubscriptionsByYear(allTxns)[year] || { total: 0 }).total, [allTxns, year]);

  const [aeaLeft, setAeaLeft] = useState(null);   // null = use computed
  const [isaLeft, setIsaLeft] = useState(null);
  const [spread, setSpread] = useState(0.25);     // % round-trip estimate
  const [mode, setMode] = useState("value");
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState("");

  const effAea = aeaLeft ?? realised.aeaLeft;
  const effIsa = isaLeft ?? Math.max(0, ISA_LIMIT - isaUsed);
  const plan = useMemo(
    () => bedAndIsaPlan({ pools, prices, secMeta, aeaLeft: effAea, isaLeft: effIsa, mode, spreadPct: spread / 100 }),
    [pools, prices, secMeta, effAea, effIsa, mode, spread]
  );

  // Marginal CGT rate for the "future tax avoided" estimate (latest rates).
  const cfg = cfgFor(year);
  const rate = cfg.rates[cfg.rates.length - 1];
  const marginal = Math.max(0, income - paFor(cfg.pa, income)) > cfg.basicLimit ? rate.higher : rate.basic;

  const generate = () => {
    if (!setTxns || !plan.rows.length) return;
    const date = todayISO();
    const entries = [];
    for (const r of plan.rows) {
      entries.push({ id: uid(), date, ticker: r.ticker, side: "SELL", quantity: r.shares, nativeCurrency: "GBP", nativeAmount: r.value, fxRate: 1, gbpAmount: r.value, wrapper: "GIA", note: `Bed & ISA ${date} — GIA sale` });
      entries.push({ id: uid(), date, ticker: r.ticker, side: "BUY", quantity: r.shares, nativeCurrency: "GBP", nativeAmount: r.value + r.costs, fxRate: 1, gbpAmount: Math.round((r.value + r.costs) * 100) / 100, wrapper: "ISA", note: `Bed & ISA ${date} — ISA rebuy (incl. est. costs)` });
    }
    setTxns((all) => [...all, ...entries]);
    setConfirming(false);
    setDone(`${plan.rows.length * 2} ledger entries added (${plan.rows.length} GIA sales + ${plan.rows.length} ISA rebuys). The disposals now show in the CGT summary; adjust any figures against your contract notes on the Transactions tab.`);
  };

  if (!Object.keys(pools).length) return <Empty msg="No GIA pools yet — Bed & ISA needs unsheltered holdings to move." />;

  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label={`AEA remaining ${year}`} value={gbp0(realised.aeaLeft)} sub={`net realised so far ${gbp0(Math.max(0, realised.net))} of ${gbp0(aea)}`} />
        <Stat label="ISA allowance remaining" value={gbp0(Math.max(0, ISA_LIMIT - isaUsed))} sub={`purchases in ISA/LISA this year ${gbp0(isaUsed)} (proxy — override below)`} />
        <Stat label="Plan moves" value={gbp0(plan.totalValue)} sub={`${plan.rows.length} holding${plan.rows.length === 1 ? "" : "s"}, est. costs ${gbp(plan.totalCosts)}`} />
        <Stat label="Gain washed tax-free" value={gbp0(plan.totalGain)} sub={`future CGT avoided up to ${gbp0(plan.totalGain * marginal)} at ${fmtRate(marginal)}`} tone="gain" />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <Field label={`AEA to use (computed ${gbp0(realised.aeaLeft)})`}>
          <CurrencyInput value={effAea} onChange={setAeaLeft} />
        </Field>
        <Field label={`ISA room to use (computed ${gbp0(Math.max(0, ISA_LIMIT - isaUsed))})`}>
          <CurrencyInput value={effIsa} onChange={setIsaLeft} />
        </Field>
        <Field label="Spread/dealing estimate (%)">
          <NumberInput value={spread} onChange={setSpread} dp={2} className="w-24" />
        </Field>
        <Field label="Objective">
          <div className="flex gap-1">
            {[["value", "Max value sheltered"], ["gain", "Max gain washed"]].map(([k, label]) => (
              <button key={k} onClick={() => setMode(k)}
                className={"px-3 py-1.5 text-xs rounded-lg border " + (mode === k ? "border-[var(--accent)] text-[var(--fg)] bg-[var(--panel2)]" : "border-[var(--border)] text-[var(--muted)]")}>
                {label}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {plan.rows.length === 0 ? (
        <Empty msg={effAea <= 0 ? "No AEA left this tax year — gains would be taxable, so there's nothing free to wash. Losses can still be bed-and-ISA'd without AEA (sell freely)." : "No priced GIA holdings with unrealised gains fit the current limits."} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-[var(--muted)] text-left bg-[var(--panel2)]">
                <th className="px-3 py-2">Holding</th><th className="px-3 py-2 text-right">Shares to move</th>
                <th className="px-3 py-2 text-right">Value</th><th className="px-3 py-2 text-right">Gain crystallised</th>
                <th className="px-3 py-2 text-right">Est. costs</th><th className="px-3 py-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr key={r.ticker} className="border-t border-[var(--border)]">
                  <td className="px-3 py-1.5 font-medium">{r.ticker}</td>
                  <td className="px-3 py-1.5 text-right num">{num(r.shares, 4)}{r.wholePosition && <span className="text-[var(--muted)]"> (all)</span>}</td>
                  <td className="px-3 py-1.5 text-right num">{gbp(r.value)}</td>
                  <td className="px-3 py-1.5 text-right num text-[var(--gain)]">{gbp(r.gain)}</td>
                  <td className="px-3 py-1.5 text-right num">{gbp(r.costs)}</td>
                  <td className="px-3 py-1.5 text-xs text-[var(--muted)]">{r.stamp > 0 ? "incl. 0.5% stamp on rebuy" : "no stamp (fund/ETF)"}</td>
                </tr>
              ))}
              <tr className="border-t border-[var(--border)] font-semibold bg-[var(--panel2)]">
                <td className="px-3 py-1.5">Total</td><td />
                <td className="px-3 py-1.5 text-right num">{gbp(plan.totalValue)}</td>
                <td className="px-3 py-1.5 text-right num text-[var(--gain)]">{gbp(plan.totalGain)}</td>
                <td className="px-3 py-1.5 text-right num">{gbp(plan.totalCosts)}</td><td />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {plan.rows.length > 0 && setTxns && (
        <div className="flex items-center gap-3 flex-wrap">
          {!confirming ? (
            <button className="btn-accent" onClick={() => setConfirming(true)}>Generate ledger entries…</button>
          ) : (
            <>
              <button className="btn-accent" onClick={generate}>Confirm — add {plan.rows.length * 2} entries at today&apos;s prices</button>
              <button className="px-3 py-2 text-sm rounded-lg border border-[var(--border)]" onClick={() => setConfirming(false)}>Cancel</button>
            </>
          )}
          {done && <span className="text-xs text-[var(--gain)] max-w-md">{done}</span>}
        </div>
      )}

      <p className="text-[11px] text-[var(--muted)] leading-relaxed">
        How this works: selling in the GIA crystallises the gain against your remaining AEA; the same-day repurchase <em>inside the ISA</em> is not matched by the 30-day rule (it applies to repurchases in the same capacity), so the base cost resets and all future growth is sheltered. The rebuy consumes ISA allowance; stamp duty (0.5%) applies to UK shares and investment trusts but not ETFs/funds; spreads and dealing fees are estimates — reconcile the generated entries against contract notes. Gilts never need this: they&apos;re already CGT-exempt.
      </p>
    </div>
  );
}

function CgtTab({ taxYears, activeYear, setYear, yearDisposals, liab, income, setIncome, carried, setCarried, carryForward, exemptGiltDisposalCount = 0 }) {
  if (!taxYears.length) return <Empty msg="No disposals yet. Add or import transactions to see a CGT position." />;
  return (
    <div className="space-y-5">
      {exemptGiltDisposalCount > 0 && (
        <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)]">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--m-same)]" />
          <span>{exemptGiltDisposalCount} gilt disposal{exemptGiltDisposalCount === 1 ? "" : "s"} excluded from every figure below — individual gilts are CGT-exempt (TCGA 1992 s115). See the Gilts tab for their coupon income and accrued interest instead.</span>
        </div>
      )}
      <div className="flex items-end gap-3 flex-wrap">
        <Field label="Tax year">
          <select value={activeYear} onChange={(e) => setYear(e.target.value)} className="input num">
            {taxYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </Field>
        <Field label="Annual income before tax (£)"><input type="number" value={income} onChange={(e) => setIncome(+e.target.value || 0)} className="input num w-44" /></Field>
        <Field label="Losses b/f (before tracked years)"><input type="number" value={carried} onChange={(e) => setCarried(+e.target.value || 0)} className="input num w-52" /></Field>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Net gains" value={gbp(liab.net)} tone={liab.net >= 0 ? "gain" : "loss"} />
        <Stat label="Taxable after AEA" value={gbp(liab.taxable)} />
        <Stat label="CGT due" value={gbp(liab.tax)} tone="loss" big />
        <Stat label="Reporting" value={liab.reporting ? "Required" : "Not required"} sub={liab.reporting ? "tax due or proceeds over threshold" : "below thresholds"} />
      </div>

      <div className="text-xs text-[var(--muted)] num">
        Gains {gbp(liab.gains)} · losses {gbp(liab.losses)} · AEA {gbp(liab.aea)}{liab.usedCarried ? ` · carried losses used ${gbp(liab.usedCarried)}` : ""} ·
        {" "}{liab.breakdown.length ? liab.breakdown.map((b) => `${gbp(b.amount)} @ ${fmtRate(b.rate)}`).join(" + ") : "no taxable gain"} · proceeds {gbp(liab.proceeds)}
        {liab.assumed ? " · rates assumed (year not in table)" : ""}
      </div>
      <div className="text-xs text-[var(--muted)] num -mt-3">
        Income {gbp(income)} − personal allowance {gbp(liab.personalAllowance)} = taxable income {gbp(liab.taxableIncome)}; basic-rate band left for gains {gbp(Math.max(0, cfgFor(activeYear).basicLimit - liab.taxableIncome))}.
      </div>
      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2 text-xs text-[var(--muted)] num -mt-1">
        <span className="font-medium text-[var(--fg)]">Loss pool</span> — brought into {activeYear} {gbp(liab.carriedInto ?? carried)}
        {liab.usedCarried ? ` · used ${gbp(liab.usedCarried)} (only down to the AEA)` : " · none used"}
        {liab.inYearNetLoss ? ` · net loss realised this year ${gbp(liab.inYearNetLoss)}` : ""} · carried out {gbp(liab.carriedOut ?? carried)}.
        {" "}Total unused losses across all tracked years: <span className="font-medium text-[var(--fg)]">{gbp(carryForward || 0)}</span>.
        {carryForward > 0 ? " Remember losses must be claimed within 4 years of the tax year they arose." : ""}
      </div>

      {/* audit trail — the signature element */}
      <div className="space-y-3">
        {yearDisposals.map((d) => (
          <div key={d.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 bg-[var(--panel2)] border-b border-[var(--border)]">
              <div className="flex items-baseline gap-3">
                <span className="font-semibold">{d.ticker}</span>
                <span className="text-sm text-[var(--muted)] num">{d.date} · sold {num(d.quantity, d.quantity % 1 ? 4 : 0)} · proceeds {gbp(d.proceeds)}</span>
              </div>
              <span className={"num font-semibold " + (d.gain >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{gbp(d.gain)}</span>
            </div>
            <div className="divide-y divide-[var(--border)]">
              {d.legs.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 px-4 py-2 text-sm items-center">
                  <div className="col-span-3"><MethodChip m={l.method} /></div>
                  <div className="col-span-2 num text-[var(--muted)]">{num(l.quantity, l.quantity % 1 ? 4 : 0)} sh{l.matchedAcqDate ? "" : ""}</div>
                  <div className="col-span-3 num text-right">cost {gbp(l.cost)}</div>
                  <div className="col-span-2 num text-right text-[var(--muted)]">{gbp(l.proceeds)}</div>
                  <div className={"col-span-2 num text-right font-medium " + (l.gain >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{gbp(l.gain)}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------- Ledger tab ----------------------------- */

function CgtScopeBanner({ tool }) {
  const msg = {
    planning: "This is a CGT tool — it shows GIA holdings only, since ISA, SIPP, LISA and VCT gains aren't taxable. For your full portfolio, see the Wealth and Holdings tabs.",
    report: "CGT report for GIA holdings only. ISA/SIPP/LISA/VCT disposals are CGT-exempt and deliberately excluded (individual gilts too, under TCGA 1992 s115).",
    whatif: "Models the CGT impact of a sale — GIA holdings only, since selling inside ISA/SIPP/LISA/VCT triggers no CGT.",
  }[tool];
  return (
    <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel2)] text-[var(--muted)]">
      <Info size={14} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
      <span>{msg}</span>
    </div>
  );
}

function PlanningTab({ pools, prices, setPrices, disposals, txns, income }) {
  const yearNow = ukTaxYear(todayISO());
  const aea = aeaForYear(yearNow);
  const realised = disposals.filter((d) => d.taxYear === yearNow);
  const realisedNet = realised.reduce((s, d) => s + d.gain, 0);
  const headroom = Math.max(0, aea - realisedNet); // gains realisable tax-free this year
  const tickers = Object.keys(pools).filter((t) => pools[t].qty > 1e-6).sort();

  // 30-day forward warning: buys of the same ticker within the last 30 days.
  const today = new Date(todayISO());
  const recentBuys = {};
  for (const t of txns) {
    if (t.side !== "BUY") continue;
    const days = (today - new Date(t.date)) / 86400000;
    if (days >= 0 && days <= 30) recentBuys[t.ticker] = (recentBuys[t.ticker] || 0) + (+t.quantity);
  }
  // past disposals that were matched under the 30-day rule
  const pastBB = disposals.filter((d) => d.legs.some((l) => l.method === "THIRTY_DAY"));

  const rows = tickers.map((tk) => {
    const { qty, cost } = pools[tk];
    const avg = qty ? cost / qty : 0;
    const price = prices[tk];
    const hasP = price != null && price !== "" && !isNaN(+price);
    const perShare = hasP ? +price - avg : null;
    const maxShares = hasP && perShare > 0 ? Math.min(qty, Math.floor(headroom / perShare)) : null;
    const gainIf = maxShares != null ? maxShares * perShare : null;
    const unreal = hasP ? qty * +price - cost : null;
    return { tk, qty, avg, price: hasP ? price : "", perShare, maxShares, gainIf, unreal, recentBuy: recentBuys[tk] };
  });

  return (
    <div className="space-y-5">
      <CgtScopeBanner tool="planning" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label={`AEA ${yearNow}`} value={gbp(aea).replace(".00", "")} />
        <Stat label="Net gains realised" value={gbp(realisedNet)} tone={realisedNet >= 0 ? "gain" : "loss"} />
        <Stat label="Tax-free headroom left" value={gbp(headroom)} tone="gain" big sub={realisedNet < 0 ? "AEA + realised losses" : "AEA − gains used"} />
        <Stat label="Holdings priced" value={`${rows.filter((r) => r.price !== "").length}/${rows.length}`} />
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2">Harvesting — sell within this year's allowance</h3>
        <div className="rounded-xl border border-[var(--border)] overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
              <tr>{["Ticker", "Avg cost", "Price now", "Gain / share", "Unrealised", "Max shares tax-free", "Gain realised"].map((h, i) => (
                <th key={i} className={"px-3 py-2 font-medium " + (i === 0 ? "text-left" : "text-right")}>{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
              {rows.map((r) => (
                <tr key={r.tk} className="hover:bg-[var(--panel2)]">
                  <td className="px-3 py-2 font-medium">{r.tk}{r.recentBuy ? <AlertCircle size={13} className="inline ml-1 -mt-0.5 text-[var(--m-bb)]" /> : null}</td>
                  <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(r.avg)}</td>
                  <td className="px-3 py-2 text-right">
                    <input type="number" value={r.price} placeholder="—"
                      onChange={(e) => setPrices((p) => ({ ...p, [r.tk]: e.target.value === "" ? undefined : +e.target.value }))}
                      className="input num w-24 text-right py-1" />
                  </td>
                  <td className={"px-3 py-2 num text-right " + (r.perShare == null ? "text-[var(--muted)]" : r.perShare >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.perShare != null ? gbp(r.perShare) : "—"}</td>
                  <td className={"px-3 py-2 num text-right " + (r.unreal == null ? "text-[var(--muted)]" : r.unreal >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.unreal != null ? gbp(r.unreal) : "—"}</td>
                  <td className="px-3 py-2 num text-right font-medium">{r.maxShares != null ? num(r.maxShares, 0) : (r.price === "" ? "—" : "no gain")}</td>
                  <td className="px-3 py-2 num text-right text-[var(--muted)]">{r.gainIf != null ? gbp(r.gainIf) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-[var(--muted)] mt-2">
          "Max shares tax-free" assumes the whole remaining allowance is used on that one holding — the {gbp(headroom).replace(".00", "")} headroom is shared, so you can't stack it across several. Figures assume a clean sale with no repurchase within 30 days.
        </p>
      </div>

      {(Object.keys(recentBuys).length > 0 || pastBB.length > 0) && (
        <div className="rounded-xl border p-4 space-y-2"
          style={{ background: "color-mix(in srgb, var(--m-bb) 10%, transparent)", borderColor: "color-mix(in srgb, var(--m-bb) 35%, transparent)" }}>
          <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: "var(--m-bb)" }}><AlertCircle size={15} /> 30-day (bed &amp; breakfast) rule</h3>
          {Object.keys(recentBuys).length > 0 && (
            <div className="text-sm text-[var(--fg)]">
              You've bought within the last 30 days: {Object.entries(recentBuys).map(([t, q]) => `${num(q, q % 1 ? 2 : 0)} ${t}`).join(", ")}. A sale of the same holding now is matched to that purchase first — not your Section 104 pool — so it won't crystallise the pool gain you might be expecting.
            </div>
          )}
          {pastBB.length > 0 && (
            <div className="text-sm text-[var(--fg)]">
              Past disposals already matched under the 30-day rule: {pastBB.map((d) => `${d.ticker} ${d.date}`).join(", ")}.
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-[var(--muted)]">
        The 30-day rule matches a disposal against any repurchase of the same security in the following 30 days before it touches the pool. To crystallise a pool gain (e.g. to use your allowance), avoid rebuying the same line within 30 days — buy a similar-but-not-identical fund, or repurchase inside an ISA/pension instead.
      </p>

      <MultiYearOptimiser pools={pools} prices={prices} income={income} />
    </div>
  );
}

/* Multi-year gain-harvesting: stagger disposals to soak up each year's AEA
   (and optionally basic-band room) and show how long an embedded gain takes to wash. */
function MultiYearOptimiser({ pools, prices, income }) {
  const yearNow = ukTaxYear(todayISO());
  const [startYear, setStartYear] = useState(yearNow);
  const [years, setYears] = useState(10);
  const [useBasicBand, setUseBasicBand] = useState(false);
  const [growth, setGrowth] = useState(0);

  const startOpts = useMemo(() => { const a = []; let y = yearNow; for (let i = 0; i < 4; i++) { a.push(y); y = nextTaxYear(y); } return a; }, [yearNow]);
  const holdings = useMemo(() => Object.keys(pools).filter((t) => pools[t].qty > 1e-6).map((t) => {
    const { qty, cost } = pools[t]; const p = prices[t];
    return { ticker: t, qty, cost, price: (p != null && p !== "" && !isNaN(+p)) ? +p : NaN };
  }).filter((h) => isFinite(h.price) && h.price > 0), [pools, prices]);

  const result = useMemo(() => {
    if (!holdings.length) return null;
    try { return optimiseDisposals({ holdings, startYear, years: Math.max(1, Math.min(40, +years || 1)), income: +income || 0, useBasicBand, growth: (+growth || 0) / 100 }); }
    catch { return null; }
  }, [holdings, startYear, years, income, useBasicBand, growth]);

  const priced = holdings.length;
  const totalTax = result ? result.schedule.reduce((s, r) => s + r.tax, 0) : 0;

  return (
    <div className="space-y-3 pt-2">
      <h3 className="text-sm font-semibold flex items-center gap-2"><Wand2 size={15} /> Multi-year disposal optimiser</h3>
      <p className="text-xs text-[var(--muted)]">
        Staggers sales across tax years to harvest gains up to each year's annual exempt amount (tax-free){useBasicBand ? ", plus basic-rate band room at 18%," : ""} then resets base cost by rebuying at market (bed-&amp;-ISA or bed-&amp;-spouse to sidestep the 30-day rule). Uses your {priced} priced GIA holding{priced === 1 ? "" : "s"}.
      </p>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
          <Field label="Start tax year"><select value={startYear} onChange={(e) => setStartYear(e.target.value)} className="input w-full">{startOpts.map((y) => <option key={y}>{y}</option>)}</select></Field>
          <Field label="Horizon (years)"><input type="number" min="1" max="40" value={years} onChange={(e) => setYears(e.target.value)} className="input num w-full" /></Field>
          <Field label="Assumed growth %/yr"><input type="number" step="0.5" value={growth} onChange={(e) => setGrowth(e.target.value)} className="input num w-full" /></Field>
          <label className="flex items-center gap-2 text-sm cursor-pointer pb-2"><input type="checkbox" checked={useBasicBand} onChange={(e) => setUseBasicBand(e.target.checked)} className="accent-[var(--accent)]" /> Use basic-rate band (18%)</label>
        </div>
      </div>

      {!priced && <Empty msg="Set current prices on the holdings above (or the Holdings tab) to run the optimiser." />}

      {result && priced > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Embedded gain now" value={gbp(result.startEmbedded)} tone={result.startEmbedded >= 0 ? "gain" : "loss"} />
            <Stat label={useBasicBand ? "Gain washed over horizon" : "Gain washed tax-free"} value={gbp(result.totalWashed)} big tone="gain" />
            <Stat label="Years to clear" value={result.yearsToClear ? `${result.yearsToClear}` : `>${years}`} sub={result.yearsToClear ? "" : "still embedded gain left"} />
            <Stat label="Tax over plan" value={gbp(totalTax)} tone={totalTax > 0 ? "loss" : undefined} sub={useBasicBand ? "basic-band 18%" : "within AEA"} />
          </div>

          <div className="rounded-xl border border-[var(--border)] overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>{["Tax year", "Harvest", "AEA used", "Tax", "Sell", "Cumulative washed", "Gain still embedded"].map((h, i) => (
                  <th key={i} className={"px-3 py-2 font-medium " + (i === 0 || i === 4 ? "text-left" : "text-right")}>{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {result.schedule.map((r) => (
                  <tr key={r.year} className="hover:bg-[var(--panel2)]">
                    <td className="px-3 py-2 num font-medium">{r.year}</td>
                    <td className="px-3 py-2 num text-right">{gbp(r.gainRealised)}</td>
                    <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(r.aeaUsed).replace(".00", "")}</td>
                    <td className={"px-3 py-2 num text-right " + (r.tax > 0 ? "text-[var(--loss)]" : "text-[var(--muted)]")}>{r.tax > 0 ? gbp(r.tax) : "—"}</td>
                    <td className="px-3 py-2 text-[var(--muted)] text-xs">{r.sells.map((s) => `${num(s.shares, s.shares % 1 ? 2 : 0)} ${s.ticker}`).join(", ") || "—"}</td>
                    <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(r.cumulativeWashed)}</td>
                    <td className="px-3 py-2 num text-right">{gbp(r.remainingUnrealised)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--muted)]">
            Each year's harvest sells the highest gain-per-share holdings first and assumes you rebuy at the same price to reset base cost. Growth compounds the price of unsold shares. This models the CGT wash only — dealing costs, spreads and stamp duty on rebuys aren't included, and a bed-&amp;-ISA rebuy also consumes ISA allowance.
          </p>
        </>
      )}
    </div>
  );
}

/* ---------------------------- Report tab ---------------------------- */
function ReportTab({ taxYears, disposals, income, carried, yearlyLiab = {} }) {
  const [ry, setRy] = useState(taxYears[0] || "2025/26");
  const [msg, setMsg] = useState("");
  const yr = taxYears.includes(ry) ? ry : (taxYears[0] || "2025/26");
  const yd = disposals.filter((d) => d.taxYear === yr);
  // Prefer the cross-year chained result (has carriedInto/carriedOut for box
  // 45/47 — losses brought forward can come from any earlier tracked year,
  // not just the single `carried` b/f figure) — same fallback pattern as the
  // Summary sub-tab.
  const liab = yearlyLiab[yr] || liabilityForYear(yd, { income, carriedLosses: carried });
  const totalCost = yd.reduce((s, d) => s + d.cost, 0);
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };

  const csvCell = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // SA108 box numbers verified against the official 2025-26 form (HMRC
  // 12/25 edition, "Listed shares and securities" section, page CG3) —
  // https://assets.publishing.service.gov.uk/media/69bd8990cfa346b9d47049e4/SA108-2026.pdf
  // Boxes 36 (claim/election code) and 34.1 (foreign income & gains regime
  // claim) aren't populated — this app doesn't model either scenario, and a
  // real accountant would leave them blank too rather than guess at a code.
  const sa108Rows = (y, d, l) => {
    const rows = [["Summary (SA108 — Listed shares & securities, page CG3)", `Tax year ${y}`]];
    rows.push(["Number of disposals — box 31", num(d.length, 0)]);
    rows.push(["Disposal proceeds — box 32", l.proceeds.toFixed(2)]);
    rows.push(["Allowable costs (incl. purchase price) — box 33", d.reduce((s, x) => s + x.cost, 0).toFixed(2)]);
    rows.push(["Gains in the year, before losses — box 34", l.gains.toFixed(2)]);
    rows.push(["Losses in the year — box 35", l.losses.toFixed(2)]);
    if (l.usedCarried) rows.push(["Losses brought forward and used in-year — box 45", l.usedCarried.toFixed(2)]);
    rows.push(["Losses available to be carried forward — box 47", (l.carriedOut ?? 0).toFixed(2)]);
    rows.push(["Annual exempt amount (applied automatically by HMRC — not a form box)", l.aea.toFixed(2)]);
    rows.push(["Net taxable gain", l.taxable.toFixed(2)]);
    l.breakdown.forEach((b) => rows.push([`  taxed at ${fmtRate(b.rate)}`, b.amount.toFixed(2), `tax ${b.tax.toFixed(2)}`]));
    rows.push(["CGT due", l.tax.toFixed(2)]);
    rows.push(["Reporting required (SA108 must be filed)", l.reporting ? "Yes" : "No"]);
    return rows;
  };

  const exportCSV = async () => {
    const rows = [["Tax year", "Disposal date", "Security", "Matching method", "Quantity", "Proceeds GBP", "Allowable cost GBP", "Gain/loss GBP"]];
    for (const d of yd) for (const l of d.legs) rows.push([yr, d.date, d.ticker, METHOD[l.method].label, l.quantity, l.proceeds.toFixed(2), l.cost.toFixed(2), l.gain.toFixed(2)]);
    rows.push([], ...sa108Rows(yr, yd, liab));
    const text = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    let dl = false;
    try {
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const a = document.createElement("a"); a.href = url; a.download = `cgt-report-${yr.replace("/", "-")}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); dl = true;
    } catch { /* sandbox */ }
    try { await navigator.clipboard.writeText(text); flash(dl ? "CSV downloaded (also copied)." : "Download blocked here — CSV copied to clipboard."); }
    catch { flash(dl ? "CSV downloaded." : "Couldn't export in this frame — use the deployed app."); }
  };

  // The "pack": every tracked tax year's SA108 figures + full disposal
  // schedule in one file, so a January doesn't mean re-selecting each year
  // one at a time — the whole filing history is in a single download.
  const exportPack = async () => {
    const rows = [["SA108 export pack — all tracked tax years"], ["Generated", todayISO()], []];
    for (const y of taxYears) {
      const yDisp = disposals.filter((d) => d.taxYear === y);
      const yLiab = yearlyLiab[y] || liabilityForYear(yDisp, { income, carriedLosses: carried });
      rows.push([`=== Tax year ${y} ===`]);
      rows.push(["Date", "Security", "Method", "Quantity", "Proceeds GBP", "Allowable cost GBP", "Gain/loss GBP"]);
      for (const d of yDisp) for (const l of d.legs) rows.push([d.date, d.ticker, METHOD[l.method].label, l.quantity, l.proceeds.toFixed(2), l.cost.toFixed(2), l.gain.toFixed(2)]);
      rows.push([], ...sa108Rows(y, yDisp, yLiab), []);
    }
    const text = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    let dl = false;
    try {
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const a = document.createElement("a"); a.href = url; a.download = `sa108-pack-${todayISO()}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); dl = true;
    } catch { /* sandbox */ }
    try { await navigator.clipboard.writeText(text); flash(dl ? `Pack downloaded (${taxYears.length} years, also copied).` : "Download blocked here — pack copied to clipboard."); }
    catch { flash(dl ? "Pack downloaded." : "Couldn't export in this frame — use the deployed app."); }
  };

  if (!taxYears.length) return <Empty msg="No disposals to report. Add or import transactions first." />;
  return (
    <div className="space-y-4">
      <div className="no-print"><CgtScopeBanner tool="report" /></div>
      <div className="flex items-end gap-3 flex-wrap no-print">
        <Field label="Tax year">
          <select value={yr} onChange={(e) => setRy(e.target.value)} className="input num">
            {taxYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </Field>
        <button onClick={() => window.print()} className="btn-accent"><Printer size={15} /> Print / Save as PDF</button>
        <button onClick={exportCSV} className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)]"><Download size={15} /> Download CSV ({yr})</button>
        <button onClick={exportPack} className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)]"
          title={`Every tracked tax year (${taxYears.length}) in one file`}>
          <Download size={15} /> Download SA108 pack (all {taxYears.length} years)
        </button>
        {msg && <span className="text-xs text-[var(--muted)]">{msg}</span>}
      </div>

      {/* printable report */}
      <div className="print-area rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6 space-y-5">
        <div className="flex items-baseline justify-between border-b border-[var(--border)] pb-3">
          <div>
            <h2 className="text-lg font-semibold">Capital Gains Tax computation</h2>
            <p className="text-sm text-[var(--muted)]">Listed shares &amp; securities · Tax year {yr}</p>
          </div>
          <span className="text-xs text-[var(--muted)]">Generated {todayISO()}</span>
        </div>

        <p className="text-xs text-[var(--muted)]">
          Individual UK gilts are excluded throughout this computation — they're CGT-exempt under TCGA 1992 s115. Their coupon income is reported separately as interest (see the Income and Gilts tabs), not here.
        </p>

        <div>
          <h3 className="text-sm font-semibold mb-2">Summary (SA108)</h3>
          <table className="w-full text-sm">
            <tbody className="num">
              {[
                ["Number of disposals — box 31", num(yd.length, 0)],
                ["Disposal proceeds — box 32", gbp(liab.proceeds)],
                ["Allowable costs (incl. purchase price) — box 33", gbp(totalCost)],
                ["Gains in the year, before losses — box 34", gbp(liab.gains)],
                ["Losses in the year — box 35", gbp(liab.losses)],
                ...(liab.usedCarried ? [["Losses brought forward and used in-year — box 45", gbp(liab.usedCarried)]] : []),
                ["Losses available to be carried forward — box 47", gbp(liab.carriedOut ?? 0)],
                ["Annual exempt amount (applied automatically — not a form box)", gbp(liab.aea)],
                ["Net taxable gain", gbp(liab.taxable)],
                ...liab.breakdown.map((b) => [`  taxed at ${fmtRate(b.rate)}`, `${gbp(b.amount)}  →  ${gbp(b.tax)}`]),
              ].map(([k, v], i) => (
                <tr key={i} className="border-b border-[var(--border)]">
                  <td className="py-1.5 font-sans text-[var(--muted)]">{k}</td>
                  <td className="py-1.5 text-right">{v}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-[var(--border)]">
                <td className="py-2 font-sans font-semibold">CGT due</td>
                <td className="py-2 text-right font-semibold text-[var(--loss)]">{gbp(liab.tax)}</td>
              </tr>
            </tbody>
          </table>
          <p className="text-xs text-[var(--muted)] mt-2">Reporting {liab.reporting ? "required" : "not required"} for this year (tax due, or proceeds over the reporting threshold).</p>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Disposal schedule &amp; matching</h3>
          <table className="w-full text-xs">
            <thead className="text-[var(--muted)] border-b border-[var(--border)]">
              <tr>{["Date", "Security", "Method", "Qty", "Proceeds", "Cost", "Gain/loss"].map((h, i) => (
                <th key={i} className={"py-1.5 font-medium " + (i < 3 ? "text-left" : "text-right")}>{h}</th>
              ))}</tr>
            </thead>
            <tbody className="num">
              {yd.map((d) => d.legs.map((l, li) => (
                <tr key={d.id + li} className="border-b border-[var(--border)]">
                  <td className="py-1.5">{li === 0 ? d.date : ""}</td>
                  <td className="py-1.5 font-sans">{li === 0 ? d.ticker : ""}</td>
                  <td className="py-1.5 font-sans">{METHOD[l.method].label}</td>
                  <td className="py-1.5 text-right">{num(l.quantity, l.quantity % 1 ? 4 : 0)}</td>
                  <td className="py-1.5 text-right">{gbp(l.proceeds)}</td>
                  <td className="py-1.5 text-right">{gbp(l.cost)}</td>
                  <td className={"py-1.5 text-right " + (l.gain >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{gbp(l.gain)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-[var(--muted)] pt-2 border-t border-[var(--border)]">
          Prepared as a computation to support a Self Assessment return. HMRC share-identification rules applied: same-day, then 30-day, then Section 104 pool. Not tax advice — verify before filing.
        </p>
      </div>
    </div>
  );
}

/* --------------------------- What-if tab ---------------------------- */
function WhatIfTab({ pools, disposals, income, carried, prices = {} }) {
  const tickers = Object.keys(pools).filter((t) => pools[t].qty > 1e-6);
  const [ticker, setTicker] = useState(tickers[0] || "");
  const tk = ticker && pools[ticker] ? ticker : tickers[0] || "";
  const pool = pools[tk] || { qty: 0, cost: 0 };
  const avg = pool.qty ? pool.cost / pool.qty : 0;

  const [priceEdited, setPriceEdited] = useState(false);
  const [priceRaw, setPriceRaw] = useState("");
  // default the price from the Holdings tab unless the user has typed their own
  const price = priceEdited ? priceRaw : (prices[tk] != null ? String(prices[tk]) : "");
  const setPrice = (v) => { setPriceEdited(true); setPriceRaw(v); };
  const [sellQty, setSellQty] = useState("");
  const yearNow = ukTaxYear(todayISO());
  const realisedThisYear = disposals.filter((d) => d.taxYear === yearNow);
  const base = liabilityForYear(realisedThisYear, { income, carriedLosses: carried });

  const p = +price || 0, q = Math.min(+sellQty || 0, pool.qty);
  const hypo = q > 0 && p > 0 ? { date: todayISO(), ticker: tk, quantity: q, proceeds: q * p, gain: q * p - avg * q, taxYear: yearNow, legs: [], cost: avg * q } : null;
  const withHypo = hypo ? liabilityForYear([...realisedThisYear, hypo], { income, carriedLosses: carried }) : base;
  const marginalTax = withHypo.tax - base.tax;

  const aeaHeadroom = Math.max(0, aeaForYear(yearNow) - base.net);
  const maxSharesAea = p > 0 ? sharesForTargetGain(pool.qty, pool.cost, p, aeaHeadroom) : 0;

  if (!tickers.length) return <Empty msg="No open GIA holdings to model. CGT only applies to unsheltered holdings — add GIA buy transactions first." />;
  return (
    <div className="space-y-5">
      <CgtScopeBanner tool="whatif" />
      <div className="flex items-end gap-3 flex-wrap">
        <Field label="Holding">
          <select value={tk} onChange={(e) => { setTicker(e.target.value); setPriceEdited(false); setPriceRaw(""); }} className="input">{tickers.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Price now (GBP/share)"><input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 60.00" className="input num w-36" /></Field>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Pool quantity" value={num(pool.qty, pool.qty % 1 ? 4 : 0)} />
        <Stat label="Pool cost" value={gbp(pool.cost)} />
        <Stat label="Average cost" value={gbp(avg)} />
        <Stat label={`Realised ${yearNow}`} value={gbp(base.net)} tone={base.net >= 0 ? "gain" : "loss"} />
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        {/* scenario A */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
          <h3 className="font-semibold text-sm flex items-center gap-2"><FlaskConical size={15} className="text-[var(--accent)]" /> Sell a quantity</h3>
          <Field label="Shares to sell"><input type="number" value={sellQty} onChange={(e) => setSellQty(e.target.value)} className="input num w-full" /></Field>
          {hypo ? (
            <div className="text-sm space-y-1 num">
              <Row k="Proceeds" v={gbp(hypo.proceeds)} />
              <Row k="Cost (pool avg)" v={gbp(hypo.cost)} />
              <Row k="Gain on sale" v={gbp(hypo.gain)} tone={hypo.gain >= 0 ? "gain" : "loss"} />
              <div className="h-px bg-[var(--border)] my-1" />
              <Row k="CGT before" v={gbp(base.tax)} />
              <Row k="CGT after" v={gbp(withHypo.tax)} />
              <Row k="Marginal CGT" v={gbp(marginalTax)} tone="loss" bold />
            </div>
          ) : <p className="text-sm text-[var(--muted)]">Enter a price and quantity to model the disposal.</p>}
        </div>

        {/* scenario B */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
          <h3 className="font-semibold text-sm flex items-center gap-2"><Check size={15} className="text-[var(--gain)]" /> Stay within the {gbp(aeaForYear(yearNow)).replace(".00", "")} allowance</h3>
          {p > 0 ? (
            <div className="text-sm space-y-1 num">
              <Row k="AEA headroom left" v={gbp(aeaHeadroom)} />
              <Row k="Gain per share" v={gbp(p - avg)} />
              <Row k="Max shares, tax-free" v={num(maxSharesAea, 0) + " sh"} tone="gain" bold />
              <p className="text-xs text-[var(--muted)] pt-1 font-sans">Clean sale, no repurchase within 30 days. Selling more triggers CGT on the excess at your marginal rate.</p>
            </div>
          ) : <p className="text-sm text-[var(--muted)]">Enter a current price to see how many shares fit inside this year's allowance.</p>}
        </div>
      </div>
    </div>
  );
}

/* --------------------------- Import tab ----------------------------- */

export default CgtSection;
