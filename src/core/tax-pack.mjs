/* ======================================================================
   TAX PACK — one self-contained, printable HTML file per tax year with
   everything the tax return (or the accountant) needs from this app:

     1. CGT computation (SA108 boxes: disposals, proceeds, gains, losses,
        AEA, losses b/f used, taxable gain, estimated tax)
     2. Disposal schedule with HMRC matching legs (same-day / 30-day /
        Section 104) per disposal
     3. Dividend & interest schedule (GIA only — the taxable part), with
        per-source subtotals
     4. Excess reportable income (ERI) as recorded

   Two pure functions: buildTaxPack() assembles structured data (node-
   tested); renderTaxPackHTML() turns it into a standalone HTML string —
   inline styles, no scripts, no external requests — that prints cleanly
   to PDF from any browser. Values are HTML-escaped: tickers and notes
   are user input and a tax pack must not be an XSS vector when opened.

   The output is an ESTIMATE to support filing, not tax advice — the
   disclaimer is baked into the document itself, not just the app.
   ====================================================================== */
import { ukTaxYear } from "./cgt-engine.mjs";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r2 = (x) => Math.round((+x || 0) * 100) / 100;
const gbp = (x) => "£" + (+x || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function buildTaxPack({ year, disposals = [], liability = null, incomeEntries = [], eriEntries = [], carried = 0 } = {}) {
  if (!year) throw new Error("buildTaxPack requires a tax year (e.g. 2025/26).");
  const yearDisposals = disposals.filter((d) => d.taxYear === year);
  const isGIA = (w) => (w || "GIA") === "GIA";
  const divs = incomeEntries.filter((e) => e.date && isGIA(e.wrapper) && ukTaxYear(e.date) === year && e.kind !== "interest" && +e.amount > 0);
  const ints = incomeEntries.filter((e) => e.date && isGIA(e.wrapper) && ukTaxYear(e.date) === year && e.kind === "interest" && +e.amount > 0);
  const eri = eriEntries.filter((e) => e.distributionDate && ukTaxYear(e.distributionDate) === year);

  const bySource = (rows) => {
    const m = {};
    for (const e of rows) { const k = e.ticker || e.source || "(unlabelled)"; m[k] = r2((m[k] || 0) + (+e.amount || 0)); }
    return Object.entries(m).map(([source, total]) => ({ source, total })).sort((a, b) => b.total - a.total);
  };

  return {
    year,
    generatedAt: new Date().toISOString().slice(0, 10),
    cgt: {
      disposalCount: yearDisposals.length,
      totalProceeds: r2(yearDisposals.reduce((s, d) => s + d.proceeds, 0)),
      totalCosts: r2(yearDisposals.reduce((s, d) => s + d.cost, 0)),
      gains: r2(yearDisposals.filter((d) => d.gain > 0).reduce((s, d) => s + d.gain, 0)),
      losses: r2(yearDisposals.filter((d) => d.gain < 0).reduce((s, d) => s - d.gain, 0)),
      lossesBroughtForward: r2(carried),
      liability: liability ? {
        aea: liability.aea, taxableGain: r2(liability.taxable ?? 0), tax: r2(liability.tax ?? 0),
        lossesUsed: r2(liability.lossesUsed ?? 0), carriedForward: r2(liability.carriedForward ?? 0),
      } : null,
      disposals: yearDisposals.map((d) => ({
        date: d.date, ticker: d.ticker, quantity: d.quantity,
        proceeds: r2(d.proceeds), cost: r2(d.cost), gain: r2(d.gain),
        legs: (d.legs || []).map((l) => ({ method: l.method, quantity: l.quantity, proceeds: r2(l.proceeds), cost: r2(l.cost), gain: r2(l.gain) })),
      })),
    },
    dividends: { rows: divs.map((e) => ({ date: e.date, ticker: e.ticker || "", amount: r2(e.amount) })), total: r2(divs.reduce((s, e) => s + +e.amount, 0)), bySource: bySource(divs) },
    interest: { rows: ints.map((e) => ({ date: e.date, ticker: e.ticker || "", amount: r2(e.amount) })), total: r2(ints.reduce((s, e) => s + +e.amount, 0)), bySource: bySource(ints) },
    eri: eri.map((e) => ({ ticker: e.ticker, distributionDate: e.distributionDate, periodEnd: e.periodEnd || "", perShare: e.perShare, currency: e.currency || "GBP", treatment: e.treatment || "dividends" })),
  };
}

const METHOD_LABEL = { SAME_DAY: "Same day", THIRTY_DAY: "30-day", SECTION_104: "S.104 pool" };

export function renderTaxPackHTML(pack) {
  const p = pack;
  const row = (cells, mono = true) => `<tr>${cells.map((c, i) => `<td style="padding:4px 10px;border-bottom:1px solid #ddd;${i > 0 && mono ? "text-align:right;font-family:ui-monospace,Menlo,monospace;" : ""}">${c}</td>`).join("")}</tr>`;
  const head = (cols) => `<tr>${cols.map((c, i) => `<th style="padding:6px 10px;text-align:${i === 0 ? "left" : "right"};border-bottom:2px solid #333;font-size:11px;text-transform:uppercase;letter-spacing:.04em;">${c}</th>`).join("")}</tr>`;
  const h2 = (t) => `<h2 style="font-size:16px;margin:28px 0 8px;border-bottom:1px solid #999;padding-bottom:4px;">${t}</h2>`;
  const L = p.cgt.liability;

  const disposalRows = p.cgt.disposals.map((d) =>
    row([`${esc(d.date)} · <b>${esc(d.ticker)}</b> × ${d.quantity}`, gbp(d.proceeds), gbp(d.cost), gbp(d.gain)]) +
    d.legs.map((l) => row([`<span style="color:#666;padding-left:18px;">↳ ${METHOD_LABEL[l.method] || esc(l.method)} × ${l.quantity}</span>`, gbp(l.proceeds), gbp(l.cost), gbp(l.gain)])).join("")
  ).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tax pack ${esc(p.year)}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:820px;margin:32px auto;padding:0 16px;font-size:13px;line-height:1.5;">
<h1 style="font-size:22px;margin:0;">Tax pack — ${esc(p.year)}</h1>
<p style="color:#555;margin:4px 0 0;">Generated ${esc(p.generatedAt)} by Wealth Dashboard. Figures are an estimate to support filing, <b>not tax advice</b> — verify before submitting to HMRC.</p>

${h2("1 · Capital gains summary (SA108)")}
<table style="border-collapse:collapse;width:100%;">
${row(["Disposals", String(p.cgt.disposalCount)])}
${row(["Total proceeds", gbp(p.cgt.totalProceeds)])}
${row(["Total allowable costs (incl. recorded fees)", gbp(p.cgt.totalCosts)])}
${row(["Gains (before losses)", gbp(p.cgt.gains)])}
${row(["Losses in year", gbp(p.cgt.losses)])}
${L ? row(["Annual exempt amount", gbp(L.aea)]) + row(["Losses used (incl. brought forward)", gbp(L.lossesUsed)]) + row(["<b>Taxable gain</b>", `<b>${gbp(L.taxableGain)}</b>`]) + row(["<b>Estimated CGT</b>", `<b>${gbp(L.tax)}</b>`]) + row(["Losses carried forward", gbp(L.carriedForward)]) : ""}
</table>

${h2("2 · Disposal schedule with HMRC matching")}
${p.cgt.disposals.length ? `<table style="border-collapse:collapse;width:100%;">${head(["Disposal", "Proceeds (net)", "Cost", "Gain/loss"])}${disposalRows}</table>` : "<p>No disposals this year.</p>"}

${h2("3 · Dividends (GIA — taxable)")}
${p.dividends.rows.length ? `<table style="border-collapse:collapse;width:100%;">${head(["Source", "Total"])}${p.dividends.bySource.map((s) => row([esc(s.source), gbp(s.total)])).join("")}${row(["<b>Total dividends</b>", `<b>${gbp(p.dividends.total)}</b>`])}</table>` : "<p>None recorded.</p>"}

${h2("4 · Interest (GIA — taxable)")}
${p.interest.rows.length ? `<table style="border-collapse:collapse;width:100%;">${head(["Source", "Total"])}${p.interest.bySource.map((s) => row([esc(s.source), gbp(s.total)])).join("")}${row(["<b>Total interest</b>", `<b>${gbp(p.interest.total)}</b>`])}</table>` : "<p>None recorded.</p>"}

${h2("5 · Excess reportable income (offshore funds)")}
${p.eri.length ? `<table style="border-collapse:collapse;width:100%;">${head(["Fund", "Distribution date", "Per share", "Treatment"])}${p.eri.map((e) => row([esc(e.ticker), esc(e.distributionDate), `${esc(String(e.perShare))} ${esc(e.currency)}`, esc(e.treatment)])).join("")}</table><p style="color:#555;">ERI amounts feed the dividend/interest figures above via units held at each period end, and uplift Section 104 pool costs — see the app's Income tab for the per-holding detail.</p>` : "<p>None recorded.</p>"}

<p style="color:#777;margin-top:28px;font-size:11px;">All amounts GBP. Disposal proceeds are net of recorded incidental costs; acquisition costs include them (s38 TCGA 1992). Matching per HMRC share-identification rules: same-day, then 30-day, then Section 104 pool.</p>
</body></html>`;
}
