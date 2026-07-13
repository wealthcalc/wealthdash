import React, { useState, useMemo } from "react";
import { Building2, PlusCircle, AlertTriangle, Info, ChevronDown, ChevronUp } from "lucide-react";
import {
  holdingSummary, cgtExemptionStatus, reliefByYear, lossReliefEligible, privateTotals,
  PRIVATE_TYPES, TYPE_LABEL, RELIEF_RATE, EIS_ANNUAL_CAP, EIS_ANNUAL_CAP_KI, SEIS_ANNUAL_CAP,
} from "../core/private-investments.mjs";
import { gbp, gbp0, num, uid, todayISO, Field, Stat, Empty, TwoStepDelete, RateCell } from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";

/* ======================================================================
   PRIVATE INVESTMENTS — EIS/SEIS shares and LP fund commitments (e.g. a
   direct EIS holding, or a venture LP like "Passion Capital IV"/"JamJar
   Fund II"). No market price exists for any of these, so — unlike every
   priced holding elsewhere in the app — a holding here is valued manually
   and money moves via irregular capital-call/distribution EVENTS rather
   than buy/sell transactions. All the maths (MOIC, XIRR, EIS/SEIS income
   tax relief with its own annual cap, the 3-year CGT exemption clock, and
   EIS/SEIS loss relief against income) lives in
   core/private-investments.mjs and is node-tested; this is pure display +
   CRUD over it, same split as the Property tab.
   ====================================================================== */

const TYPE_CHIP = {
  EIS: "text-[var(--gain)] border-[var(--gain)]",
  SEIS: "text-[var(--m-pool)] border-[var(--m-pool)]",
  LP: "text-[var(--accent)] border-[var(--accent)]",
  other: "text-[var(--muted)] border-[var(--border)]",
};
function TypeChip({ type }) {
  return <span className={"text-[11px] font-semibold px-1.5 py-0.5 rounded-full border " + (TYPE_CHIP[type] || TYPE_CHIP.other)}>{TYPE_LABEL[type] || type}</span>;
}

const EVENT_LABEL = { call: "Capital call / investment", distribution_capital: "Distribution — capital", distribution_income: "Distribution — income", write_off: "Write-off" };

const HOLDING_BLANK = () => ({
  id: uid(), name: "", entity: "", type: "LP", shareIssueDate: "", reliefPct: RELIEF_RATE.LP,
  currentValuation: "", valuationAsOf: "", certificateRef: "", notes: "",
});
const EVENT_BLANK = (holdingId) => ({ id: uid(), holdingId, date: todayISO(), type: "call", amount: "", notes: "" });

// Phase 2.8 de-drilling: all raw persisted state from the store.
function PrivateTab() {
  const holdings = useAppStore((s) => s.privateHoldings), setHoldings = useAppStore((s) => s.setPrivateHoldings);
  const events = useAppStore((s) => s.privateEvents), setEvents = useAppStore((s) => s.setPrivateEvents);
  const [form, setForm] = useState(HOLDING_BLANK());
  const [eventForms, setEventForms] = useState({}); // holdingId -> draft event
  const [expanded, setExpanded] = useState({});     // holdingId -> bool (event ledger open)

  const today = todayISO();
  const totals = useMemo(() => privateTotals(holdings, events, today), [holdings, events, today]);
  const relief = useMemo(() => reliefByYear(holdings, events), [holdings, events]);

  const addHolding = () => {
    if (!form.name.trim()) return;
    setHoldings((h) => [...h, {
      ...form, name: form.name.trim(), entity: form.entity.trim(),
      reliefPct: form.reliefPct === "" ? null : +form.reliefPct,
      currentValuation: form.currentValuation === "" ? 0 : +form.currentValuation,
      valuationAsOf: form.currentValuation === "" ? "" : (form.valuationAsOf || today),
    }]);
    setForm(HOLDING_BLANK());
  };
  const updateHolding = (id, patch) => setHoldings((h) => h.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeHolding = (id) => { setHoldings((h) => h.filter((x) => x.id !== id)); setEvents((e) => e.filter((x) => x.holdingId !== id)); };

  const eventForm = (holdingId) => eventForms[holdingId] || EVENT_BLANK(holdingId);
  const setEventForm = (holdingId, patch) => setEventForms((f) => ({ ...f, [holdingId]: { ...eventForm(holdingId), ...patch } }));
  const addEvent = (holdingId) => {
    const ev = eventForm(holdingId);
    if (!ev.date) return;
    if (ev.type !== "write_off" && !(+ev.amount > 0)) return;
    setEvents((e) => [...e, { ...ev, id: uid(), amount: ev.type === "write_off" ? 0 : +ev.amount, notes: ev.notes.trim() }]);
    setEventForms((f) => ({ ...f, [holdingId]: EVENT_BLANK(holdingId) }));
  };
  const removeEvent = (id) => setEvents((e) => e.filter((x) => x.id !== id));

  const reliefYears = Object.keys(relief).sort((a, b) => (a < b ? 1 : -1));
  const anyOverCap = reliefYears.some((y) => relief[y].EIS.overCap || relief[y].SEIS.overCap);

  return (
    <div className="space-y-5">
      {/* headline */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Stat label="Capital called" value={holdings.length ? gbp0(totals.called) : "—"} sub={`${holdings.length} holding${holdings.length === 1 ? "" : "s"}`} />
        <Stat label="Distributed" value={gbp0(totals.totalReturned)} sub={`${gbp0(totals.distCapital)} capital + ${gbp0(totals.distIncome)} income`} />
        <Stat label="Current valuation" value={gbp0(totals.currentValue)} sub="manually entered — no live price exists" />
        <Stat label="Net MOIC" value={totals.moic != null ? `${num(totals.moic, 2)}×` : "—"} sub="(distributed + valuation) / called" tone={totals.moic != null ? (totals.moic >= 1 ? "gain" : "loss") : undefined} />
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--muted)] font-medium">Blended XIRR</div>
          <div className="mt-1"><RateCell r={totals.irr} /></div>
        </div>
      </div>

      <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel2)] text-[var(--muted)]">
        <Info size={14} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
        <span>Tracks money in (capital calls), money out (distributions), and a manual valuation for EIS/SEIS direct investments and LP/VC funds — none of these are exchange-traded, so there's no live price and no Section 104 pool the way there is for a normal GIA holding. CGT on a taxable (non-exempt) distribution or exit isn't computed here — enter it as a manual disposal in the CGT section, or via your accountant, once it happens. EIS/SEIS income tax relief, the 3-year CGT exemption clock, and loss relief against income are estimated below from the 2025/26 rules — a guide for your return, not a filing.</span>
      </div>

      {anyOverCap && (
        <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-[var(--loss)]" style={{ background: "color-mix(in srgb, var(--loss) 10%, transparent)" }}>
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          One or more tax years have EIS or SEIS investment above the annual income-tax-relief cap — see the table below. Relief above the cap isn't available (EIS excess may still qualify if it's in knowledge-intensive companies, not distinguished here).
        </div>
      )}

      {/* holdings */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Building2 size={15} className="text-[var(--accent)]" /> Holdings</h3>
        {!holdings.length && <Empty msg="No private holdings yet. Add an EIS/SEIS company or an LP/VC fund below, then log its capital calls and any distributions as they happen." />}
        <div className="grid gap-3 sm:grid-cols-2">
          {holdings.map((h) => {
            const s = holdingSummary(h, events, today);
            const cgt = cgtExemptionStatus(h, today);
            const lr = lossReliefEligible(h, events);
            const isOpen = !!expanded[h.id];
            const holdingEvents = events.filter((e) => e.holdingId === h.id).sort((a, b) => (a.date < b.date ? 1 : -1));
            const ef = eventForm(h.id);
            return (
              <div key={h.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium flex items-center gap-1.5">{h.name} <TypeChip type={h.type} /></div>
                    <div className="text-xs text-[var(--muted)]">{h.entity || "—"}{h.shareIssueDate && <> · issued {h.shareIssueDate}</>}</div>
                  </div>
                  <TwoStepDelete onConfirm={() => removeHolding(h.id)} label={`Remove ${h.name}`} />
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <span className="text-[var(--muted)]">Called</span><span className="num text-right">{gbp(s.called)}</span>
                  <span className="text-[var(--muted)]">Distributed</span><span className="num text-right">{gbp(s.totalReturned)}</span>
                  <span className="text-[var(--muted)]">MOIC</span><span className="num text-right">{s.moic != null ? `${num(s.moic, 2)}×` : "—"}</span>
                  <span className="text-[var(--muted)]">IRR</span><span className="text-right"><RateCell r={s.irr} /></span>
                </div>

                {/* valuation */}
                <div className="pt-2 border-t border-[var(--border)] flex items-center gap-2">
                  <span className="text-xs text-[var(--muted)] shrink-0">{s.writtenOff ? "Written off" : "Current valuation"}</span>
                  {!s.writtenOff && (
                    <>
                      <input type="number" value={h.currentValuation ?? ""} onChange={(e) => updateHolding(h.id, { currentValuation: e.target.value === "" ? 0 : +e.target.value, valuationAsOf: today })}
                        className="input num w-28 text-right py-1" />
                      <span className="text-xs text-[var(--muted)]">as of {h.valuationAsOf || "—"}</span>
                    </>
                  )}
                </div>

                {/* EIS/SEIS-only status */}
                {(h.type === "EIS" || h.type === "SEIS") && (
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    <span className={"px-1.5 py-0.5 rounded-full border " + (cgt.exempt ? "border-[var(--gain)] text-[var(--gain)]" : "border-[var(--border)] text-[var(--muted)]")} title={cgt.reason || (cgt.exempt ? "Gains exempt from CGT (assuming relief wasn't withdrawn)" : `Exempt from ${cgt.exemptFrom}`)}>
                      {cgt.exempt ? "CGT-exempt" : cgt.exemptFrom ? `CGT-exempt from ${cgt.exemptFrom}` : "No share issue date set"}
                    </span>
                    <span className="px-1.5 py-0.5 rounded-full border border-[var(--border)] text-[var(--muted)]">Relief {h.reliefPct ?? RELIEF_RATE[h.type]}%</span>
                    {lr && lr.eligible && (
                      <span className="px-1.5 py-0.5 rounded-full border border-[var(--loss)] text-[var(--loss)]" title="Eligible to be set against income tax in the year of loss (or the prior year), net of relief already given and anything already returned">
                        Loss relief {gbp0(lr.amount)}
                      </span>
                    )}
                  </div>
                )}

                {/* event ledger, collapsible */}
                <button onClick={() => setExpanded((x) => ({ ...x, [h.id]: !isOpen }))} className="text-xs text-[var(--accent)] hover:underline flex items-center gap-1">
                  {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {holdingEvents.length} event{holdingEvents.length === 1 ? "" : "s"}
                </button>
                {isOpen && (
                  <div className="space-y-2">
                    {holdingEvents.length > 0 && (
                      <div className="rounded-lg border border-[var(--border)] overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="bg-[var(--panel2)] text-[var(--muted)] uppercase tracking-wide">
                            <tr><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-left">Type</th><th className="px-2 py-1 text-right">Amount</th><th className="px-2 py-1 text-left">Notes</th><th></th></tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--border)]">
                            {holdingEvents.map((e) => (
                              <tr key={e.id}>
                                <td className="px-2 py-1 whitespace-nowrap">{e.date}</td>
                                <td className="px-2 py-1">{EVENT_LABEL[e.type] || e.type}</td>
                                <td className="px-2 py-1 num text-right">{e.type === "write_off" ? "—" : gbp(e.amount)}</td>
                                <td className="px-2 py-1 text-[var(--muted)] max-w-[8rem] truncate" title={e.notes}>{e.notes || "—"}</td>
                                <td className="px-2 py-1 text-right"><TwoStepDelete onConfirm={() => removeEvent(e.id)} label="Delete event" /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5 items-end">
                      <input type="date" value={ef.date} onChange={(e) => setEventForm(h.id, { date: e.target.value })} className="input num text-xs py-1 w-32" />
                      <select value={ef.type} onChange={(e) => setEventForm(h.id, { type: e.target.value })} className="input text-xs py-1">
                        {Object.entries(EVENT_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                      </select>
                      {ef.type !== "write_off" && (
                        <input type="number" placeholder="Amount (£)" value={ef.amount} onChange={(e) => setEventForm(h.id, { amount: e.target.value })} className="input num text-xs py-1 w-28" />
                      )}
                      <input placeholder="Notes (optional)" value={ef.notes} onChange={(e) => setEventForm(h.id, { notes: e.target.value })} className="input text-xs py-1 w-32" />
                      <button onClick={() => addEvent(h.id)} className="btn-accent !h-auto !py-1 text-xs"><PlusCircle size={13} /> Add</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* add holding */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
          <div className="text-sm font-medium">Add a private holding</div>
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
            <Field label="Name"><input className="input w-full" placeholder="e.g. JamJar Fund II" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Entity / manager"><input className="input w-full" placeholder="e.g. JamJar Investments" value={form.entity} onChange={(e) => setForm({ ...form, entity: e.target.value })} /></Field>
            <Field label="Type">
              <select className="input w-full" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, reliefPct: RELIEF_RATE[e.target.value] })}>
                {PRIVATE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </Field>
            <Field label={(form.type === "EIS" || form.type === "SEIS") ? "Share issue date" : "Investment date"}>
              <input type="date" className="input num w-full" value={form.shareIssueDate} onChange={(e) => setForm({ ...form, shareIssueDate: e.target.value })} />
            </Field>
            <Field label="Relief % (income tax)">
              <input type="number" min="0" max="50" className="input num w-full" value={form.reliefPct ?? ""} onChange={(e) => setForm({ ...form, reliefPct: e.target.value })}
                disabled={form.type !== "EIS" && form.type !== "SEIS"} />
            </Field>
            <button onClick={addHolding} className="btn-accent justify-center">Add holding</button>
          </div>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            After adding, log the initial subscription/first capital call as an event on the holding's card (expand "0 events" below its status chips) — the holding itself just carries identity, type, and the current manual valuation. For an LP/VC fund drawn down in tranches, add one "Capital call" event per drawdown as it happens.
          </p>
        </div>
      </div>

      {/* EIS/SEIS relief by tax year */}
      {reliefYears.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">EIS/SEIS income tax relief, by tax year</h3>
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Tax year</th>
                  <th className="px-3 py-2 text-right font-medium">EIS invested</th>
                  <th className="px-3 py-2 text-right font-medium">EIS relief (30%)</th>
                  <th className="px-3 py-2 text-right font-medium">SEIS invested</th>
                  <th className="px-3 py-2 text-right font-medium">SEIS relief (50%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {reliefYears.map((y) => {
                  const r = relief[y];
                  return (
                    <tr key={y}>
                      <td className="px-3 py-2 font-medium">{y}</td>
                      <td className={"px-3 py-2 num text-right " + (r.EIS.overCap ? "text-[var(--loss)] font-medium" : "")} title={r.EIS.overCap ? `Above the £${num(EIS_ANNUAL_CAP, 0)} annual cap` : undefined}>{gbp0(r.EIS.invested)}</td>
                      <td className="px-3 py-2 num text-right">{gbp0(r.EIS.relief)}</td>
                      <td className={"px-3 py-2 num text-right " + (r.SEIS.overCap ? "text-[var(--loss)] font-medium" : "")} title={r.SEIS.overCap ? `Above the £${num(SEIS_ANNUAL_CAP, 0)} annual cap` : undefined}>{gbp0(r.SEIS.invested)}</td>
                      <td className="px-3 py-2 num text-right">{gbp0(r.SEIS.relief)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--muted)]">Aggregated across every EIS/SEIS holding by the tax year of its earliest capital call, against the combined annual caps (EIS £{num(EIS_ANNUAL_CAP / 1000, 0)}k standard / £{num(EIS_ANNUAL_CAP_KI / 1000, 0)}k for the knowledge-intensive excess, not distinguished here; SEIS £{num(SEIS_ANNUAL_CAP / 1000, 0)}k) — the same "combined, not per-holding" check as the ISA/LISA £20k limit on the Allowances tab.</p>
        </div>
      )}
    </div>
  );
}

export default PrivateTab;
