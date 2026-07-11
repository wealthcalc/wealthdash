import React, { useState, useMemo, useCallback, useRef } from "react";
import { isWrapperTaxable } from "../core/portfolio.mjs";
import { parseExposurePaste } from "../core/lookthrough.mjs";
import LivePricesPanel from "../ui/LivePricesPanel.jsx";
import { gbp, gbp0, WrapperChip, num, pct, Stat, Empty, useSort, sortRows, SortTh, todayISO } from "../ui/shared.jsx";
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
// selectors; only DERIVED data (positions, from the shell's wealth model)
// arrives as a prop. Part of the Phase 2.8 de-drilling pass.
function HoldingsTab({ positions }) {
  const prices = useAppStore((s) => s.prices), setPrices = useAppStore((s) => s.setPrices);
  const secMeta = useAppStore((s) => s.secMeta), setSecMeta = useAppStore((s) => s.setSecMeta);
  const open = positions.filter((p) => p.qty > 1e-6);
  const [sort, toggleSort] = useSort("wrapper", "asc");
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

      <LivePricesPanel tickers={tickers} />

      <ExposureEditor tickers={tickers} secMeta={secMeta} setSecMeta={setSecMeta} />

      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>
              <SortTh id="wrapper" label="Wrapper" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium" />
              <SortTh id="tk" label="Ticker" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium" />
              <th className="px-3 py-2 font-medium text-left">ISIN</th>
              <th className="px-3 py-2 font-medium text-left" title="Where the holding's underlying exposure actually is — your judgement, powers the Wealth tab's region bar">Region</th>
              <th className="px-3 py-2 font-medium text-left" title="Sector of the underlying exposure — 'Diversified' is the honest tag for a broad fund">Sector</th>
              <SortTh id="qty" label="Quantity" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="avg" label="Avg cost" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="cost" label="Pool cost" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="price" label="Price now" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="value" label="Market value" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="unreal" label="Unrealised" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="pct" label="%" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {rows.map((r) => (
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
          </tbody>
        </table>
      </div>
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
