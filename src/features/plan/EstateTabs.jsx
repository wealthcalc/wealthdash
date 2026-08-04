/* Plan sub-tabs for assets and liabilities that sit outside the pot itself:
   buy-to-let cashflow, and the inheritance-tax projection. Extracted verbatim
   from PlanTab.jsx during the file split; no behaviour change. */
import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, AreaChart, LineChart, BarChart,
  Area, Line, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ReferenceArea,
} from "recharts";
import {
  Building2, Info, Plus, Trash2, Landmark, Coins, TrendingUp, TrendingDown,
} from "lucide-react";
import { T, MONO, SANS, gbp, gbpK, pct, tooltipStyle } from "./theme.js";
import { Card, Stat, Field, Segmented, Toggle, PanelSection, Legendlet, Note, Barline, Row } from "./controls.jsx";
import { lifeExpectancy, effInflation, btlYearly, buildProjection } from "../../core/drawdown.mjs";
import { projectIHT, pensionsInEstate, PENSIONS_IN_ESTATE_FROM } from "../../core/iht.mjs";
import { uid, todayISO } from "../../ui/shared.jsx";

function BtlTab({ p, det, set }) {
  if (!p.btlEnabled) {
    return (
      <div style={{ textAlign: "center", padding: "50px 20px", color: T.muted }}>
        <Building2 size={34} color={T.line} />
        <p style={{ marginTop: 12, fontSize: 14 }}>No buy-to-let in the plan yet.</p>
        <button
          onClick={() => set("btlEnabled", true)}
          style={{ marginTop: 4, background: T.ink, color: T.paper, border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer" }}
        >
          Add a BTL property
        </button>
      </div>
    );
  }
  // year-1 of retirement, taken straight from the engine (actual marginal tax)
  const s = det.btlSeries.filter((x) => x.value > 0);
  const b0 = s[0] || det.btlSeries[0] || { rent: 0, opex: 0, interest: 0, cashProfit: 0, taxableProfit: 0, tax: 0, net: 0, marginal: 0, value: 0, equity: 0 };

  // property value/equity over the whole plan (real), drops to 0 after a sale
  const series = [];
  for (let i = 0; i <= p.planAge - p.currentAge; i++) {
    const age = p.currentAge + i;
    const inflF = Math.pow(1 + det.infl, i);
    const sold = p.btlSellAge && age >= p.btlSellAge;
    const b = btlYearly(p, i);
    series.push({
      age,
      value: sold ? 0 : b.value / inflF,
      equity: sold ? 0 : b.equity / inflF,
    });
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 12, marginBottom: 18 }}>
        <Card><Stat label="Gross rent / yr" value={gbp(b0.rent)} sub="year 1 of retirement, real" /></Card>
        <Card><Stat label="Net income after tax" value={gbp(b0.net)} sub={`taxed at your ${pct(b0.marginal, 0)} marginal rate`} tone={b0.net > 0 ? "green" : "red"} /></Card>
        <Card><Stat label="Mortgage interest" value={gbp(b0.interest)} sub={`${p.btlRate}% interest-only`} tone="amber" /></Card>
        <Card><Stat label="Equity at retirement" value={gbpK(b0.equity)} sub={`value ${gbpK(b0.value)}`} /></Card>
      </div>

      <Card>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Year-1 rental cashflow (at retirement)</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          Gross rent to net income, with Section 24 applied and the tax computed at your <strong>actual marginal rate that year</strong> ({pct(b0.marginal, 0)}), not a flat assumption.
        </p>
        <div style={{ maxWidth: 470 }}>
          <Row l="Gross rent" v={gbp(b0.rent)} />
          <Row l="Maintenance / management / voids" v={"−" + gbp(b0.opex)} neg />
          <Row l="Mortgage interest" v={"−" + gbp(b0.interest)} neg />
          <div style={{ borderTop: `1px solid ${T.line}`, margin: "6px 0", paddingTop: 6 }}>
            <Row l="Cash profit" v={gbp(b0.cashProfit)} bold />
          </div>
          <Row l="Taxable profit (interest not deductible)" v={gbp(b0.taxableProfit)} />
          <Row l={`Tax at ${pct(b0.marginal, 0)} less 20% interest credit`} v={"−" + gbp(b0.tax)} neg />
          <div style={{ borderTop: `1px solid ${T.line}`, marginTop: 6, paddingTop: 6 }}>
            <Row l="Net income to you" v={gbp(b0.net)} bold />
          </div>
        </div>
        <Note tone="amber">
          The marginal rate is recomputed every year: as the State Pension starts and pension drawdown rises, your rental profit can be pushed from basic into higher rate, so net BTL income shifts over time. Section 24 means interest isn't deductible — you only get a 20% credit — which is what makes a higher-rate landlord's effective rate so punishing.
        </Note>
      </Card>

      <Card style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>BTL marginal rate & net income through retirement</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          Net rental income (real) and the marginal rate it's taxed at, year by year.
        </p>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={s} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={3} />
            <YAxis yAxisId="l" tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={48} />
            <YAxis yAxisId="r" orientation="right" tickFormatter={(v) => pct(v, 0)} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={40} domain={[0, 0.5]} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [n === "marginal" ? pct(v, 0) : gbp(v), n === "marginal" ? "Marginal rate" : "Net income"]} labelFormatter={(a) => `Age ${a}`} />
            <Bar yAxisId="l" dataKey="net" fill="#7A5C9E" name="net" radius={[3, 3, 0, 0]} />
            <Line yAxisId="r" type="stepAfter" dataKey="marginal" stroke={T.amber} strokeWidth={2} dot={false} name="marginal" />
          </ComposedChart>
        </ResponsiveContainer>
        <Legendlet items={[{ c: "#7A5C9E", t: "Net rental income (real)" }, { c: T.amber, t: "Marginal tax rate" }]} />
      </Card>

      <Card style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Property value & equity (real terms)</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          {p.btlSellAge ? `Sold at age ${p.btlSellAge} — net proceeds flow into your drawdown pool.` : `Held for life at ${p.btlGrowth}% capital growth on a ${gbpK(p.btlMortgage)} interest-only loan.`}
        </p>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={series} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={4} />
            <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbp(v), n === "value" ? "Property value" : "Your equity"]} labelFormatter={(a) => `Age ${a}`} />
            <ReferenceLine x={p.retireAge} stroke={T.amber} strokeDasharray="4 3" label={{ value: "Retire", position: "top", fontSize: 10, fill: T.amber }} />
            {det.btlSaleAge && <ReferenceLine x={det.btlSaleAge} stroke={T.red} strokeDasharray="4 3" label={{ value: "Sell", position: "top", fontSize: 10, fill: T.red }} />}
            <Area type="monotone" dataKey="value" stroke={T.blue} strokeWidth={1.6} fill={T.blueSoft} name="value" />
            <Area type="monotone" dataKey="equity" stroke={T.green} strokeWidth={2} fill={T.greenSoft} name="equity" />
          </AreaChart>
        </ResponsiveContainer>
        <Legendlet items={[{ c: T.blue, t: "Property value" }, { c: T.green, t: "Your equity" }]} />
      </Card>

      {det.btlSaleAge ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 12, marginTop: 14 }}>
          <Card><Stat label={`Sold at ${det.btlSaleAge}`} value={gbpK(det.btlSaleProceeds)} sub="net proceeds into drawdown" tone="green" /></Card>
          <Card><Stat label="Capital gain realised" value={gbpK(det.btlSaleGain)} sub="value − purchase price" /></Card>
          <Card><Stat label="CGT paid" value={gbpK(det.btlSaleCGT)} sub="18% / 24% residential" tone="red" /></Card>
        </div>
      ) : (
        <Note tone="blue">
          You're holding the property for life, so the rent feeds your income and the equity ({gbpK(b0.equity)} now) sits outside the drawdown model. Set a "sell at age" to convert the property into spendable capital — CGT at 18%/24% is then applied and the net proceeds are added to your tax-free drawdown pool.
        </Note>
      )}

      <Note tone="amber">
        Simplifications: interest-only mortgage, CGT base cost set to your "original purchase price" input, and proceeds treated as tax-free drawable capital thereafter. Ignores SDLT and the 3% surcharge already paid, letting-relief edge cases, and incorporation. Rental income stacks with your other income for the marginal-rate calculation each year.
      </Note>
    </div>
  );
}

/* ---- Stress / scenarios tab ---- */
/* ---- Phase 3.5: sequence-risk heatmap (core/sequence-heatmap.mjs) ----
   One cell per historical start year: would THIS plan's withdrawal
   schedule have survived retiring into that year's actual sequence of
   returns and inflation? Raw history (minus your fee), withdrawals
   re-priced along each window's real inflation. */

function IhtTab({ p, det, set, liveEstate, livePots }) {
  const [giftForm, setGiftForm] = useState({ date: "", amount: "", exempt: false, note: "" });
  const todayISO = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const planEndISO = useMemo(() => {
    const years = Math.max(0, (p.planAge || 0) - (p.currentAge || 0));
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() + years);
    return d.toISOString().slice(0, 10);
  }, [p.planAge, p.currentAge]);

  // Individual primitives (not one object literal) as the useMemo deps
  // below, so the two projections only recompute when something that
  // actually feeds `projectIHT()` changes — not on every render.
  const ihtMainResidenceToDescendants = p.ihtMainResidenceToDescendants;
  const ihtMarried = p.ihtMarried;
  const ihtCharityPct = (p.ihtCharityPct || 0) / 100;
  const ihtBusinessAgriculturalValue = p.ihtBusinessAgriculturalValue || 0;
  const ihtGifts = p.ihtGifts || [];

  const todayResult = useMemo(() => {
    const investedValue = (livePots?.ISA || 0) + (livePots?.GIA || 0) + (livePots?.LISA || 0);
    return projectIHT({
      mainResidenceToDescendants: ihtMainResidenceToDescendants,
      married: ihtMarried,
      charityGiftPct: ihtCharityPct,
      businessAgriculturalValue: ihtBusinessAgriculturalValue,
      gifts: ihtGifts,
      investedValue,
      pensionValue: livePots?.SIPP || 0,
      propertyEquity: liveEstate?.propertyEquity || 0,
      privateValue: liveEstate?.privateValue || 0,
      rsuValue: liveEstate?.rsuValue || 0,
      otherLiabilities: liveEstate?.otherLiabilities || 0,
      creditCardDebt: liveEstate?.creditCardDebt || 0,
      asOfDate: todayISO,
    });
  }, [livePots, liveEstate, ihtMainResidenceToDescendants, ihtMarried, ihtCharityPct, ihtBusinessAgriculturalValue, ihtGifts, todayISO]);

  const futureResult = useMemo(() => {
    const lastRow = det.timeline[det.timeline.length - 1] || {};
    const pensionValue = Math.max(0, lastRow.pensionReal || 0);
    // det.estateReal already bundles pension + bridge (ISA/GIA/LISA) + BTL
    // equity (if unsold) + other net worth into one real-terms figure —
    // subtracting the pension-only piece leaves everything else in one
    // clean "invested + other" number, which is all projectIHT needs
    // (it just sums whatever it's given; it doesn't care which named
    // field a given £ arrives in).
    const investedValue = Math.max(0, (det.estateReal || 0) - pensionValue);
    return projectIHT({
      mainResidenceToDescendants: ihtMainResidenceToDescendants,
      married: ihtMarried,
      charityGiftPct: ihtCharityPct,
      businessAgriculturalValue: ihtBusinessAgriculturalValue,
      gifts: ihtGifts,
      investedValue,
      pensionValue,
      asOfDate: planEndISO,
    });
  }, [det, ihtMainResidenceToDescendants, ihtMarried, ihtCharityPct, ihtBusinessAgriculturalValue, ihtGifts, planEndISO]);

  const addGift = () => {
    const amount = +giftForm.amount;
    if (!giftForm.date || !Number.isFinite(amount) || amount <= 0) return;
    const gift = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, date: giftForm.date, amount, exempt: giftForm.exempt, note: giftForm.note.trim() };
    set("ihtGifts", [...(p.ihtGifts || []), gift]);
    setGiftForm({ date: "", amount: "", exempt: false, note: "" });
  };
  const removeGift = (id) => set("ihtGifts", (p.ihtGifts || []).filter((g) => g.id !== id));

  const EstateCard = ({ title, sub, r }) => (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 2 }}>
        <div>
          <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>{title}</h3>
          <p style={{ margin: 0, fontSize: 12.5, color: T.muted }}>{sub}</p>
        </div>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 20,
          background: r.pensionCounted ? T.amberSoft : T.greenSoft,
          color: r.pensionCounted ? T.amber : T.green,
        }}>
          {r.pensionCounted ? "Pension IN estate" : "Pension excluded"}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))", gap: 12, marginTop: 12 }}>
        <Card style={{ background: T.paper, border: "none" }}><Stat label="Gross estate" value={gbpK(r.deathEstate)} sub={r.pensionCounted ? `incl. ${gbpK(r.pensionInEstateValue)} pension` : "pension excluded"} /></Card>
        <Card style={{ background: T.paper, border: "none" }}><Stat label="NRB + RNRB available" value={gbpK(r.bandsAvailable)} sub={r.married ? "married — both bands doubled" : "single"} /></Card>
        <Card style={{ background: T.paper, border: "none" }}><Stat label="Taxable estate" value={gbpK(r.netTaxableEstate)} sub={`at ${pct(r.rate, 0)}`} /></Card>
        <Card style={{ background: r.totalIHT > 0 ? T.redSoft : T.greenSoft, border: "none" }}>
          <Stat label="IHT due" value={gbpK(r.totalIHT)} sub={`${gbp(r.totalIHT)} · ${pct(r.effectiveRate, 1)} effective rate`} tone={r.totalIHT > 0 ? "red" : "green"} />
        </Card>
        <Card style={{ background: T.paper, border: "none" }}><Stat label="Net to heirs" value={gbpK(r.netEstateToHeirs)} sub={r.charityGiftAmount > 0 ? `after ${gbpK(r.charityGiftAmount)} to charity` : undefined} /></Card>
      </div>
      {r.giftTaxDue > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: T.amber }}>
          + {gbp(r.giftTaxDue)} additional tax on lifetime gifts within 7 years (typically borne by the recipients, not the estate).
        </div>
      )}
    </Card>
  );

  return (
    <div>
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <Landmark size={17} color={T.ink} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Inheritance tax projection</h3>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: T.muted, maxWidth: 680 }}>
          Nil-rate band £{(325000).toLocaleString("en-GB")} + residence nil-rate band £{(175000).toLocaleString("en-GB")} (tapered above a £2m estate), 40% on the excess (36% if 10%+ of the taxable estate goes to charity). Doesn't model the annual £3,000 gift exemption, so lifetime gifting looks slightly less sheltered here than it would with proper planning — a conservative simplification, not an optimistic one. Unused pension funds join the taxable estate for deaths on or after {PENSIONS_IN_ESTATE_FROM} — which is why "today" and "at your plan's end" below usually look structurally different, not just bigger.
        </p>
      </Card>

      <EstateCard title="Your estate today" sub={`As of ${todayISO}, from your live portfolio`} r={todayResult} />
      <EstateCard title={`At your plan's final year (age ${p.planAge})`} sub={`Projected ${planEndISO}, from the Overview projection`} r={futureResult} />

      <Card style={{ marginBottom: 14 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700 }}>Assumptions</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px,1fr))", gap: 18 }}>
          <div>
            <Toggle label="Married / civil partnership" checked={p.ihtMarried} onChange={(v) => set("ihtMarried", v)} />
            <div style={{ fontSize: 11, color: T.muted, margin: "4px 0 14px" }}>Assumes a spouse who's used none of their own NRB/RNRB — doubles both bands. The real transferable fraction depends on their estate, which isn't modelled here.</div>
            <Toggle label="Main home passes to children/grandchildren" checked={p.ihtMainResidenceToDescendants} onChange={(v) => set("ihtMainResidenceToDescendants", v)} />
            <div style={{ fontSize: 11, color: T.muted, margin: "4px 0 0" }}>Required for the residence nil-rate band to apply at all.</div>
          </div>
          <div>
            <Field label="Left to charity" value={p.ihtCharityPct} min={0} max={100} step={1} suffix="%" onChange={(v) => set("ihtCharityPct", v)} hint="10%+ of the taxable estate drops the rate to 36%" />
            <Field label="Business/agricultural property (BPR/APR)" value={p.ihtBusinessAgriculturalValue} min={0} max={10000000} step={10000} prefix="£" onChange={(v) => set("ihtBusinessAgriculturalValue", v)} hint="100% relief up to £2.5m from April 2026, 50% above" />
          </div>
        </div>
      </Card>

      <Card>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Lifetime gifts (PETs)</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          Gifts drop out of your estate entirely after 7 years; within 7 years, tax on the excess over your remaining nil-rate band tapers down the closer to 7 years you get. Mark a gift "exempt" if it went to a spouse/civil partner or registered charity — those are always outside IHT.
        </p>
        {(p.ihtGifts || []).length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {(p.ihtGifts || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1)).map((g) => (
              <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${T.lineSoft}`, fontSize: 13 }}>
                <span style={{ color: T.muted, width: 92 }}>{g.date}</span>
                <span style={{ fontWeight: 600, width: 100 }} className="num">{gbp(g.amount)}</span>
                {g.exempt && <span style={{ fontSize: 10.5, fontWeight: 700, color: T.green, background: T.greenSoft, padding: "2px 8px", borderRadius: 10 }}>EXEMPT</span>}
                <span style={{ color: T.muted, flex: 1 }}>{g.note}</span>
                <button onClick={() => removeGift(g.id)} title="Remove" style={{ border: "none", background: "none", cursor: "pointer", color: T.red, display: "flex" }}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Date</div>
            <input type="date" value={giftForm.date} onChange={(e) => setGiftForm({ ...giftForm, date: e.target.value })}
              style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: "7px 9px", fontSize: 13, background: T.surface, color: T.ink }} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Amount (£)</div>
            <input type="number" min="0" step="1000" value={giftForm.amount} onChange={(e) => setGiftForm({ ...giftForm, amount: e.target.value })}
              style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: "7px 9px", fontSize: 13, width: 110, background: T.surface, color: T.ink }} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Note (optional)</div>
            <input type="text" value={giftForm.note} onChange={(e) => setGiftForm({ ...giftForm, note: e.target.value })} placeholder="e.g. deposit for daughter's house"
              style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: "7px 9px", fontSize: 13, width: 220, background: T.surface, color: T.ink }} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: T.ink2, paddingBottom: 8 }}>
            <input type="checkbox" checked={giftForm.exempt} onChange={(e) => setGiftForm({ ...giftForm, exempt: e.target.checked })} />
            Exempt (spouse/charity)
          </label>
          <button onClick={addGift} style={{ display: "flex", alignItems: "center", gap: 6, background: T.ink, color: T.paper, border: "none", borderRadius: 9, padding: "8px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
            <Plus size={14} /> Add gift
          </button>
        </div>
      </Card>

      <Note tone="amber">
        Estimates only, not a substitute for professional estate planning advice — real IHT positions involve trusts, business/agricultural relief eligibility tests, and a transferable-band calculation that depends on a spouse's own estate, none of which this simplified model can verify. Figures are today's rules and thresholds; NRB/RNRB are frozen to April 2031 but nothing is guaranteed to stay the same at your plan's final year, decades away.
      </Note>
    </div>
  );
}

export { BtlTab, IhtTab };
