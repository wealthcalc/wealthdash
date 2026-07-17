/* ======================================================================
   AI PORTFOLIO SNAPSHOT — a single Markdown document describing the
   whole portfolio, designed to be PASTED INTO AN LLM PROMPT for
   analysis or allocation discussion. Optimised for a model reader, which
   changes the rules versus a human report:
   - one flat document, no interactivity assumed;
   - every figure labelled with units and an as-of date;
   - per-holding detail in ONE table (models handle wide tables well);
   - data-quality caveats stated INLINE where they bite (unpriced
     holdings, tag coverage, snapshot-only pensions) so the model can't
     silently trust a number this app itself doesn't trust — the same
     honesty contract as the UI, but written where a prompt-reader will
     see it;
   - deliberately NO secrets, ids, or account numbers beyond the user's
     own free-text labels.
   Pure and node-tested (ai-snapshot.test.mjs); the shell assembles the
   inputs from engines it already runs.
   ====================================================================== */

const gbp0 = (x) => "£" + Math.round(+x || 0).toLocaleString("en-GB");
const pct1 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : (x * 100).toFixed(1) + "%");
const cell = (s) => String(s ?? "").replace(/\|/g, "/"); // keep the table intact

export function renderAiSnapshot({
  today,
  netWorth = null,          // householdNetWorth() output
  model = null,             // buildWealthModel() output
  returns = null,           // computeReturns() output
  pensionXirr = {},         // pensionXirrByWrapper() output
  concentration = null,     // concentration() output
  regionExposure = null,    // portfolioExposure(region)
  sectorExposure = null,    // portfolioExposure(sector)
  secMeta = {},
  cashAccounts = [],
  properties = [], mortgages = [],
} = {}) {
  if (!today) throw new Error("renderAiSnapshot requires `today`.");
  const L = [];
  const push = (...xs) => L.push(...xs);

  push(`# Portfolio snapshot — ${today}`, "");
  push("Machine-readable snapshot from a UK personal wealth dashboard. All monetary figures are GBP; prices are the app's most recently fetched quotes as of the date above. Wrappers: GIA = taxable general account; ISA/SIPP/LISA = tax-sheltered (SIPP inaccessible before pension access age); VCT = venture capital trust.", "");

  // ---- totals ----
  push("## Totals");
  if (netWorth) {
    push(`- Net worth: ${gbp0(netWorth.netWorth)}`);
    push(`- Invested + cash (all wrappers): ${gbp0(model?.total?.total ?? 0)}`);
    if (netWorth.propertyEquity) push(`- Property equity: ${gbp0(netWorth.propertyEquity)} (${properties.length} propert${properties.length === 1 ? "y" : "ies"}, ${mortgages.length} mortgage${mortgages.length === 1 ? "" : "s"})`);
    if (netWorth.privateValue) push(`- Private investments (EIS/SEIS/LP, manual valuations): ${gbp0(netWorth.privateValue)}`);
    if (netWorth.rsuValue) push(`- RSU shares held (vested, unsold): ${gbp0(netWorth.rsuValue)}`);
    if (netWorth.deferredCashValue) push(`- Deferred cash compensation (unvested): ${gbp0(netWorth.deferredCashValue)}`);
    if (netWorth.otherLiabilities || netWorth.creditCardDebt) push(`- Liabilities (non-mortgage): −${gbp0((netWorth.otherLiabilities || 0) + (netWorth.creditCardDebt || 0))}`);
  }
  push("");

  // ---- holdings table ----
  const positions = (model?.positions || []).filter((p) => p.qty > 1e-9);
  const pricedTotal = positions.reduce((s, p) => s + (p.priced ? p.marketValue : 0), 0);
  push("## Holdings");
  if (model?.total?.unpriced > 0) {
    push(`> DATA QUALITY: ${model.total.unpriced} holding(s) have no price and show value n/a — totals and weights understate by their value.`);
  }
  push("", "| Ticker | Name | Wrapper | Kind | Qty | Price £ | Value £ | Weight | Book cost £ | P/L | Region | Sector |");
  push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const p of [...positions].sort((a, b) => (b.priced ? b.marketValue : 0) - (a.priced ? a.marketValue : 0))) {
    const m = secMeta[p.ticker] || {};
    const price = p.priced && p.qty ? p.marketValue / p.qty : null;
    const pl = p.priced && p.bookCost > 0 ? (p.marketValue - p.bookCost) / p.bookCost : null;
    push(`| ${cell(p.ticker)} | ${cell(m.name || p.name || "")} | ${p.wrapper} | ${cell(p.kind || "")} | ${(+p.qty).toFixed(2)} | ${price != null ? price.toFixed(2) : "n/a"} | ${p.priced ? Math.round(p.marketValue) : "n/a"} | ${p.priced && pricedTotal > 0 ? pct1(p.marketValue / pricedTotal) : "n/a"} | ${Math.round(p.bookCost)} | ${pct1(pl)} | ${cell(m.region || "")} | ${cell(m.sector || "")} |`);
  }
  push("");
  const snapshotFunds = positions.filter((p) => secMeta[p.ticker]?.provider);
  if (snapshotFunds.length) {
    push(`> NOTE: ${snapshotFunds.length} holding(s) (${snapshotFunds.map((p) => p.ticker).join(", ")}) are pension funds tracked as consolidated snapshots — their book cost is reconciled from contribution history, and their return is measured from real contribution dates (see Returns), not ledger dates.`);
    push("");
  }

  // ---- cash ----
  push("## Cash");
  for (const [w, amt] of Object.entries(model?.cash || {})) if (amt > 0) push(`- ${w} unallocated cash: ${gbp0(amt)}`);
  for (const a of cashAccounts) {
    push(`- ${cell(a.label || a.institution || "account")} (${a.wrapper}): ${gbp0(a.balance)}${a.rate != null ? `, ${a.rate}% ${a.rateType || ""}` : ", rate unknown"}${a.maturityDate ? `, matures ${a.maturityDate}` : ""}`);
  }
  push("");

  // ---- allocation ----
  const alloc = (title, buckets, coverage) => {
    if (!buckets?.length) return;
    push(`### ${title}`);
    for (const b of buckets) push(`- ${cell(b.key)}: ${gbp0(b.marketValue)} (${pct1(b.pct)})`);
    if (coverage) push(`- _Coverage: ${pct1(coverage.lookthroughPct)} factsheet look-through, ${pct1(coverage.taggedPct)} single hand-tag, ${pct1(coverage.untaggedPct)} untagged — treat region/sector rows as approximate._`);
    push("");
  };
  push("## Allocation");
  alloc("By wrapper", model?.allocation?.wrapper);
  alloc("By asset class", model?.allocation?.assetClass);
  alloc("By native trading currency (listing proxy, not underlying exposure)", model?.allocation?.currency);
  alloc("By region (blended look-through)", regionExposure?.buckets, regionExposure?.coverage);
  alloc("By sector (blended look-through)", sectorExposure?.buckets, sectorExposure?.coverage);

  // ---- concentration ----
  if (concentration?.total > 0) {
    push("## Concentration");
    push(`- Top holding: ${concentration.top1.ticker} at ${pct1(concentration.top1.weight)} of priced value (RSU-held employer shares merged in)`);
    push(`- Top 5 weight: ${pct1(concentration.top5Weight)}; effective number of holdings (1/HHI): ${concentration.effectiveN.toFixed(1)}`);
    for (const a of concentration.alerts) push(`- SINGLE-COMPANY RISK: ${a.ticker} is ${pct1(a.weight)} (${gbp0(a.value)})`);
    push("");
  }

  // ---- returns & income ----
  push("## Returns & income");
  if (returns?.total) {
    const x = returns.total.xirr;
    if (x?.rate != null) push(`- Money-weighted return (XIRR), ledger-dated holdings: ${pct1(x.rate)}/yr${x.xirrScope?.snapshotOnlyExcluded ? ` (${x.xirrScope.snapshotOnlyExcluded} snapshot-only pension funds excluded)` : ""}`);
    for (const [w, r] of Object.entries(pensionXirr)) if (r?.rate != null) push(`- ${w} pension XIRR from real contribution dates: ${pct1(r.rate)}/yr across ${r.providers} provider(s)`);
    if (returns.portfolioTWR?.twr != null) push(`- Portfolio time-weighted return: ${pct1(returns.portfolioTWR.twr)} over ${returns.portfolioTWR.from} → ${returns.portfolioTWR.to}`);
    push(`- Income: ${gbp0(returns.total.trailing12m)} trailing 12m (${pct1(returns.total.actualYield)} yield); forward estimate ${gbp0(returns.total.forwardIncome)} (${pct1(returns.total.forwardYield)})`);
  }
  push("");
  push("---");
  push("_Not included: transaction-level history, tax computations, retirement plan inputs. Figures are the app's own estimates; property and private valuations are manual/indexed, not appraisals._");
  return L.join("\n");
}
