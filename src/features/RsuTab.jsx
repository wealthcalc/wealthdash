import React, { useState, useMemo } from "react";
import { Award, PlusCircle, Info, ChevronDown, ChevronUp, CalendarClock } from "lucide-react";
import { vestingSchedule, grantSummary, rsuTotals } from "../core/rsu.mjs";
import { gbp, gbp0, num, uid, todayISO, Field, Stat, Empty, TwoStepDelete } from "../ui/shared.jsx";
import LivePricesPanel from "../ui/LivePricesPanel.jsx";

/* ======================================================================
   RSU VESTING TRACKER — employer stock grants (e.g. Wells Fargo RSUs,
   ticker WFC) that vest over time. Same "holding + events" shape as
   PrivateTab: a GRANT is the holding (identity, ticker, grant date); VEST
   and SALE are events against it. Unlike private investments, RSU
   valuation plugs straight into the app's existing live-price pipeline
   (LivePricesPanel/refreshAllPrices) — an RSU ticker is priced exactly
   like any other holding, no separate fetch path. All the maths
   (vesting schedule, cost basis, unrealised gain) lives in core/rsu.mjs
   and is node-tested; this is pure display + CRUD over it.
   ====================================================================== */

const GRANT_BLANK = () => ({ id: uid(), ticker: "", grantDate: todayISO(), note: "" });
const EVENT_BLANK = (grantId) => ({ id: uid(), grantId, type: "vest", date: todayISO(), shares: "", priceNative: "", fxRate: 1 });
const EVENT_LABEL = { vest: "Vest", sale: "Sale" };

function RsuTab({
  grants = [], setGrants, events = [], setEvents,
  prices, setPrices, avKey, setAvKey, avMeta, setAvMeta, priceMeta, setPriceMeta,
  secMeta = {}, setSecMeta, dmoReportDate, setDmoReportDate, txns = [],
}) {
  const [form, setForm] = useState(GRANT_BLANK());
  const [eventForms, setEventForms] = useState({}); // grantId -> draft event
  const [expanded, setExpanded] = useState({});     // grantId -> bool (event ledger open)

  const today = todayISO();
  const totals = useMemo(() => rsuTotals(grants, events, prices, today), [grants, events, prices, today]);
  const tickers = useMemo(() => [...new Set(grants.map((g) => g.ticker).filter(Boolean))], [grants]);

  // Upcoming vests across every grant, soonest first — the "vesting
  // schedule" view the user actually wants to glance at, not buried one
  // grant-card at a time.
  const upcoming = useMemo(() => {
    const out = [];
    for (const g of grants) {
      for (const v of vestingSchedule(g, events, today)) {
        if (!v.vested) out.push({ grant: g, ...v });
      }
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [grants, events, today]);

  const addGrant = () => {
    const ticker = form.ticker.trim().toUpperCase();
    if (!ticker || !form.grantDate) return;
    setGrants((g) => [...g, { ...form, ticker, note: form.note.trim() }]);
    setForm(GRANT_BLANK());
  };
  const removeGrant = (id) => { setGrants((g) => g.filter((x) => x.id !== id)); setEvents((e) => e.filter((x) => x.grantId !== id)); };

  const eventForm = (grantId) => eventForms[grantId] || EVENT_BLANK(grantId);
  const setEventForm = (grantId, patch) => setEventForms((f) => ({ ...f, [grantId]: { ...eventForm(grantId), ...patch } }));
  const addEvent = (grantId) => {
    const ev = eventForm(grantId);
    if (!ev.date || !(+ev.shares > 0)) return;
    setEvents((e) => [...e, {
      ...ev, id: uid(), shares: +ev.shares,
      priceNative: ev.priceNative === "" ? null : +ev.priceNative,
      fxRate: ev.priceNative === "" ? null : (+ev.fxRate || 0),
    }]);
    setEventForms((f) => ({ ...f, [grantId]: EVENT_BLANK(grantId) }));
  };
  const removeEvent = (id) => setEvents((e) => e.filter((x) => x.id !== id));

  return (
    <div className="space-y-5">
      {/* headline */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Stat label="Held shares" value={grants.length ? num(totals.heldShares, totals.heldShares % 1 ? 2 : 0) : "—"} sub={`${grants.length} grant${grants.length === 1 ? "" : "s"}`} />
        <Stat label="Vested (all-time)" value={num(totals.vestedShares, totals.vestedShares % 1 ? 2 : 0)} sub={`${num(totals.soldShares, totals.soldShares % 1 ? 2 : 0)} sold`} />
        <Stat label="Unvested" value={num(totals.unvestedShares, totals.unvestedShares % 1 ? 2 : 0)} sub="scheduled, not yet vested" />
        <Stat label="Current value" value={gbp0(totals.currentValueGBP)} sub={totals.unpriced ? `${totals.unpriced} grant${totals.unpriced === 1 ? "" : "s"} unpriced` : "live price × held shares"} />
        <Stat label="Unrealised" value={gbp0(totals.unrealisedGBP)} sub="vs. vest-date FMV cost basis" tone={totals.unrealisedGBP >= 0 ? "gain" : "loss"} />
      </div>

      <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel2)] text-[var(--muted)]">
        <Info size={14} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
        <span>Tracks grants, their vesting schedule, and any sales, valuing held shares at the same live price used everywhere else in the app. This is informational, not a tax computation: UK income tax at vest (usually collected via payroll before the shares even land here) and any CGT on a later sale (RSU shares typically pool with other same-company holdings under ordinary Section 104 rules, cost basis = vest-date FMV) aren't computed or filed by this app — "Unrealised"/"Realised" below compare current or sale value against vest-date FMV as a reference figure only.</span>
      </div>

      {tickers.length > 0 && (
        <LivePricesPanel {...{ tickers, avKey, setAvKey, avMeta, setAvMeta, prices, setPrices, priceMeta, setPriceMeta, txns, secMeta, dmoReportDate, setDmoReportDate }} />
      )}

      {/* upcoming vesting schedule */}
      {upcoming.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold flex items-center gap-2"><CalendarClock size={15} className="text-[var(--accent)]" /> Upcoming vests</h3>
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr><th className="px-3 py-2 text-left font-medium">Date</th><th className="px-3 py-2 text-left font-medium">Grant</th><th className="px-3 py-2 text-right font-medium">Shares</th></tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {upcoming.slice(0, 12).map((v, i) => (
                  <tr key={`${v.id}-${i}`}>
                    <td className="px-3 py-2 num text-[var(--muted)]">{v.date}</td>
                    <td className="px-3 py-2 font-medium">{v.grant.ticker}{v.grant.note ? <span className="text-[var(--muted)] font-normal"> · {v.grant.note}</span> : null}</td>
                    <td className="px-3 py-2 num text-right">{num(v.shares, v.shares % 1 ? 2 : 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* grants */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Award size={15} className="text-[var(--accent)]" /> Grants</h3>
        {!grants.length && <Empty msg="No RSU grants yet. Add one below — ticker, grant date, an optional note — then log each vest tranche (and any sale) as an event on its card." />}
        <div className="grid gap-3 sm:grid-cols-2">
          {grants.map((g) => {
            const s = grantSummary(g, events, prices, today);
            const isOpen = !!expanded[g.id];
            const sched = vestingSchedule(g, events, today).slice().reverse();
            const ef = eventForm(g.id);
            return (
              <div key={g.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{g.ticker}</div>
                    <div className="text-xs text-[var(--muted)]">granted {g.grantDate}{g.note ? <> · {g.note}</> : null}</div>
                  </div>
                  <TwoStepDelete onConfirm={() => removeGrant(g.id)} label={`Remove grant: ${g.ticker}`} />
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <span className="text-[var(--muted)]">Held</span><span className="num text-right">{num(s.heldShares, s.heldShares % 1 ? 2 : 0)}</span>
                  <span className="text-[var(--muted)]">Vested / total</span><span className="num text-right">{num(s.vestedShares, 0)} / {num(s.totalShares, 0)}</span>
                  <span className="text-[var(--muted)]">Current value</span><span className="num text-right">{s.priced ? gbp(s.currentValueGBP) : "unpriced"}</span>
                  <span className="text-[var(--muted)]">Unrealised</span><span className={"num text-right " + (s.priced ? (s.unrealisedGBP >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]") : "")}>{s.priced ? gbp(s.unrealisedGBP) : "—"}</span>
                </div>

                {s.nextVest && (
                  <div className="text-xs text-[var(--muted)] pt-1 border-t border-[var(--border)]">Next vest: {s.nextVest.date} · {num(s.nextVest.shares, s.nextVest.shares % 1 ? 2 : 0)} shares</div>
                )}

                {/* vesting schedule + events ledger, collapsible */}
                <button onClick={() => setExpanded((x) => ({ ...x, [g.id]: !isOpen }))} className="text-xs text-[var(--accent)] hover:underline flex items-center gap-1">
                  {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {sched.length} vest tranche{sched.length === 1 ? "" : "s"}, {s.soldShares > 0 ? `${num(s.soldShares, s.soldShares % 1 ? 2 : 0)} sold` : "no sales"}
                </button>
                {isOpen && (
                  <div className="space-y-2">
                    {sched.length > 0 && (
                      <div className="rounded-lg border border-[var(--border)] overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-[var(--panel2)] text-[var(--muted)] uppercase tracking-wide">
                            <tr><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-right">Shares</th><th className="px-2 py-1 text-left">Status</th><th></th></tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--border)]">
                            {sched.map((v) => (
                              <tr key={v.id}>
                                <td className="px-2 py-1 whitespace-nowrap">{v.date}</td>
                                <td className="px-2 py-1 num text-right">{num(v.shares, v.shares % 1 ? 2 : 0)}</td>
                                <td className="px-2 py-1">{v.vested ? <span className="text-[var(--gain)]">Vested</span> : <span className="text-[var(--muted)]">Scheduled</span>}</td>
                                <td className="px-2 py-1 text-right"><TwoStepDelete onConfirm={() => removeEvent(v.id)} label="Delete vest event" /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {events.filter((e) => e.grantId === g.id && e.type === "sale").length > 0 && (
                      <div className="rounded-lg border border-[var(--border)] overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-[var(--panel2)] text-[var(--muted)] uppercase tracking-wide">
                            <tr><th className="px-2 py-1 text-left">Sale date</th><th className="px-2 py-1 text-right">Shares</th><th className="px-2 py-1 text-right">Proceeds (GBP)</th><th></th></tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--border)]">
                            {events.filter((e) => e.grantId === g.id && e.type === "sale").sort((a, b) => (a.date < b.date ? 1 : -1)).map((e) => (
                              <tr key={e.id}>
                                <td className="px-2 py-1 whitespace-nowrap">{e.date}</td>
                                <td className="px-2 py-1 num text-right">{num(e.shares, e.shares % 1 ? 2 : 0)}</td>
                                <td className="px-2 py-1 num text-right">{e.priceNative != null ? gbp((+e.shares || 0) * (+e.priceNative || 0) * (+e.fxRate || 0)) : "—"}</td>
                                <td className="px-2 py-1 text-right"><TwoStepDelete onConfirm={() => removeEvent(e.id)} label="Delete sale event" /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5 items-end">
                      <input type="date" value={ef.date} onChange={(e) => setEventForm(g.id, { date: e.target.value })} className="input num text-xs py-1 w-32" />
                      <select value={ef.type} onChange={(e) => setEventForm(g.id, { type: e.target.value })} className="input text-xs py-1">
                        {Object.entries(EVENT_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                      </select>
                      <input type="number" placeholder="Shares" value={ef.shares} onChange={(e) => setEventForm(g.id, { shares: e.target.value })} className="input num text-xs py-1 w-20" />
                      <input type="number" placeholder={`FMV/price (${g.ticker || "native"})`} value={ef.priceNative} onChange={(e) => setEventForm(g.id, { priceNative: e.target.value })} className="input num text-xs py-1 w-32" />
                      <input type="number" placeholder="FX→GBP" value={ef.fxRate} onChange={(e) => setEventForm(g.id, { fxRate: e.target.value })} className="input num text-xs py-1 w-20" disabled={ef.priceNative === ""} />
                      <button onClick={() => addEvent(g.id)} className="btn-accent !h-auto !py-1 text-xs"><PlusCircle size={13} /> Add</button>
                    </div>
                    <p className="text-xs text-[var(--muted)]">Price/FX are optional for a future-dated vest (no FMV exists yet) — leave them blank and the schedule still shows the date and share count; fill them in once the shares actually vest, for a cost basis.</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* add grant */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
          <div className="text-sm font-medium">Add a grant</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
            <Field label="Ticker"><input className="input w-full" placeholder="e.g. WFC" value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })} /></Field>
            <Field label="Grant date"><input type="date" className="input num w-full" value={form.grantDate} onChange={(e) => setForm({ ...form, grantDate: e.target.value })} /></Field>
            <Field label="Note (optional)"><input className="input w-full" placeholder="e.g. 2024 annual grant" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
            <button onClick={addGrant} className="btn-accent justify-center">Add grant</button>
          </div>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            After adding, log each vest tranche as an event on the grant's card (expand it below its status) — the grant itself just carries the ticker and grant date. A future-dated vest tranche IS the schedule: add it now with just the date and share count, and fill in the FMV once it actually vests.
          </p>
        </div>
      </div>
    </div>
  );
}

export default RsuTab;
