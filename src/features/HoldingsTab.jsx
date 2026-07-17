import React, { useState, useMemo } from "react";
import { AlertTriangle, PieChart } from "lucide-react";
import { isWrapperTaxable } from "../core/portfolio.mjs";
import { parseExposurePaste, portfolioExposure, overlapMatrix } from "../core/lookthrough.mjs";
import LivePricesPanel from "../ui/LivePricesPanel.jsx";
import { gbp, gbp0, WrapperChip, num, pct, KIND_LABEL, AllocBar, Stat, Empty, useSort, sortRows, SortTh, todayISO, useVirtualRows, VIRTUALIZE_THRESHOLD } from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";

/* Factsheet exposure editor — look-through v1 (core/lookthrough.mjs).
   Paste the region and/or sector percentage table from a fund's factsheet
   page; it's stored on secMeta[ticker].exposure and the Wealth tab's
   exposure bars use it instead of the single hand-tag. */
function ExposureEditor({ tickers, secMeta, setSecMeta }) {
  const [open, setOpen] = useState(false);
  const [tk, setTk] = useState("");
  const [regionText, setRegionText] = useState("");
  const [sectorText, setSectorText] = useState("");
  const [msg, setMsg] = useState("");
  const withTables = tickers.filter((t) => secMeta[t]?.exposure);

  const save = () => {
    const t = tk.toUpperCase().trim();
    if (!t) { setMsg("Pick a ticker first."); return; }
    const region = parseExposurePaste(regionText);
    const sector = parseExposurePaste(sectorText, { canonical: (s) => String(s).trim() });
    if (!Object.keys(region.table).length && !Object.keys(sector.table).length) { setMsg("Nothing parseable — paste lines like \"United States  62.1%\"."); return; }
    setSecMeta((m) => ({
      ...m,
      [t]: {
        ...m[t],
        exposure: {
          ...(m[t]?.exposure || {}),
          ...(Object.keys(region.table).length ? { region: region.table } : {}),
          ...(Object.keys(sector.table).length ? { sector: sector.table } : {}),
          asOf: todayISO(), source: "factsheet paste",
        },
      },
    }));
    const warn = [...region.warnings, ...sector.warnings].filter((w) => w.includes("sum"));
    setMsg(`Saved exposure for ${t}${Object.keys(region.table).length ? ` — ${Object.keys(region.table).length} region buckets` : ""}${Object.keys(sector.table).length ? `, ${Object.keys(sector.table).length} sector buckets` : ""}.${warn.length ? " " + warn.join(" ") : ""}`);
    setRegionText(""); setSectorText("");
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <button onClick={() => setOpen((o) => !o)} className="text-sm font-semibold text-left w-full" aria-expanded={open}>
        Fund exposure tables (look-through) {open ? "▾" : "▸"}
        <span className="text-xs font-normal text-[var(--muted)] ml-2">
          {withTables.length ? `${withTables.length} fund${withTables.length > 1 ? "s" : ""} have factsheet tables: ${withTables.join(", ")}` : "none pasted yet — region/sector bars fall back to single tags"}
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Copy the geographic/sector breakdown table from the fund's factsheet page (issuer site or justETF) and paste it below — one "Label 62.1%" per line. This replaces the single Region/Sector tag for that fund with its real percentage mix on the Wealth tab.
          </p>
          <div className="flex gap-2 items-end flex-wrap">
            <label className="text-xs text-[var(--muted)]">Ticker
              <input list="exposure-tickers" value={tk} onChange={(e) => setTk(e.target.value)} placeholder="VWRL" className="input w-28 block mt-1" />
            </label>
            <datalist id="exposure-tickers">{tickers.map((t) => <option key={t} value={t} />)}</datalist>
            <button onClick={save} className="btn-accent">Save exposure</button>
          </div>
          <div className="grid sm:grid-cols-2 gap-2">
            <label className="text-xs text-[var(--muted)]">Region breakdown
              <textarea value={regionText} onChange={(e) => setRegionText(e.target.value)} rows={5} placeholder={"United States\t62.1%\nJapan\t6.2%\nUnited Kingdom\t3.5%\n…"} className="input w-full font-mono text-xs mt-1" />
            </label>
            <label className="text-xs text-[var(--muted)]">Sector breakdown (optional)
              <textarea value={sectorText} onChange={(e) => setSectorText(e.target.value)} rows={5} placeholder={"Technology\t24.9%\nFinancials\t16.1%\n…"} className="input w-full font-mono text-xs mt-1" />
            </label>
          </div>
          {msg && <div role="status" className="text-xs rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2">{msg}</div>}
        </div>
      )}
    </div>
  );
}

// Raw persisted state (prices, security meta) comes from the store via
// selectors; only DERIVED data arrives as props: `positions` (from the
// shell's wealth model), plus `model` (for its allocation buckets) and
// `concentration` (single-company risk incl. RSU shares, core/exposure.mjs)
// — the "how am I invested" views moved here from the Net worth ▸ Balance
// sheet tab, since concentration and region/sector exposure are a portfolio
// question, not a balance-sheet one. Part of the Phase 2.8 de-drilling pass.
function HoldingsTab({ positions, model = null, concentration = null, aiSnapshot = null }) {
  const [snapMsg, setSnapMsg] = React.useState("");
  const flashSnap = (m) => { setSnapMsg(m); setTimeout(() => setSnapMsg(""), 3500); };
  // AI snapshot (core/ai-snapshot.mjs, assembled by the shell): a Markdown
  // portfolio document written for LLM prompts — copy for pasting into a
  // chat, or download for attaching.
  const copySnapshot = async () => {
    if (!aiSnapshot) return;
    try { await navigator.clipboard.writeText(aiSnapshot); flashSnap("Snapshot copied — paste it into any AI chat."); }
    catch { flashSnap("Couldn't copy in this frame — use Download instead."); }
  };
  const downloadSnapshot = () => {
    if (!aiSnapshot) return;
    try {
      const url = URL.createObjectURL(new Blob([aiSnapshot], { type: "text/markdown" }));
      const a = document.createElement("a"); a.href = url; a.download = `portfolio-snapshot-${new Date().toISOString().slice(0, 10)}.md`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      flashSnap("Snapshot downloaded (.md).");
    } catch { flashSnap("Download blocked here — try the deployed app."); }
  };
  const prices = useAppStore((s) => s.prices), setPrices = useAppStore((s) => s.setPrices);
  const secMeta = useAppStore((s) => s.secMeta), setSecMeta = useAppStore((s) => s.setSecMeta);
  const open = positions.filter((p) => p.qty > 1e-6);
  const [sort, toggleSort] = useSort("wrapper", "asc");
  // Look-through v1 (core/lookthrough.mjs) — blends pasted factsheet exposure
  // tables over hand tags over untagged, coverage reported. Kept above the
  // early return so hook order is stable whether or not there are open
  // holdings this render.
  const regionExposure = useMemo(
    () => portfolioExposure({ positions, secMeta, field: "region" }),
    [positions, secMeta]
  );
  const sectorExposure = useMemo(
    () => portfolioExposure({ positions, secMeta, field: "sector" }),
    [positions, secMeta]
  );
  const similarity = useMemo(
    () => overlapMatrix({ positions, secMeta, field: "region" }),
    [positions, secMeta]
  );
  if (!open.length) return <Empty msg="No open holdings yet. Add buy transactions (any wrapper) to see your positions and unrealised gains." />;

  const setISIN = (tk, v) => setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], isin: v.toUpperCase().trim() } }));
  // Region/sector tags — look-through v0, read by the Wealth tab's
  // exposure bars (core/exposure.mjs). Free text with suggestions;
  // whatever the user types is their own claim about what a fund holds.
  const setTag = (tk, field, v) => setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], [field]: v } }));

  // Sorted by ticker first so that when the user's chosen sort key ties
  // (e.g. every row shares a wrapper), the stable sort below keeps a
  // sensible secondary order instead of falling back to insertion order.
  const baseRows = open.map((p) => {
    const cost = p.bookCost;
    const avg = p.qty ? cost / p.qty : 0;
    const price = prices[p.ticker] ?? "";
    const hasP = price !== "" && !isNaN(+price);
    const value = hasP ? p.qty * +price : null;
    const unreal = hasP ? value - cost : null;
    return { tk: p.ticker, wrapper: p.wrapper, qty: p.qty, cost, avg, price, value, unreal,
      pct: hasP && cost ? (unreal / cost) * 100 : null, sec: secMeta[p.ticker] || {},
      sheltered: !isWrapperTaxable(p.wrapper) };
  }).sort((a, b) => a.tk.localeCompare(b.tk));
  const rows = sortRows(baseRows, sort, {
    wrapper: (r) => r.wrapper, tk: (r) => r.tk, qty: (r) => r.qty, avg: (r) => r.avg, cost: (r) => r.cost,
    price: (r) => (r.price === "" ? null : +r.price), value: (r) => r.value, unreal: (r) => r.unreal, pct: (r) => r.pct,
  });

  // Windowed rendering past VIRTUALIZE_THRESHOLD rows (see ui/shared.jsx) —
  // realistically bounded by distinct positions rather than transaction
  // count, but wired up the same way as Ledger for a multi-account/broad
  // portfolio that genuinely gets there.
  const HOLDINGS_ROW_H = 44;
  const virtualHoldings = rows.length > VIRTUALIZE_THRESHOLD;
  const { containerRef: holdingsScrollRef, start: holdingsStart, end: holdingsEnd, topPad: holdingsTopPad, bottomPad: holdingsBottomPad } =
    useVirtualRows(virtualHoldings ? rows.length : 0, HOLDINGS_ROW_H);
  const visibleRows = virtualHoldings ? rows.slice(holdingsStart, holdingsEnd) : rows;

  const priced = rows.filter((r) => r.value != null);
  const totCost = priced.reduce((s, r) => s + r.cost, 0);
  const totValue = priced.reduce((s, r) => s + r.value, 0);
  const totUnreal = totValue - totCost;
  const missingIsin = rows.filter((r) => !r.sec.isin).length;
  const tickers = [...new Set(rows.map((r) => r.tk))];
  // Taxable vs sheltered split of pool cost, so the all-wrapper view still
  // makes the CGT-relevant portion obvious at a glance.
  const taxableCost = rows.filter((r) => !r.sheltered).reduce((s, r) => s + r.cost, 0);
  const shelteredCost = rows.filter((r) => r.sheltered).reduce((s, r) => s + r.cost, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Open pool cost" value={gbp0(rows.reduce((s, r) => s + r.cost, 0))} sub={`taxable ${gbp0(taxableCost)} · sheltered ${gbp0(shelteredCost)}`} />
        <Stat label="Market value (priced)" value={priced.length ? gbp0(totValue) : "—"} sub={priced.length < rows.length ? `${priced.length}/${rows.length} priced` : "all priced"} />
        <Stat label="Unrealised gain" value={priced.length ? gbp0(totUnreal) : "—"} tone={totUnreal >= 0 ? "gain" : "loss"} big />
        <Stat label="Unrealised %" value={priced.length && totCost ? `${totUnreal >= 0 ? "+" : ""}${num((totUnreal / totCost) * 100)}%` : "—"} tone={totUnreal >= 0 ? "gain" : "loss"} />
      </div>

      {/* AI snapshot — the whole portfolio as one Markdown document for LLM prompts */}
      {aiSnapshot && (
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={copySnapshot}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 h-9 rounded-lg border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--panel2)]"
            title="Copy a Markdown snapshot of the whole portfolio — every holding with values, weights, allocation, concentration, returns and data-quality caveats — written to be pasted into an AI chat for analysis or allocation discussion. Contains no account numbers or credentials.">
            Copy AI snapshot
          </button>
          <button onClick={downloadSnapshot}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 h-9 rounded-lg border border-[var(--border)] text-[var(--fg)] hover:bg-[var(--panel2)]"
            title="Download the same snapshot as a .md file for attaching to a prompt">
            ↓ .md
          </button>
          {snapMsg && <span role="status" className="text-xs text-[var(--muted)]">{snapMsg}</span>}
        </div>
      )}

      <LivePricesPanel tickers={tickers} />

      <ExposureEditor tickers={tickers} secMeta={secMeta} setSecMeta={setSecMeta} />

      {/* allocation & exposure — moved here from the Net worth ▸ Balance sheet
          tab: "how am I invested" (concentration, region/sector mix, fund
          overlap) is a portfolio question. Driven by the same priced market
          value as the table above; the region/sector bars read the factsheet
          tables pasted in the editor directly above. */}
      {model && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-4">
          <div className="text-sm font-medium flex items-center gap-2"><PieChart size={15} className="text-[var(--accent)]" /> Allocation &amp; exposure <span className="text-xs font-normal text-[var(--muted)]">— by priced market value; unpriced holdings excluded</span></div>

          {/* concentration (core/exposure.mjs — includes RSU-held employer shares) */}
          {concentration && concentration.total > 0 && (
            <div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Stat label="Top holding" value={`${pct(concentration.top1.weight)}`} sub={concentration.top1.ticker} />
                <Stat label="Top 5 holdings" value={pct(concentration.top5Weight)} sub={`of ${gbp0(concentration.total)} priced (incl. RSU shares)`} />
                <Stat label="Effective holdings" value={num(concentration.effectiveN, 1)}
                  sub="1 ÷ HHI — what the weights behave like" />
              </div>
              {concentration.alerts.length > 0 && (
                <p className="text-xs mt-2 text-[var(--m-bb)]">
                  <AlertTriangle size={12} className="inline mr-1 -mt-0.5" aria-hidden="true" />
                  Single-company risk: {concentration.alerts.map((a) => `${a.ticker} is ${pct(a.weight)} (${gbp0(a.value)})`).join(", ")} — diversified funds are exempt from this flag; one company isn't.
                </p>
              )}
            </div>
          )}

          <AllocBar title="By wrapper" buckets={model.allocation.wrapper} />
          <AllocBar title="By asset class" buckets={model.allocation.assetClass} labelOf={(k) => KIND_LABEL[k] || k} />
          <AllocBar title="By native currency" buckets={model.allocation.currency} />
          <AllocBar title="By fund domicile" buckets={model.allocation.geography} labelOf={(k) => (k === "unknown" ? "Unset" : k)} />
          {regionExposure.total > 0 && regionExposure.coverage.untaggedPct < 1 && (
            <AllocBar title="By region (look-through)" buckets={regionExposure.buckets} labelOf={(k) => (k === "untagged" ? "Untagged" : k)} />
          )}
          {sectorExposure.total > 0 && sectorExposure.coverage.untaggedPct < 1 && (
            <AllocBar title="By sector (look-through)" buckets={sectorExposure.buckets} labelOf={(k) => (k === "untagged" ? "Untagged" : k)} />
          )}

          {/* region-mix similarity — a PROXY for fund overlap, said plainly */}
          {similarity.length > 0 && (
            <div>
              <div className="text-xs font-medium mb-1">Fund mix similarity (region)</div>
              <div className="flex flex-wrap gap-2">
                {similarity.slice(0, 6).map((p) => (
                  <span key={p.a + p.b}
                    className={"text-xs px-2 py-1 rounded border num " + (p.similarity >= 0.8 ? "border-[var(--m-bb)] text-[var(--m-bb)]" : "border-[var(--border)] text-[var(--muted)]")}
                    title={p.similarity >= 0.8 ? "These two funds hold a near-identical region mix — check you're not paying two OCFs for one exposure." : "Region-mix overlap between these two funds."}>
                    {p.a} ↔ {p.b}: {pct(p.similarity)}
                  </span>
                ))}
              </div>
              <p className="text-xs text-[var(--muted)] mt-1">Similarity of region MIX from pasted factsheet tables — a proxy, not constituent overlap (two funds can hold the same countries via different stocks).</p>
            </div>
          )}

          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Currency is each line's native trading currency (a proxy for listing, not look-through exposure — a USD-quoted S&amp;P 500 ETF and a GBP-quoted one hold the same underlying). Domicile comes from the ISIN registry (IE = Irish-domiciled fund, GB = UK).
            {" "}Region/sector bars blend the factsheet tables pasted above over your single tags over untagged:
            {" "}{pct(regionExposure.coverage.lookthroughPct)} of value has factsheet-grade exposure, {pct(regionExposure.coverage.taggedPct)} rides a hand tag, {pct(regionExposure.coverage.untaggedPct)} is untagged.
            {" "}Constituent-level look-through (real holdings files) remains a future feature — these are the issuers' own published breakdowns.
          </p>
        </div>
      )}

      {/* Past VIRTUALIZE_THRESHOLD rows this becomes a capped-height scroll
          region with a sticky header and only the visible rows (plus
          overscan) actually in the DOM — see ui/shared.jsx's useVirtualRows. */}
      <div ref={virtualHoldings ? holdingsScrollRef : undefined} className="rounded-xl border border-[var(--border)] overflow-x-auto" style={virtualHoldings ? { maxHeight: "70vh", overflowY: "auto" } : undefined}>
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>
              <SortTh id="wrapper" label="Wrapper" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="tk" label="Ticker" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <th className="px-3 py-2 font-medium text-left sticky top-0 z-10 bg-[var(--panel2)]">ISIN</th>
              <th className="px-3 py-2 font-medium text-left sticky top-0 z-10 bg-[var(--panel2)]" title="Where the holding's underlying exposure actually is — your judgement, powers the Wealth tab's region bar">Region</th>
              <th className="px-3 py-2 font-medium text-left sticky top-0 z-10 bg-[var(--panel2)]" title="Sector of the underlying exposure — 'Diversified' is the honest tag for a broad fund">Sector</th>
              <SortTh id="qty" label="Quantity" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="avg" label="Avg cost" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="cost" label="Pool cost" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="price" label="Price now" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="value" label="Market value" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="unreal" label="Unrealised" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="pct" label="%" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {holdingsTopPad > 0 && <tr aria-hidden="true"><td colSpan={12} style={{ height: holdingsTopPad, padding: 0, border: 0 }} /></tr>}
            {visibleRows.map((r) => (
              <tr key={r.wrapper + r.tk} className="hover:bg-[var(--panel2)]">
                <td className="px-3 py-2"><WrapperChip wrapper={r.wrapper} /></td>
                <td className="px-3 py-2 font-medium">
                  {r.tk}
                  {r.sec.eri === true && <span title="Offshore reporting fund — generates excess reportable income (ERI) while held unsheltered" className="ml-1.5 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--m-bb)_18%,transparent)] text-[var(--m-bb)] align-middle">ERI</span>}
                </td>
                <td className="px-3 py-2">
                  <input value={r.sec.isin || ""} onChange={(e) => setISIN(r.tk, e.target.value)} placeholder="IE00…" className="input font-mono text-xs w-36 py-1" />
                </td>
                <td className="px-3 py-2">
                  <input list="holdings-region-tags" value={r.sec.region || ""} onChange={(e) => setTag(r.tk, "region", e.target.value)} placeholder="—" className="input text-xs w-24 py-1" aria-label={`Region tag for ${r.tk}`} />
                </td>
                <td className="px-3 py-2">
                  <input list="holdings-sector-tags" value={r.sec.sector || ""} onChange={(e) => setTag(r.tk, "sector", e.target.value)} placeholder="—" className="input text-xs w-24 py-1" aria-label={`Sector tag for ${r.tk}`} />
                </td>
                <td className="px-3 py-2 num text-right">{num(r.qty, r.qty % 1 ? 2 : 0)}</td>
                <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(r.avg)}</td>
                <td className="px-3 py-2 num text-right">{gbp(r.cost)}</td>
                <td className="px-3 py-2 text-right">
                  <input type="number" value={r.price} placeholder="—"
                    onChange={(e) => setPrices((p) => ({ ...p, [r.tk]: e.target.value === "" ? undefined : +e.target.value }))}
                    className="input num w-24 text-right py-1" />
                </td>
                <td className="px-3 py-2 num text-right">{r.value != null ? gbp(r.value) : "—"}</td>
                <td className={"px-3 py-2 num text-right font-medium " + (r.unreal == null ? "text-[var(--muted)]" : r.unreal >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.unreal != null ? gbp(r.unreal) : "—"}</td>
                <td className={"px-3 py-2 num text-right " + (r.pct == null ? "text-[var(--muted)]" : r.pct >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.pct != null ? `${r.pct >= 0 ? "+" : ""}${num(r.pct)}%` : "—"}</td>
              </tr>
            ))}
            {holdingsBottomPad > 0 && <tr aria-hidden="true"><td colSpan={12} style={{ height: holdingsBottomPad, padding: 0, border: 0 }} /></tr>}
          </tbody>
        </table>
      </div>
      {virtualHoldings && (
        <p className="text-xs text-[var(--muted)]">
          Showing {visibleRows.length} of {rows.length} positions in view — scroll for more (rendering all {rows.length} at once past {VIRTUALIZE_THRESHOLD} rows gets sluggish, so only the visible window is in the page).
        </p>
      )}
      <p className="text-xs text-[var(--muted)]">
        All holdings across every wrapper (GIA, ISA, SIPP, LISA, VCT). The same price per share applies to a ticker wherever it's held. Prices save locally on your device.
        Unrealised gain = current value − Section 104 pool cost; it's an indicator, not a taxable event. Only <span className="font-semibold">GIA</span> holdings are subject to CGT — ISA/SIPP/LISA/VCT are sheltered.
        {missingIsin > 0 && ` ISIN is set for ${rows.length - missingIsin}/${rows.length} rows — it's the join key for matching issuer ERI reports, so fill in the rest when you get the chance.`}
        {" "}The <span className="text-[var(--m-bb)] font-semibold">ERI</span> badge flags offshore reporting funds.
        {" "}Region/Sector are YOUR look-through tags (a ticker's tags apply wherever it's held) — they feed the Wealth tab's exposure bars, so a world ETF tagged "Global" stops reporting as Irish. Tag a broad fund's sector "Diversified".
      </p>
      <datalist id="holdings-region-tags">
        {["Global", "UK", "US", "Europe ex-UK", "Japan", "Asia ex-Japan", "Emerging markets", "Global ex-US"].map((v) => <option key={v} value={v} />)}
      </datalist>
      <datalist id="holdings-sector-tags">
        {["Diversified", "Technology", "Financials", "Healthcare", "Energy", "Consumer", "Industrials", "Utilities", "Materials", "Telecoms", "Property", "Government bonds"].map((v) => <option key={v} value={v} />)}
      </datalist>
    </div>
  );
}

/* --------------------------- Planning tab --------------------------- */
// Shared scope banner for the three CGT-specific tools (Planning, Report,
// What-if). These are deliberately GIA-only: they compute UK Capital Gains
// Tax, which only applies to unsheltered holdings. ISA/SIPP/LISA/VCT are
// exempt, so including them here would be misleading, not helpful.

export default HoldingsTab;
