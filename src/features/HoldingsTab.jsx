import React, { useState, useMemo } from "react";
import { AlertTriangle, PieChart, Wrench } from "lucide-react";
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
function HoldingsTab({ positions, model = null, concentration = null, aiSnapshot = null, onOpenHolding }) {
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
  const [sort, toggleSort] = useSort("value", "desc");
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
    weight: (r) => r.value,   // weight sorts as value: same order, no divide-by-total needed
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
  // Weight = share of PRICED market value. The most basic field a holdings
  // table has, and it was missing while three set-once inputs had columns.
  const weightOf = (r) => (r.value != null && totValue > 0 ? r.value / totValue : null);
  const maxWeight = Math.max(0, ...rows.map((r) => weightOf(r) || 0));
  const totUnreal = totValue - totCost;
  const missingIsin = rows.filter((r) => !r.sec.isin).length;
  const tickers = [...new Set(rows.map((r) => r.tk))];
  // Taxable vs sheltered split of pool cost, so the all-wrapper view still
  // makes the CGT-relevant portion obvious at a glance.
  const taxableCost = rows.filter((r) => !r.sheltered).reduce((s, r) => s + r.cost, 0);
  const shelteredCost = rows.filter((r) => r.sheltered).reduce((s, r) => s + r.cost, 0);

  const TickerCell = ({ r }) => (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        {onOpenHolding
          ? <button onClick={() => onOpenHolding(r.tk)} className="font-medium hover:text-[var(--accent)] hover:underline underline-offset-2" title={`Everything about ${r.tk}`}>{r.tk}</button>
          : <span className="font-medium">{r.tk}</span>}
        {r.sec.eri === true && <span title="Offshore reporting fund — generates excess reportable income (ERI) while held unsheltered" className="text-[10px] font-semibold px-1 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--m-bb)_18%,transparent)] text-[var(--m-bb)]">ERI</span>}
      </div>
      {r.sec.name && <div className="text-[11px] text-[var(--muted)] truncate max-w-[14rem] leading-tight" title={r.sec.name}>{r.sec.name}</div>}
    </div>
  );
  const WeightCell = ({ r }) => {
    const w = weightOf(r);
    if (w == null) return <span className="text-[var(--muted)]">—</span>;
    return (
      <div className="flex items-center justify-end gap-2" title={`${pct(w)} of priced market value`}>
        <div className="h-1.5 w-16 rounded bg-[var(--panel2)] overflow-hidden" aria-hidden="true">
          <div className="h-full bg-[var(--accent)]" style={{ width: `${maxWeight > 0 ? (w / maxWeight) * 100 : 0}%` }} />
        </div>
        <span className="num w-12 text-right">{pct(w)}</span>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Open pool cost" value={gbp0(rows.reduce((s, r) => s + r.cost, 0))} sub={`taxable ${gbp0(taxableCost)} · sheltered ${gbp0(shelteredCost)}`} />
        <Stat label="Market value (priced)" value={priced.length ? gbp0(totValue) : "—"} sub={priced.length < rows.length ? `${priced.length}/${rows.length} priced` : "all priced"} />
        <Stat label="Unrealised gain" value={priced.length ? gbp0(totUnreal) : "—"} tone={totUnreal >= 0 ? "gain" : "loss"} big />
        <Stat label="Unrealised %" value={priced.length && totCost ? `${totUnreal >= 0 ? "+" : ""}${num((totUnreal / totCost) * 100)}%` : "—"} tone={totUnreal >= 0 ? "gain" : "loss"} />
      </div>

      {/* THE TABLE — first, because it's what the tab is named for. It used
          to sit below four utility panels, starting under the fold. ISIN and
          the region/sector tags moved into the holding drawer (click a
          ticker): set-once fields don't belong on every row of a daily view.
          Past VIRTUALIZE_THRESHOLD rows this becomes a capped-height scroll
          region — see ui/shared.jsx's useVirtualRows. */}
      <div ref={virtualHoldings ? holdingsScrollRef : undefined} className="hidden sm:block rounded-xl border border-[var(--border)] overflow-x-auto" style={virtualHoldings ? { maxHeight: "70vh", overflowY: "auto" } : undefined}>
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>
              <SortTh id="tk" label="Holding" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="wrapper" label="Wrapper" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="qty" label="Quantity" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="avg" label="Avg cost" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)] hidden lg:table-cell" />
              <SortTh id="cost" label="Pool cost" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="price" label="Price now" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="value" label="Market value" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="weight" label="Weight" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="unreal" label="Unrealised" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="pct" label="%" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {holdingsTopPad > 0 && <tr aria-hidden="true"><td colSpan={10} style={{ height: holdingsTopPad, padding: 0, border: 0 }} /></tr>}
            {visibleRows.map((r) => (
              <tr key={r.wrapper + r.tk} className="hover:bg-[var(--panel2)]">
                <td className="px-3 py-2"><TickerCell r={r} /></td>
                <td className="px-3 py-2"><WrapperChip wrapper={r.wrapper} /></td>
                <td className="px-3 py-2 num text-right">{num(r.qty, r.qty % 1 ? 2 : 0)}</td>
                <td className="px-3 py-2 num text-right text-[var(--muted)] hidden lg:table-cell">{gbp(r.avg)}</td>
                <td className="px-3 py-2 num text-right">{gbp(r.cost)}</td>
                <td className="px-3 py-2 text-right">
                  <input type="number" value={r.price} placeholder="—"
                    onChange={(e) => setPrices((p) => ({ ...p, [r.tk]: e.target.value === "" ? undefined : +e.target.value }))}
                    className="input num w-24 text-right py-1" aria-label={`Price for ${r.tk}`} />
                </td>
                <td className="px-3 py-2 num text-right">{r.value != null ? gbp(r.value) : "—"}</td>
                <td className="px-3 py-2"><WeightCell r={r} /></td>
                <td className={"px-3 py-2 num text-right font-medium " + (r.unreal == null ? "text-[var(--muted)]" : r.unreal >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.unreal != null ? gbp(r.unreal) : "—"}</td>
                <td className={"px-3 py-2 num text-right " + (r.pct == null ? "text-[var(--muted)]" : r.pct >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.pct != null ? `${r.pct >= 0 ? "+" : ""}${num(r.pct)}%` : "—"}</td>
              </tr>
            ))}
            {holdingsBottomPad > 0 && <tr aria-hidden="true"><td colSpan={10} style={{ height: holdingsBottomPad, padding: 0, border: 0 }} /></tr>}
          </tbody>
        </table>
      </div>

      {/* Phone: one card per holding instead of a ten-column sideways scroll. */}
      <div className="sm:hidden space-y-2">
        {rows.map((r) => (
          <div key={r.wrapper + r.tk} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2.5">
            <div className="flex items-start justify-between gap-2">
              <TickerCell r={r} />
              <WrapperChip wrapper={r.wrapper} />
            </div>
            <div className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
              <div><div className="text-[var(--muted)]">Qty</div><div className="num">{num(r.qty, r.qty % 1 ? 2 : 0)}</div></div>
              <div><div className="text-[var(--muted)]">Value</div><div className="num">{r.value != null ? gbp0(r.value) : "unpriced"}</div></div>
              <div><div className="text-[var(--muted)]">Weight</div><div className="num">{weightOf(r) != null ? pct(weightOf(r)) : "—"}</div></div>
              <div><div className="text-[var(--muted)]">Cost</div><div className="num">{gbp0(r.cost)}</div></div>
              <div className="col-span-2"><div className="text-[var(--muted)]">Unrealised</div>
                <div className={"num font-medium " + (r.unreal == null ? "text-[var(--muted)]" : r.unreal >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>
                  {r.unreal != null ? `${gbp0(r.unreal)} (${r.pct >= 0 ? "+" : ""}${num(r.pct, 1)}%)` : "—"}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      {virtualHoldings && (
        <p className="text-xs text-[var(--muted)]">
          Showing {visibleRows.length} of {rows.length} positions in view — scroll for more (rendering all {rows.length} at once past {VIRTUALIZE_THRESHOLD} rows gets sluggish, so only the visible window is in the page).
        </p>
      )}
      <p className="text-xs text-[var(--muted)]">
        All holdings across every wrapper (GIA, ISA, SIPP, LISA, VCT). The same price per share applies to a ticker wherever it&apos;s held; prices save locally. Click a ticker for its trades, income, pool, ISIN and tags.
        Unrealised gain = current value − Section 104 pool cost; it&apos;s an indicator, not a taxable event. Only <span className="font-semibold">GIA</span> holdings are subject to CGT — ISA/SIPP/LISA/VCT are sheltered.
        {missingIsin > 0 && ` ISIN is set for ${rows.length - missingIsin}/${rows.length} holdings — it's the join key for issuer ERI reports and broker imports; fill the rest in from each holding's drawer.`}
      </p>

      <LivePricesPanel tickers={tickers} />

      {/* allocation & exposure — moved here from the Net worth ▸ Balance sheet
          tab: "how am I invested" (concentration, region/sector mix, fund
          overlap) is a portfolio question. Driven by the same priced market
          value as the table above; the region/sector bars read the factsheet
          tables pasted in the Tools section below. */}
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
                  Single-company risk: {concentration.alerts.map((a) => `${a.ticker} is ${pct(a.weight)} (${gbp0(a.value)})`).join(", ")} — diversified funds are exempt from this flag; one company isn&apos;t.
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
            Currency is each line&apos;s native trading currency (a proxy for listing, not look-through exposure — a USD-quoted S&amp;P 500 ETF and a GBP-quoted one hold the same underlying). Domicile comes from the ISIN registry (IE = Irish-domiciled fund, GB = UK).
            {" "}Region/sector bars blend pasted factsheet tables over each holding&apos;s tags over untagged:
            {" "}{pct(regionExposure.coverage.lookthroughPct)} of value has factsheet-grade exposure, {pct(regionExposure.coverage.taggedPct)} rides a hand tag, {pct(regionExposure.coverage.untaggedPct)} is untagged.
          </p>
        </div>
      )}

      {/* Tools — the setup and export utilities that used to sit ABOVE the
          table. Collapsed by default: none of them is a daily action. */}
      <details className="rounded-xl border border-[var(--border)] bg-[var(--panel)] group">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium flex items-center gap-2 list-none">
          <Wrench size={15} className="text-[var(--accent)]" /> Tools
          <span className="text-xs font-normal text-[var(--muted)]">— AI snapshot export, factsheet exposure tables</span>
          <span className="ml-auto text-xs text-[var(--muted)] group-open:hidden">show</span><span className="ml-auto text-xs text-[var(--muted)] hidden group-open:inline">hide</span>
        </summary>
        <div className="px-4 pb-4 space-y-3 border-t border-[var(--border)] pt-3">
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
          <ExposureEditor tickers={tickers} secMeta={secMeta} setSecMeta={setSecMeta} />
        </div>
      </details>
    </div>
  );
}

/* --------------------------- Planning tab --------------------------- */
// Shared scope banner for the three CGT-specific tools (Planning, Report,
// What-if). These are deliberately GIA-only: they compute UK Capital Gains
// Tax, which only applies to unsheltered holdings. ISA/SIPP/LISA/VCT are
// exempt, so including them here would be misleading, not helpful.

export default HoldingsTab;
