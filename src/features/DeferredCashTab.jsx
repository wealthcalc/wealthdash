import React, { useState, useMemo } from "react";
import { Banknote, PlusCircle, Info, ChevronDown, ChevronUp, CalendarClock } from "lucide-react";
import { vestingSchedule, awardSummary, deferredCashTotals } from "../core/deferred-cash.mjs";
import { gbp, gbp0, num, uid, todayISO, Field, Stat, Empty, TwoStepDelete } from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";

/* ======================================================================
   DEFERRED CASH TRACKER — deferred compensation paid in CASH that vests
   over time (e.g. a deferred bonus paid in tranches across several years),
   as opposed to RSUs, which vest in shares. Same "award + tranche events"
   shape as the RSU tab; simpler, because a tranche's value IS its GBP
   amount (no ticker, no live price). All the maths lives in
   core/deferred-cash.mjs and is node-tested; this is pure display + CRUD.

   Net-worth treatment (see the core module header): only UNVESTED
   ("outstanding") tranches count toward net worth — once a tranche's date
   passes it's assumed paid into a bank account and already tracked as
   ordinary cash, so counting it here too would double-count it.
   ====================================================================== */

const AWARD_BLANK = () => ({ id: uid(), label: "", awardDate: todayISO(), note: "" });
const TRANCHE_BLANK = (awardId) => ({ id: uid(), awardId, date: todayISO(), amount: "" });

// De-drilled: awards/tranches are this tab's own arrays, read straight from
// the store via selectors — the shell passes no props (Phase 2.8 pattern).
function DeferredCashTab() {
  const awards = useAppStore((s) => s.deferredCashAwards), setAwards = useAppStore((s) => s.setDeferredCashAwards);
  const tranches = useAppStore((s) => s.deferredCashVests), setTranches = useAppStore((s) => s.setDeferredCashVests);
  const [form, setForm] = useState(AWARD_BLANK());
  const [trancheForms, setTrancheForms] = useState({}); // awardId -> draft tranche
  const [expanded, setExpanded] = useState({});         // awardId -> bool (tranche ledger open)

  const today = todayISO();
  const totals = useMemo(() => deferredCashTotals(awards, tranches, today), [awards, tranches, today]);

  // Upcoming (unvested) payouts across every award, soonest first — the
  // "vesting calendar" glance view, not buried one award-card at a time.
  const upcoming = useMemo(() => {
    const out = [];
    for (const a of awards) {
      for (const t of vestingSchedule(a, tranches, today)) {
        if (!t.vested) out.push({ award: a, ...t });
      }
    }
    return out.sort((x, y) => (x.date < y.date ? -1 : 1));
  }, [awards, tranches, today]);

  const addAward = () => {
    const label = form.label.trim();
    if (!label || !form.awardDate) return;
    setAwards((a) => [...a, { ...form, label, note: form.note.trim() }]);
    setForm(AWARD_BLANK());
  };
  const removeAward = (id) => { setAwards((a) => a.filter((x) => x.id !== id)); setTranches((t) => t.filter((x) => x.awardId !== id)); };

  const trancheForm = (awardId) => trancheForms[awardId] || TRANCHE_BLANK(awardId);
  const setTrancheForm = (awardId, patch) => setTrancheForms((f) => ({ ...f, [awardId]: { ...trancheForm(awardId), ...patch } }));
  const addTranche = (awardId) => {
    const tr = trancheForm(awardId);
    if (!tr.date || !(+tr.amount > 0)) return;
    setTranches((t) => [...t, { ...tr, id: uid(), amount: +tr.amount }]);
    setTrancheForms((f) => ({ ...f, [awardId]: TRANCHE_BLANK(awardId) }));
  };
  const removeTranche = (id) => setTranches((t) => t.filter((x) => x.id !== id));

  return (
    <div className="space-y-5">
      {/* headline */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Outstanding" value={gbp0(totals.outstanding)} sub="unvested — counts toward net worth" big />
        <Stat label="Paid to date" value={gbp0(totals.vestedAmount)} sub="vested tranches (now ordinary cash)" />
        <Stat label="Total awarded" value={gbp0(totals.totalAmount)} sub={`${awards.length} award${awards.length === 1 ? "" : "s"}`} />
        <Stat label="Next payout" value={upcoming.length ? gbp0(upcoming[0].amount) : "—"} sub={upcoming.length ? upcoming[0].date : "nothing scheduled"} />
      </div>

      <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel2)] text-[var(--muted)]">
        <Info size={14} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
        <span>Deferred cash comp — a bonus or award paid out in tranches on future dates. Only the <span className="font-medium text-[var(--fg)]">unvested (outstanding)</span> amount counts toward net worth: once a tranche's date passes it's assumed paid into your bank and already tracked under your cash balances, so counting it here too would double-count it. This is informational, not a tax computation — deferred cash is taxable employment income collected via PAYE at payment, which this app doesn't file. No notional interest or forfeiture risk is modelled: a tranche is worth exactly the amount you enter.</span>
      </div>

      {/* upcoming payouts calendar */}
      {upcoming.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold flex items-center gap-2"><CalendarClock size={15} className="text-[var(--accent)]" /> Upcoming payouts</h3>
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr><th className="px-3 py-2 text-left font-medium">Date</th><th className="px-3 py-2 text-left font-medium">Award</th><th className="px-3 py-2 text-right font-medium">Amount</th></tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {upcoming.slice(0, 12).map((t, i) => (
                  <tr key={`${t.id}-${i}`}>
                    <td className="px-3 py-2 num text-[var(--muted)]">{t.date}</td>
                    <td className="px-3 py-2 font-medium">{t.award.label}{t.award.note ? <span className="text-[var(--muted)] font-normal"> · {t.award.note}</span> : null}</td>
                    <td className="px-3 py-2 num text-right">{gbp(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--muted)]">These also appear on the Income tab's 12-month calendar as scheduled cash inflows.</p>
        </div>
      )}

      {/* awards */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Banknote size={15} className="text-[var(--accent)]" /> Awards</h3>
        {!awards.length && <Empty msg="No deferred cash awards yet. Add one below — a label, the award date, an optional note — then log each payout tranche (date + amount) on its card." />}
        <div className="grid gap-3 sm:grid-cols-2">
          {awards.map((a) => {
            const s = awardSummary(a, tranches, today);
            const isOpen = !!expanded[a.id];
            const sched = vestingSchedule(a, tranches, today).slice().reverse();
            const tf = trancheForm(a.id);
            return (
              <div key={a.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{a.label}</div>
                    <div className="text-xs text-[var(--muted)]">awarded {a.awardDate}{a.note ? <> · {a.note}</> : null}</div>
                  </div>
                  <TwoStepDelete onConfirm={() => removeAward(a.id)} label={`Remove award: ${a.label}`} />
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <span className="text-[var(--muted)]">Outstanding</span><span className="num text-right font-medium">{gbp(s.outstanding)}</span>
                  <span className="text-[var(--muted)]">Paid / total</span><span className="num text-right">{gbp(s.vestedAmount)} / {gbp(s.totalAmount)}</span>
                </div>

                {s.nextVest && (
                  <div className="text-xs text-[var(--muted)] pt-1 border-t border-[var(--border)]">Next payout: {s.nextVest.date} · {gbp(s.nextVest.amount)}</div>
                )}

                {/* tranche ledger, collapsible */}
                <button onClick={() => setExpanded((x) => ({ ...x, [a.id]: !isOpen }))} className="text-xs text-[var(--accent)] hover:underline flex items-center gap-1">
                  {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {s.trancheCount} tranche{s.trancheCount === 1 ? "" : "s"}
                </button>
                {isOpen && (
                  <div className="space-y-2">
                    {sched.length > 0 && (
                      <div className="rounded-lg border border-[var(--border)] overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="bg-[var(--panel2)] text-[var(--muted)] uppercase tracking-wide">
                            <tr><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-right">Amount</th><th className="px-2 py-1 text-left">Status</th><th></th></tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--border)]">
                            {sched.map((t) => (
                              <tr key={t.id}>
                                <td className="px-2 py-1 whitespace-nowrap">{t.date}</td>
                                <td className="px-2 py-1 num text-right">{gbp(t.amount)}</td>
                                <td className="px-2 py-1">{t.vested ? <span className="text-[var(--muted)]">Paid</span> : <span className="text-[var(--gain)]">Outstanding</span>}</td>
                                <td className="px-2 py-1 text-right"><TwoStepDelete onConfirm={() => removeTranche(t.id)} label="Delete tranche" /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5 items-end">
                      <input type="date" value={tf.date} onChange={(e) => setTrancheForm(a.id, { date: e.target.value })} className="input num text-xs py-1 w-32" />
                      <input type="number" placeholder="Amount (£)" value={tf.amount} onChange={(e) => setTrancheForm(a.id, { amount: e.target.value })} className="input num text-xs py-1 w-28" />
                      <button onClick={() => addTranche(a.id)} className="btn-accent !h-auto !py-1 text-xs"><PlusCircle size={13} /> Add</button>
                    </div>
                    <p className="text-xs text-[var(--muted)]">Add one row per scheduled payout. A future-dated tranche IS the schedule — enter the date and amount now; it stays "Outstanding" (and in net worth) until its date passes, then flips to "Paid".</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* add award */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
          <div className="text-sm font-medium">Add an award</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
            <Field label="Label"><input className="input w-full" placeholder="e.g. 2025 bonus — deferred" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
            <Field label="Award date"><input type="date" className="input num w-full" value={form.awardDate} onChange={(e) => setForm({ ...form, awardDate: e.target.value })} /></Field>
            <Field label="Note (optional)"><input className="input w-full" placeholder="e.g. 3-year deferral" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
            <button onClick={addAward} className="btn-accent justify-center">Add award</button>
          </div>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            After adding, log each payout tranche as a row on the award's card (expand it below its status) — the award itself just carries the label and award date. All amounts are in GBP.
          </p>
        </div>
      </div>
    </div>
  );
}

export default DeferredCashTab;
