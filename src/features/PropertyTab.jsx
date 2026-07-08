import React, { useState, useMemo } from "react";
import { Home, Landmark, CreditCard, RefreshCw, AlertTriangle } from "lucide-react";
import {
  estimatedPropertyValue, propertyEquity, netPropertyWorth, totalOtherLiabilities,
  mortgagesEndingSoon, HPI_REGIONS, regionLabel,
} from "../core/property.mjs";
import { gbp, gbp0, num, uid, todayISO, Field, Stat, Empty, useSort, sortRows, SortTh, TwoStepDelete } from "../ui/shared.jsx";

/* ======================================================================
   PROPERTY & LIABILITIES (Phase 2) — completes the balance sheet: real
   estate (manually valued or Land Registry HPI-indexed from the purchase
   price), mortgages, and other debts. Everything here is pure display +
   CRUD over core/property.mjs; the actual maths lives there and is
   node-tested. Feeds householdNetWorth (computed one level up in
   CgtDashboard.jsx, alongside the existing investment wealth model) so
   Home's headline is assets − liabilities, not just invested + cash.
   ====================================================================== */

const PROPERTY_BLANK = () => ({
  id: uid(), label: "", region: "united-kingdom", purchaseDate: todayISO(),
  purchasePrice: "", valuationMode: "hpi", manualValue: "", manualValueAsOf: "", hpi: null,
});
const MORTGAGE_BLANK = (propertyId) => ({
  id: uid(), propertyId: propertyId || "", lender: "", balance: "", balanceAsOf: todayISO(),
  rate: "", rateType: "fixed", fixedEndDate: "", type: "repayment",
});
const LIABILITY_BLANK = () => ({ id: uid(), label: "", balance: "", rate: "", notes: "" });

function PropertyTab({
  properties = [], setProperties, mortgages = [], setMortgages,
  otherLiabilities = [], setOtherLiabilities,
}) {
  const [form, setForm] = useState(PROPERTY_BLANK());
  const [mForm, setMForm] = useState(MORTGAGE_BLANK());
  const [lForm, setLForm] = useState(LIABILITY_BLANK());
  const [hpiBusy, setHpiBusy] = useState({}); // propertyId -> bool
  const [hpiErr, setHpiErr] = useState({});   // propertyId -> message

  const net = useMemo(() => netPropertyWorth(properties, mortgages), [properties, mortgages]);
  const otherTotal = totalOtherLiabilities(otherLiabilities);
  const soon = useMemo(() => mortgagesEndingSoon(mortgages, todayISO(), 180), [mortgages]);

  const addProperty = () => {
    if (!form.label.trim() || !(+form.purchasePrice > 0) || !form.purchaseDate) return;
    setProperties((p) => [...p, { ...form, label: form.label.trim(), purchasePrice: +form.purchasePrice, manualValue: form.manualValue === "" ? null : +form.manualValue }]);
    setForm(PROPERTY_BLANK());
  };
  const updateProperty = (id, patch) => setProperties((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeProperty = (id) => { setProperties((p) => p.filter((x) => x.id !== id)); setMortgages((m) => m.filter((x) => x.propertyId !== id)); };

  const fetchHpi = async (property) => {
    if (!property.purchaseDate) return;
    const id = property.id;
    setHpiBusy((b) => ({ ...b, [id]: true }));
    setHpiErr((e) => ({ ...e, [id]: "" }));
    try {
      const month = property.purchaseDate.slice(0, 7); // YYYY-MM
      const r = await fetch(`/api/hpi?region=${encodeURIComponent(property.region)}&from=${encodeURIComponent(month)}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      updateProperty(id, {
        hpi: {
          purchaseMonth: body.purchaseMonth, purchaseIndex: body.purchaseIndex,
          latestMonth: body.latestMonth, latestIndex: body.latestIndex,
          fetchedAt: todayISO(),
        },
      });
    } catch (e) {
      setHpiErr((er) => ({ ...er, [id]: e.message || "Fetch failed." }));
    }
    setHpiBusy((b) => ({ ...b, [id]: false }));
  };

  const addMortgage = () => {
    if (!mForm.propertyId || !(+mForm.balance >= 0)) return;
    setMortgages((p) => [...p, { ...mForm, balance: +mForm.balance, rate: mForm.rate === "" ? null : +mForm.rate }]);
    setMForm(MORTGAGE_BLANK(mForm.propertyId));
  };
  const updateMortgage = (id, patch) => setMortgages((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const addLiability = () => {
    if (!lForm.label.trim() || !(+lForm.balance >= 0)) return;
    setOtherLiabilities((p) => [...p, { ...lForm, label: lForm.label.trim(), balance: +lForm.balance, rate: lForm.rate === "" ? null : +lForm.rate }]);
    setLForm(LIABILITY_BLANK());
  };

  const [mSort, toggleMSort] = useSort("fixedEndDate", "asc");
  const propertyLabel = (pid) => properties.find((p) => p.id === pid)?.label || "(property removed)";
  const mortgageRows = sortRows(mortgages, mSort, {
    property: (m) => propertyLabel(m.propertyId), lender: (m) => m.lender || "",
    balance: (m) => m.balance, rate: (m) => m.rate, fixedEndDate: (m) => m.fixedEndDate || null,
  });

  return (
    <div className="space-y-5">
      {/* headline */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Property value" value={properties.length ? gbp0(net.value) : "—"} sub={`${properties.length} propert${properties.length === 1 ? "y" : "ies"}`} />
        <Stat label="Mortgage debt" value={gbp0(net.debt)} />
        <Stat label="Net property equity" value={gbp0(net.equity)} big tone={net.equity >= 0 ? "gain" : "loss"} />
        <Stat label="Other liabilities" value={gbp0(otherTotal)} sub={otherLiabilities.length ? `${otherLiabilities.length} item${otherLiabilities.length === 1 ? "" : "s"}` : undefined} />
      </div>

      {soon.length > 0 && (
        <div className="flex items-start gap-2 text-sm rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel)]">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
          <span>{soon.length} fixed-rate deal{soon.length === 1 ? "" : "s"} {soon.some((m) => m.expired) ? "expired or " : ""}ending within 180 days: {soon.map((m) => `${propertyLabel(m.propertyId)} (${m.fixedEndDate}${m.expired ? ", expired — likely on SVR now" : ""})`).join("; ")}.</span>
        </div>
      )}

      {net.orphanMortgages.length > 0 && (
        <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-[var(--loss)]" style={{ background: "color-mix(in srgb, var(--loss) 10%, transparent)" }}>
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {net.orphanMortgages.length} mortgage{net.orphanMortgages.length === 1 ? "" : "s"} linked to a property that no longer exists — still counted in Mortgage debt above, not silently dropped. Re-link or remove them below.
        </div>
      )}

      {/* properties */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Home size={15} className="text-[var(--accent)]" /> Properties</h3>
        {!properties.length && <Empty msg="No properties yet. Add one below — value it manually, or index it from the purchase price using the official Land Registry UK House Price Index for your region." />}
        <div className="grid gap-3 sm:grid-cols-2">
          {properties.map((p) => {
            const v = estimatedPropertyValue(p);
            const eq = propertyEquity(p, mortgages);
            return (
              <div key={p.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{p.label}</div>
                    <div className="text-xs text-[var(--muted)]">{regionLabel(p.region)} · bought {p.purchaseDate} for {gbp(p.purchasePrice)}</div>
                  </div>
                  <TwoStepDelete onConfirm={() => removeProperty(p.id)} label="Remove property" />
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <button onClick={() => updateProperty(p.id, { valuationMode: "manual" })}
                    className={"px-2 py-0.5 rounded-full border " + (p.valuationMode === "manual" ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)]")}>Manual value</button>
                  <button onClick={() => updateProperty(p.id, { valuationMode: "hpi" })}
                    className={"px-2 py-0.5 rounded-full border " + (p.valuationMode === "hpi" ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)]")}>HPI-indexed</button>
                </div>
                {p.valuationMode === "manual" ? (
                  <div className="flex items-center gap-2">
                    <input type="number" className="input num w-32" placeholder="Current value" value={p.manualValue ?? ""} onChange={(e) => updateProperty(p.id, { manualValue: e.target.value === "" ? null : +e.target.value, manualValueAsOf: todayISO() })} />
                    <span className="text-xs text-[var(--muted)]">as of {p.manualValueAsOf || "—"}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <button onClick={() => fetchHpi(p)} disabled={hpiBusy[p.id]} className="btn-accent !h-auto !py-1">
                      {hpiBusy[p.id] ? <RefreshCw size={13} className="animate-spin" /> : <Landmark size={13} />} {p.hpi ? "Refresh index" : "Fetch Land Registry index"}
                    </button>
                    {p.hpi && <span className="text-[var(--muted)]">index {p.hpi.purchaseMonth}→{p.hpi.latestMonth}: {num(p.hpi.purchaseIndex, 1)}→{num(p.hpi.latestIndex, 1)}</span>}
                    {hpiErr[p.id] && <span className="text-[var(--loss)]">{hpiErr[p.id]}</span>}
                  </div>
                )}
                <div className="pt-2 border-t border-[var(--border)] flex justify-between text-sm">
                  <span className="text-[var(--muted)]">Estimated value {v.method === "cost" && <span title="No HPI fetch or manual value yet — showing raw purchase price">(purchase price, not yet indexed)</span>}</span>
                  <span className="num font-medium">{gbp(v.value)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--muted)]">Mortgage debt ({eq.mortgageCount})</span>
                  <span className="num">{gbp(eq.debt)}</span>
                </div>
                <div className="flex justify-between text-sm font-semibold">
                  <span>Equity</span>
                  <span className={"num " + (eq.equity >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{gbp(eq.equity)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
          <div className="text-sm font-medium">Add a property</div>
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
            <Field label="Label"><input className="input w-full" placeholder="Main home" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
            <Field label="Region (for HPI)">
              <select className="input w-full" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })}>
                {HPI_REGIONS.map((r) => <option key={r.slug} value={r.slug}>{r.label}</option>)}
              </select>
            </Field>
            <Field label="Purchase date"><input type="date" className="input num w-full" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} /></Field>
            <Field label="Purchase price"><input type="number" className="input num w-full" value={form.purchasePrice} onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })} /></Field>
            <Field label="Valuation">
              <select className="input w-full" value={form.valuationMode} onChange={(e) => setForm({ ...form, valuationMode: e.target.value })}>
                <option value="hpi">HPI-indexed</option>
                <option value="manual">Manual</option>
              </select>
            </Field>
            <button onClick={addProperty} className="btn-accent justify-center">Add property</button>
          </div>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            HPI-indexed uses HM Land Registry's official UK House Price Index: estimated value = purchase price × (latest regional index ÷ index at your purchase month). It's a regional average trend, not a valuation of your specific property — treat it as a reasonable estimate for net-worth tracking, not a RICS survey or a number to rely on for a sale/remortgage.
          </p>
        </div>
      </div>

      {/* mortgages */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Landmark size={15} className="text-[var(--accent)]" /> Mortgages</h3>
        {mortgages.length > 0 && (
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>
                  <SortTh id="property" label="Property" sort={mSort} onSort={toggleMSort} className="px-3 py-2 font-medium" />
                  <SortTh id="lender" label="Lender" sort={mSort} onSort={toggleMSort} className="px-3 py-2 font-medium" />
                  <SortTh id="balance" label="Balance" sort={mSort} onSort={toggleMSort} align="right" className="px-3 py-2 font-medium" />
                  <SortTh id="rate" label="Rate" sort={mSort} onSort={toggleMSort} align="right" className="px-3 py-2 font-medium" />
                  <th className="px-3 py-2 font-medium text-left">Type</th>
                  <SortTh id="fixedEndDate" label="Fixed ends" sort={mSort} onSort={toggleMSort} className="px-3 py-2 font-medium" />
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {mortgageRows.map((m) => (
                  <tr key={m.id} className="hover:bg-[var(--panel2)]">
                    <td className="px-3 py-2">
                      <select className="input text-xs py-1" value={m.propertyId} onChange={(e) => updateMortgage(m.id, { propertyId: e.target.value })}>
                        <option value="">—</option>
                        {properties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2"><input className="input text-xs py-1 w-28" value={m.lender || ""} onChange={(e) => updateMortgage(m.id, { lender: e.target.value })} /></td>
                    <td className="px-3 py-2 text-right"><input type="number" className="input num text-xs py-1 w-28 text-right" value={m.balance} onChange={(e) => updateMortgage(m.id, { balance: +e.target.value || 0, balanceAsOf: todayISO() })} /></td>
                    <td className="px-3 py-2 text-right"><input type="number" step="0.01" className="input num text-xs py-1 w-20 text-right" value={m.rate ?? ""} onChange={(e) => updateMortgage(m.id, { rate: e.target.value === "" ? null : +e.target.value })} />%</td>
                    <td className="px-3 py-2">
                      <select className="input text-xs py-1" value={m.rateType} onChange={(e) => updateMortgage(m.id, { rateType: e.target.value })}>
                        <option value="fixed">Fixed</option><option value="tracker">Tracker</option><option value="variable">Variable</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      {m.rateType === "fixed" ? <input type="date" className="input num text-xs py-1" value={m.fixedEndDate || ""} onChange={(e) => updateMortgage(m.id, { fixedEndDate: e.target.value })} /> : <span className="text-[var(--muted)] text-xs">n/a</span>}
                    </td>
                    <td className="px-3 py-2 text-right"><TwoStepDelete onConfirm={() => setMortgages((p) => p.filter((x) => x.id !== m.id))} label="Remove mortgage" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
          <div className="text-sm font-medium">Add a mortgage</div>
          <div className="flex flex-wrap gap-2 items-end">
            <Field label="Property">
              <select className="input w-40" value={mForm.propertyId} onChange={(e) => setMForm({ ...mForm, propertyId: e.target.value })}>
                <option value="">Select…</option>
                {properties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>
            <Field label="Lender"><input className="input w-32" value={mForm.lender} onChange={(e) => setMForm({ ...mForm, lender: e.target.value })} /></Field>
            <Field label="Balance"><input type="number" className="input num w-28" value={mForm.balance} onChange={(e) => setMForm({ ...mForm, balance: e.target.value })} /></Field>
            <Field label="Rate %"><input type="number" step="0.01" className="input num w-20" value={mForm.rate} onChange={(e) => setMForm({ ...mForm, rate: e.target.value })} /></Field>
            <Field label="Type">
              <select className="input" value={mForm.rateType} onChange={(e) => setMForm({ ...mForm, rateType: e.target.value })}>
                <option value="fixed">Fixed</option><option value="tracker">Tracker</option><option value="variable">Variable</option>
              </select>
            </Field>
            {mForm.rateType === "fixed" && <Field label="Fixed ends"><input type="date" className="input num" value={mForm.fixedEndDate} onChange={(e) => setMForm({ ...mForm, fixedEndDate: e.target.value })} /></Field>}
            <button onClick={addMortgage} disabled={!mForm.propertyId} className="btn-accent disabled:opacity-50">Add mortgage</button>
          </div>
          <p className="text-xs text-[var(--muted)]">No amortisation is projected — enter the current balance from your latest statement and update it periodically; overpayments and rate changes are yours to track, not modelled.</p>
        </div>
      </div>

      {/* other liabilities */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><CreditCard size={15} className="text-[var(--accent)]" /> Other liabilities</h3>
        {otherLiabilities.length > 0 && (
          <div className="rounded-xl border border-[var(--border)] overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr><th className="px-3 py-2 text-left font-medium">Label</th><th className="px-3 py-2 text-right font-medium">Balance</th><th className="px-3 py-2 text-right font-medium">Rate</th><th className="px-3 py-2 text-left font-medium">Notes</th><th className="px-3 py-2"></th></tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {otherLiabilities.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2 font-medium">{l.label}</td>
                    <td className="px-3 py-2 num text-right">{gbp(l.balance)}</td>
                    <td className="px-3 py-2 num text-right text-[var(--muted)]">{l.rate != null ? `${num(l.rate, 2)}%` : "—"}</td>
                    <td className="px-3 py-2 text-xs text-[var(--muted)]">{l.notes || "—"}</td>
                    <td className="px-3 py-2 text-right"><TwoStepDelete onConfirm={() => setOtherLiabilities((p) => p.filter((x) => x.id !== l.id))} label="Remove liability" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
          <div className="text-sm font-medium">Add a liability</div>
          <div className="flex flex-wrap gap-2 items-end">
            <Field label="Label"><input className="input w-40" placeholder="Car loan" value={lForm.label} onChange={(e) => setLForm({ ...lForm, label: e.target.value })} /></Field>
            <Field label="Balance"><input type="number" className="input num w-28" value={lForm.balance} onChange={(e) => setLForm({ ...lForm, balance: e.target.value })} /></Field>
            <Field label="Rate % (optional)"><input type="number" step="0.01" className="input num w-24" value={lForm.rate} onChange={(e) => setLForm({ ...lForm, rate: e.target.value })} /></Field>
            <Field label="Notes"><input className="input w-48" value={lForm.notes} onChange={(e) => setLForm({ ...lForm, notes: e.target.value })} /></Field>
            <button onClick={addLiability} className="btn-accent">Add liability</button>
          </div>
          <p className="text-xs text-[var(--muted)]">Anything not a mortgage: personal loans, credit cards, student loans, car finance. Counted in net worth the same way — subtracted, not projected forward.</p>
        </div>
      </div>
    </div>
  );
}

export default PropertyTab;
