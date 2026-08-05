/* Plan sub-tabs: Accumulation (building the pot) and Decumulation (drawing
   it down), plus the marginal-rate helper they share. Extracted verbatim
   from PlanTab.jsx during the file split; no behaviour change. */
import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, AreaChart, LineChart, BarChart,
  Area, Line, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ReferenceArea,
} from "recharts";
import { TrendingUp, TrendingDown, Info, Coins, Layers, Landmark } from "lucide-react";
import { T, MONO, SANS, gbp, gbpK, pct, tooltipStyle } from "./theme.js";
import { Card, Stat, Field, Segmented, Toggle, PanelSection, Legendlet, Note, Barline, Row } from "./controls.jsx";
import { taxRUK, taxScot, employeeNI, netEmploymentIncome } from "../../core/uk-income-tax.mjs";
import { lifeExpectancy, effInflation, btlYearly, replayDecum, STRATEGY_LABELS, buildProjection, HIST } from "../../core/drawdown.mjs";

function AccumulationTab({ p, det, feeFree, feeDrag }) {
  const taxFn = p.region === "scotland" ? taxScot : taxRUK;
  const tax = taxFn(p.salary);
  const ni = employeeNI(p.salary);
  const empContrib = (p.salary * p.empPct) / 100;
  const erContrib = (p.salary * p.erPct) / 100;
  const reliefRate = marginalRate(p.salary, p.region);
  const reliefValue = empContrib * (reliefRate + 0.02); // tax + ~NI under sacrifice

  const accumData = det.timeline.filter((d) => d.phase === "accum").map((d, i) => ({
    age: d.age,
    contributions: det.wealthContribSchedule.slice(0, i + 1).reduce((a, b) => a + b, 0),
    pension: d.pension,
    bridge: d.bridge,
    real: d.potReal,
  }));
  const totalPensionContrib = det.contribSchedule.reduce((a, b) => a + b, 0);
  const totalIsaContrib = (p.isaContrib + p.giaContrib + Math.min(p.lisaContrib, 4000) * 1.25) * det.accumYears;
  const totalContrib = totalPensionContrib + totalIsaContrib;
  const startTotal = p.startPot + p.isaStart + p.giaStart + p.lisaStart;
  const growthPortion = det.wealthAtRetire - startTotal - totalContrib;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 12, marginBottom: 18 }}>
        <Card><Stat label="Marginal tax rate" value={pct(reliefRate, 0)} sub="on your top £ of income" tone={reliefRate >= 0.6 ? "amber" : "ink"} /></Card>
        <Card><Stat label="Pension + ISA in / yr" value={gbp(det.firstContrib + p.isaContrib)} sub={`${gbp(det.firstContrib)} pension · ${gbp(p.isaContrib)} ISA`} /></Card>
        <Card><Stat label="Annual Allowance" value={gbp(det.aa)} sub={det.aaBreach ? "exceeded ⚠" : "within limit"} tone={det.aaBreach ? "red" : "green"} /></Card>
        <Card><Stat label="Tax + NI relief / yr" value={gbp(reliefValue)} sub="on pension contribution" tone="green" /></Card>
      </div>

      <Card>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>What builds your wealth</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          Pension and ISA/GIA bridge grow side by side over {det.accumYears} years — the bridge is what lets you retire before {p.accessAge}.
        </p>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={accumData} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} />
            <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbpK(v), n === "pension" ? "Pension pot" : n === "bridge" ? "ISA/GIA bridge" : "Contributions paid in"]} labelFormatter={(a) => `Age ${a}`} />
            <Area type="monotone" dataKey="pension" stackId="w" stroke={T.green} strokeWidth={2} fill={T.greenSoft} name="pension" />
            <Area type="monotone" dataKey="bridge" stackId="w" stroke={T.gold} strokeWidth={2} fill={T.amberSoft} name="bridge" />
            <Area type="monotone" dataKey="contributions" stroke={T.blue} strokeWidth={1.4} fill="none" name="contributions" />
          </AreaChart>
        </ResponsiveContainer>
        <Legendlet items={[{ c: T.green, t: "Pension pot" }, { c: T.gold, t: "ISA/GIA bridge" }, { c: T.blue, t: "Contributions paid in" }]} />
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px,1fr))", gap: 12, marginTop: 14 }}>
        <Card>
          <h4 style={{ margin: "0 0 10px", fontSize: 13.5 }}>Wealth composition at retirement</h4>
          <Barline label="Starting balances" value={startTotal} total={det.wealthAtRetire} color={T.muted} />
          <Barline label="Contributions" value={totalContrib} total={det.wealthAtRetire} color={T.blue} />
          <Barline label="Investment growth" value={growthPortion} total={det.wealthAtRetire} color={T.green} />
          <div style={{ borderTop: `1px solid ${T.line}`, marginTop: 10, paddingTop: 10, display: "flex", justifyContent: "space-between", fontFamily: MONO, fontWeight: 700 }}>
            <span>Total</span><span>{gbp(det.wealthAtRetire)}</span>
          </div>
          <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>
            Split: {gbp(det.potAtRetire)} pension · {gbp(det.bridgeAtRetire)} ISA/bridge.
          </div>
        </Card>
        <Card>
          <h4 style={{ margin: "0 0 10px", fontSize: 13.5 }}>Current take-home</h4>
          <Row l="Gross salary" v={gbp(p.salary)} />
          <Row l="Income tax" v={"−" + gbp(tax)} neg />
          <Row l="Employee NI" v={"−" + gbp(ni)} neg />
          <Row l="Your pension" v={"−" + gbp(empContrib)} neg />
          <div style={{ borderTop: `1px solid ${T.line}`, marginTop: 8, paddingTop: 8 }}>
            <Row l="Net take-home" v={gbp(det.preNetToday)} bold />
          </div>
          <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>
            Employer adds {gbp(erContrib)} on top, outside your take-home.
          </div>
        </Card>
      </div>

      <Card style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Fee drag: {p.fee}% vs DIY (0%)</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          A {p.fee}% annual fee compounds against you. Same contributions and market returns, only the charge differs.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))", gap: 12, marginBottom: 6 }}>
          <Stat label={`Wealth @ ${p.fee}% fee`} value={gbpK(det.wealthAtRetire)} tone="ink" />
          <Stat label="Wealth @ 0% (DIY)" value={gbpK(feeFree.wealthAtRetire)} tone="green" />
          <Stat label="Cost of fees" value={gbpK(feeDrag)} sub={`${pct(feeDrag / Math.max(1, feeFree.wealthAtRetire), 1)} of pot surrendered`} tone="red" />
        </div>
        <div style={{ height: 8, background: T.greenSoft, borderRadius: 4, overflow: "hidden", marginTop: 6 }}>
          <div style={{ width: pct(det.wealthAtRetire / Math.max(1, feeFree.wealthAtRetire)), height: "100%", background: T.green }} />
        </div>
        <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>
          Over {det.accumYears} years, fees quietly take {gbp(feeDrag)} off your retirement pot — before you've drawn a penny. The drag continues through retirement too.
        </div>
      </Card>
    </div>
  );
}


function marginalRate(income, region) {
  const fn = region === "scotland" ? taxScot : taxRUK;
  const d = 100;
  return (fn(income + d) - fn(income)) / d;
}

/* ---- Decumulation tab ---- */
function DecumulationTab({ p, det, retireRow }) {
  const decData = det.timeline
    .filter((d) => d.phase === "decum")
    .map((d) => ({
      age: d.age,
      pension: d.pensionDrawReal || 0,
      bridge: d.bridgeDrawReal || 0,
      state: d.stateReal || 0,
      db: d.dbReal || 0,
      annuity: d.annuityReal || 0,
      btl: d.btlNetReal || 0,
      spend: d.spendReal || 0,
      pensionPot: d.pensionReal,
      bridgePot: d.bridgeReal,
    }));
  const taxFn = p.region === "scotland" ? taxScot : taxRUK;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 12, marginBottom: 18 }}>
        <Card><Stat label="Yr-1 gross income" value={gbp(det.firstYearGross)} sub={det.firstYearBridgeDraw > 1 ? "pension + wrappers + State" : "pension + State Pension"} /></Card>
        <Card><Stat label="Yr-1 tax" value={gbp(det.firstYearTax)} sub="income tax + any CGT" tone="amber" /></Card>
        <Card><Stat label="Yr-1 net" value={gbp(det.firstYearNet)} sub="spendable, nominal" tone="green" /></Card>
        <Card><Stat label="Drawdown order" value={STRATEGY_LABELS[p.drawStrategy]} sub="see Sequencing tab" tone="ink" /></Card>
      </div>

      <Card>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Where retirement income comes from</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          In today's money. The dashed line is your target spend — useful when the spending profile isn't flat.
        </p>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={decData} margin={{ top: 10, right: 8, left: 8, bottom: 0 }} barCategoryGap={1}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={3} />
            <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbpK(v), { pension: "Pension", bridge: "ISA/GIA/LISA", state: "State Pension", db: "DB pension", annuity: "Annuity", btl: "BTL net rent", spend: "Target spend" }[n]]} labelFormatter={(a) => `Age ${a}`} />
            <Bar dataKey="bridge" stackId="a" fill={T.gold} name="bridge" />
            <Bar dataKey="pension" stackId="a" fill={T.green} name="pension" />
            {p.annuityEnabled && <Bar dataKey="annuity" stackId="a" fill="#7A5C9E" name="annuity" />}
            {p.dbEnabled && <Bar dataKey="db" stackId="a" fill={T.ink2} name="db" />}
            {det.btlEnabled && <Bar dataKey="btl" stackId="a" fill="#B0884E" name="btl" />}
            <Bar dataKey="state" stackId="a" fill={T.blue} name="state" />
            <Line type="monotone" dataKey="spend" stroke={T.red} strokeWidth={1.6} strokeDasharray="4 3" dot={false} name="spend" />
          </ComposedChart>
        </ResponsiveContainer>
        <Legendlet items={[{ c: T.gold, t: "ISA/GIA/LISA" }, { c: T.green, t: "Pension" }, ...(p.annuityEnabled ? [{ c: "#7A5C9E", t: "Annuity" }] : []), ...(p.dbEnabled ? [{ c: T.ink2, t: "DB" }] : []), ...(det.btlEnabled ? [{ c: "#B0884E", t: "BTL" }] : []), { c: T.blue, t: "State" }, { c: T.red, t: "Target spend", dash: true }]} />
      </Card>

      <Card style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Pots run-down (real terms)</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          {det.depletionAge ? `Combined wealth can't sustain the target from age ${det.depletionAge}.` : `Both pots sustain the target to age ${p.planAge}.`} The ISA/bridge is usually drawn first.
        </p>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={decData} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={3} />
            <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbpK(v), n === "pensionPot" ? "Pension pot" : "ISA/bridge"]} labelFormatter={(a) => `Age ${a}`} />
            {det.depletionAge && <ReferenceLine x={det.depletionAge} stroke={T.red} strokeDasharray="4 3" />}
            <Area type="monotone" dataKey="pensionPot" stackId="p" stroke={T.green} strokeWidth={2} fill={T.greenSoft} name="pensionPot" />
            <Area type="monotone" dataKey="bridgePot" stackId="p" stroke={T.gold} strokeWidth={2} fill={T.amberSoft} name="bridgePot" />
          </AreaChart>
        </ResponsiveContainer>
        <Legendlet items={[{ c: T.green, t: "Pension pot" }, { c: T.gold, t: "ISA/bridge" }]} />
      </Card>

      <Note tone="blue">
        {p.tfcMode === "ufpls"
          ? "Tax-free cash is spread UFPLS-style (25% of each pension withdrawal is tax-free). "
          : `25% (${gbp(det.pclsAmount)}) was taken upfront into the ISA/bridge, so pension withdrawals here are fully taxable. `}
        The drawdown waterfall fills the basic-rate band from the pension first, then tops up from the tax-free bridge to avoid higher-rate tax — and the bridge is the only source before age {p.accessAge}. Tax thresholds are assumed to rise with CPI, so tax stays roughly constant in real terms.
      </Note>
    </div>
  );
}

/* ---- Drawdown sequencing optimiser ---- */
/* ===================== INCOME FLOOR ===================== */
// Guaranteed income (State Pension + DB + annuity + the gilt ladder's
// contractual cashflows) stacked against the essential share of target
// spending, per retirement year — core/income-floor.mjs. A different
// question to Monte Carlo's "will the pot last?": this asks "if markets
// fell apart, what still gets paid?". BTL rent is deliberately excluded
// (voids/arrears make it contingent — see the module header); gilt
// cashflows are only the gilts held TODAY, so the ladder visibly runs out
// rather than being smoothed away.

export { AccumulationTab, DecumulationTab, marginalRate };
