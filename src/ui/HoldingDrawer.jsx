/* ======================================================================
   HOLDING DRAWER — everything about one ticker, in one place.

   Before this, "tell me about TG36" meant six screens: quantity and value
   on Holdings, trades on Transactions, coupons on Income, schedule and
   yield on Gilts, the S104 pool on Tax, its contribution on Returns. The
   ⌘K palette listed tickers but a hit only opened the Holdings tab, not
   even scrolled to the row. This is the slide-over those six screens were
   missing, opened from any ticker anywhere (Holdings, Transactions, Gilts,
   the palette) and hosted once, in the shell, so every tab shares it.

   It also becomes the home for the set-once metadata — name, ISIN,
   region/sector tags — that used to occupy three columns of the Holdings
   table on every row.

   Data: raw state via store selectors; derived data (positions, S104
   pools, gilt cashflows) via props from the shell, per the app's
   "props carry DERIVED data, store carries RAW state" rule.
   ====================================================================== */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { X, ExternalLink } from "lucide-react";
import useAppStore from "../state/appStore.js";
import { gbp, gbp0, num, pct, WrapperChip, KIND_LABEL, store, todayISO } from "./shared.jsx";
import { classifyInstrument } from "../core/portfolio.mjs";

const REGION_TAGS = ["Global", "UK", "US", "Europe ex-UK", "Japan", "Asia ex-Japan", "Emerging markets", "Global ex-US"];
const SECTOR_TAGS = ["Diversified", "Technology", "Financials", "Healthcare", "Energy", "Consumer", "Industrials", "Utilities", "Materials", "Telecoms", "Property", "Government bonds"];

function Section({ title, right, children }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

const Line = ({ label, value, tone }) => (
  <div className="flex items-baseline justify-between text-sm gap-3">
    <span className="text-[var(--muted)]">{label}</span>
    <span className={"num font-medium " + (tone === "gain" ? "text-[var(--gain)]" : tone === "loss" ? "text-[var(--loss)]" : "")}>{value}</span>
  </div>
);

export default function HoldingDrawer({ ticker, onClose, positions = [], pools = {}, giltCashflows = [], setTab }) {
  const secMeta = useAppStore((s) => s.secMeta), setSecMeta = useAppStore((s) => s.setSecMeta);
  const prices = useAppStore((s) => s.prices), setPrices = useAppStore((s) => s.setPrices);
  const priceMeta = useAppStore((s) => s.priceMeta);
  const txns = useAppStore((s) => s.txns);
  const incomeEntries = useAppStore((s) => s.incomeEntries);
  const panelRef = useRef(null);
  const [showAllTrades, setShowAllTrades] = useState(false);

  // Escape closes; focus lands in the panel on open and the page behind is
  // inert to scrolling while it's up.
  useEffect(() => {
    if (!ticker) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setTimeout(() => panelRef.current?.focus(), 0);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [ticker, onClose]);

  const tk = ticker ? String(ticker).toUpperCase() : null;
  const meta = (tk && secMeta[tk]) || {};
  const cls = useMemo(() => (tk ? classifyInstrument(tk, secMeta) : null), [tk, secMeta]);

  const myTxns = useMemo(() => txns.filter((t) => String(t.ticker || "").toUpperCase() === tk).sort((a, b) => (a.date < b.date ? 1 : -1)), [txns, tk]);
  const myPositions = useMemo(() => positions.filter((p) => String(p.ticker || "").toUpperCase() === tk && p.qty > 1e-9), [positions, tk]);
  const myIncome = useMemo(() => incomeEntries.filter((e) => String(e.ticker || "").toUpperCase() === tk).sort((a, b) => (a.date < b.date ? 1 : -1)), [incomeEntries, tk]);
  const myFlows = useMemo(() => giltCashflows.filter((f) => String(f.ticker || "").toUpperCase() === tk && f.date >= todayISO()).slice(0, 6), [giltCashflows, tk]);
  const pool = tk ? pools[tk] : null;

  if (!tk) return null;

  const price = prices[tk];
  const priced = Number.isFinite(+price);
  const pm = priceMeta[tk];
  const totalQty = myPositions.reduce((s, p) => s + p.qty, 0);
  const totalCost = myPositions.reduce((s, p) => s + (p.bookCost || 0), 0);
  const totalValue = priced ? totalQty * +price : null;
  const unreal = totalValue != null ? totalValue - totalCost : null;
  const incomeTotal = myIncome.reduce((s, e) => s + (+e.amount || 0), 0);
  const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const income12m = myIncome.filter((e) => e.date >= cutoff).reduce((s, e) => s + (+e.amount || 0), 0);
  const incomeByYear = myIncome.reduce((m, e) => { const y = String(e.date || "").slice(0, 4); m[y] = (m[y] || 0) + (+e.amount || 0); return m; }, {});
  const trades = showAllTrades ? myTxns : myTxns.slice(0, 8);
  const isGilt = cls?.kind === "gilt";
  const isFund = meta.kind === "fund";

  const setMeta = (patch) => setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], ...patch } }));
  const goLedger = () => { store.set("cgt.ledger.search", tk); setTab && setTab("ledger"); onClose(); };
  const goTab = (leaf) => { setTab && setTab(leaf); onClose(); };

  return (
    <div className="fixed inset-0 z-[60]" role="presentation">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden="true" />
      <aside ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${tk} — holding details`}
        className="absolute inset-y-0 right-0 w-full sm:w-[30rem] max-w-full bg-[var(--panel)] border-l border-[var(--border)] shadow-2xl overflow-y-auto outline-none">
        <div className="sticky top-0 z-10 bg-[var(--panel)] border-b border-[var(--border)] px-4 py-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-lg font-semibold">{tk}</span>
              {cls?.kind && <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-[var(--chip)] text-[var(--muted)]">{KIND_LABEL[cls.kind] || cls.kind}</span>}
              {cls?.cgtExempt && <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--gain)_18%,transparent)] text-[var(--gain)]" title="TCGA 1992 s115">CGT-exempt</span>}
              {meta.eri === true && <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--m-bb)_18%,transparent)] text-[var(--m-bb)]" title="Offshore reporting fund — excess reportable income while held unsheltered">ERI</span>}
              {[...new Set(myPositions.map((p) => p.wrapper))].map((w) => <WrapperChip key={w} wrapper={w} />)}
            </div>
            <input value={meta.name || ""} onChange={(e) => setMeta({ name: e.target.value })}
              placeholder="Name — arrives with the next price refresh, or type it"
              className="mt-1 w-full bg-transparent text-sm text-[var(--muted)] focus:text-[var(--fg)] outline-none border-b border-transparent focus:border-[var(--border)]"
              aria-label="Security name" />
          </div>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--fg)] shrink-0" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="px-4 py-4 space-y-5">
          {/* position */}
          <Section title="Position" right={myPositions.length === 0 && <span className="text-xs text-[var(--muted)]">not currently held</span>}>
            {myPositions.map((p) => (
              <div key={p.wrapper} className="rounded-lg border border-[var(--border)] px-3 py-2 space-y-0.5">
                <div className="flex items-center justify-between"><WrapperChip wrapper={p.wrapper} /><span className="num text-sm">{num(p.qty, p.qty % 1 ? 4 : 0)} {isGilt ? "nominal" : "units"}</span></div>
                <Line label="Book cost" value={gbp(p.bookCost || 0)} />
                <Line label="Avg cost / unit" value={p.qty ? gbp((p.bookCost || 0) / p.qty) : "—"} />
                {priced && <Line label="Market value" value={gbp(p.qty * +price)} />}
                {priced && <Line label="Unrealised" value={`${gbp(p.qty * +price - (p.bookCost || 0))}${p.bookCost ? ` (${((p.qty * +price - p.bookCost) / p.bookCost >= 0 ? "+" : "")}${num(((p.qty * +price - p.bookCost) / p.bookCost) * 100, 1)}%)` : ""}`} tone={p.qty * +price - (p.bookCost || 0) >= 0 ? "gain" : "loss"} />}
              </div>
            ))}
            {myPositions.length > 1 && (
              <div className="px-3 pt-1 space-y-0.5">
                <Line label="Total" value={`${num(totalQty, totalQty % 1 ? 4 : 0)} · ${totalValue != null ? gbp(totalValue) : "unpriced"}`} />
                {unreal != null && <Line label="Total unrealised" value={gbp(unreal)} tone={unreal >= 0 ? "gain" : "loss"} />}
              </div>
            )}
          </Section>

          {/* price */}
          <Section title="Price" right={pm?.asOf && <span className="text-xs text-[var(--muted)]" title={pm.asOf}>{pm.source || "manual"} · {String(pm.asOf).slice(0, 10)}</span>}>
            <div className="flex items-center gap-2">
              <input type="number" step="0.0001" value={priced ? +(+price).toFixed(4) : ""} placeholder="—"
                onChange={(e) => setPrices((p) => ({ ...p, [tk]: e.target.value === "" ? undefined : +e.target.value }))}
                className="input num w-32 text-right" aria-label={`Price for ${tk}, GBP per unit`} />
              <span className="text-xs text-[var(--muted)]">GBP per {isGilt ? "£1 nominal" : "unit"}{isFund ? " — pension fund units are manual or L&G" : ""}</span>
            </div>
            {isGilt && meta.indexLinked && <p className="text-xs text-[var(--muted)]">Index-linked: stored uplifted by the index ratio ({num(+meta.indexRatio || 1, 4)}). The Gilts tab shows the real quote.</p>}
          </Section>

          {/* CGT pool */}
          {(pool || cls?.cgtExempt) && (
            <Section title="Section 104 pool (GIA)" right={<button onClick={() => goTab("cgt")} className="text-xs text-[var(--accent)] hover:underline">Tax →</button>}>
              {cls?.cgtExempt ? (
                <p className="text-xs text-[var(--muted)]">Individual gilts are exempt from CGT (TCGA 1992 s115){meta.indexLinked ? ", including the whole inflation uplift" : ""} — coupons are taxable as interest in a GIA, gains are not.</p>
              ) : pool && pool.qty > 1e-9 ? (
                <div className="px-1 space-y-0.5">
                  <Line label="Pooled units" value={num(pool.qty, pool.qty % 1 ? 4 : 0)} />
                  <Line label="Pool cost" value={gbp(pool.cost)} />
                  <Line label="Pool cost / unit" value={gbp(pool.cost / pool.qty)} />
                  {priced && <Line label="Gain if sold today" value={gbp(pool.qty * +price - pool.cost)} tone={pool.qty * +price - pool.cost >= 0 ? "gain" : "loss"} />}
                </div>
              ) : <p className="text-xs text-[var(--muted)]">No taxable pool — not held in a GIA.</p>}
            </Section>
          )}

          {/* income */}
          <Section title="Income received" right={<button onClick={() => goTab("income")} className="text-xs text-[var(--accent)] hover:underline">Income →</button>}>
            {myIncome.length ? (
              <div className="px-1 space-y-0.5">
                <Line label="Last 12 months" value={gbp(income12m)} />
                <Line label={`All time (${myIncome.length} payment${myIncome.length === 1 ? "" : "s"})`} value={gbp(incomeTotal)} />
                {priced && totalValue > 0 && income12m > 0 && <Line label="Trailing yield on value" value={pct(income12m / totalValue)} />}
                {totalCost > 0 && income12m > 0 && <Line label="Trailing yield on cost" value={pct(income12m / totalCost)} />}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {Object.entries(incomeByYear).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 6).map(([y, v]) => (
                    <span key={y} className="text-[11px] num px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--muted)]">{y} {gbp0(v)}</span>
                  ))}
                </div>
              </div>
            ) : <p className="text-xs text-[var(--muted)]">Nothing recorded for this ticker.</p>}
          </Section>

          {/* gilt schedule */}
          {isGilt && myFlows.length > 0 && (
            <Section title="Upcoming cashflows" right={<button onClick={() => goTab("gilts")} className="text-xs text-[var(--accent)] hover:underline">Gilts →</button>}>
              <div className="px-1">
                {myFlows.map((f, i) => (
                  <div key={i} className="flex items-baseline justify-between text-sm">
                    <span className="num text-[var(--muted)]">{f.date}</span>
                    <span className="text-xs text-[var(--muted)]">{f.type}</span>
                    <span className="num">{gbp(f.amount)}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* trades */}
          <Section title={`Trades (${myTxns.length})`} right={<button onClick={goLedger} className="text-xs text-[var(--accent)] hover:underline inline-flex items-center gap-1">Transactions <ExternalLink size={11} /></button>}>
            {isFund ? (
              <p className="text-xs text-[var(--muted)]">Pension/LISA fund units are a snapshot set on the Pension &amp; LISA tab, not a trade history.</p>
            ) : myTxns.length ? (
              <div className="rounded-lg border border-[var(--border)] overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--panel2)] text-[var(--muted)] uppercase tracking-wide text-[10px]">
                    <tr><th className="text-left px-2 py-1 font-medium">Date</th><th className="text-left px-2 py-1 font-medium">Side</th><th className="text-right px-2 py-1 font-medium">Qty</th><th className="text-right px-2 py-1 font-medium">£/unit</th><th className="text-right px-2 py-1 font-medium">GBP</th><th className="text-left px-2 py-1 font-medium">Where</th></tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {trades.map((t) => (
                      <tr key={t.id} title={t.note || ""}>
                        <td className="px-2 py-1 num">{t.date}</td>
                        <td className={"px-2 py-1 font-semibold " + (t.side === "BUY" ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{t.side}</td>
                        <td className="px-2 py-1 num text-right">{num(+t.quantity || 0, (+t.quantity || 0) % 1 ? 4 : 0)}</td>
                        <td className="px-2 py-1 num text-right text-[var(--muted)]">{+t.quantity ? gbp((+t.gbpAmount || 0) / +t.quantity) : "—"}</td>
                        <td className="px-2 py-1 num text-right">{gbp(+t.gbpAmount || 0)}</td>
                        <td className="px-2 py-1 whitespace-nowrap"><WrapperChip wrapper={t.wrapper || "GIA"} />{t.account && <span className="ml-1 text-[10px] text-[var(--muted)]">{t.account}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {myTxns.length > 8 && (
                  <button onClick={() => setShowAllTrades((v) => !v)} className="w-full text-xs text-[var(--accent)] hover:underline py-1.5 bg-[var(--panel2)]">
                    {showAllTrades ? "Show fewer" : `Show all ${myTxns.length}`}
                  </button>
                )}
              </div>
            ) : <p className="text-xs text-[var(--muted)]">No transactions under this ticker.</p>}
          </Section>

          {/* identity & tags — set once, lives here rather than on every Holdings row */}
          <Section title="Identity & tags">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-[var(--muted)]">ISIN
                <input value={meta.isin || ""} onChange={(e) => setMeta({ isin: e.target.value.toUpperCase().trim() })} placeholder="IE00…" className="input font-mono text-xs w-full mt-1 py-1" />
              </label>
              <label className="text-xs text-[var(--muted)]">Domicile
                <input value={meta.domicile || ""} onChange={(e) => setMeta({ domicile: e.target.value.toUpperCase().trim().slice(0, 2) })} placeholder="IE / GB / US" className="input font-mono text-xs w-full mt-1 py-1" />
              </label>
              <label className="text-xs text-[var(--muted)]">Region (look-through)
                <input list="drawer-region-tags" value={meta.region || ""} onChange={(e) => setMeta({ region: e.target.value })} placeholder="e.g. Global" className="input text-xs w-full mt-1 py-1" />
              </label>
              <label className="text-xs text-[var(--muted)]">Sector
                <input list="drawer-sector-tags" value={meta.sector || ""} onChange={(e) => setMeta({ sector: e.target.value })} placeholder="e.g. Diversified" className="input text-xs w-full mt-1 py-1" />
              </label>
            </div>
            <datalist id="drawer-region-tags">{REGION_TAGS.map((v) => <option key={v} value={v} />)}</datalist>
            <datalist id="drawer-sector-tags">{SECTOR_TAGS.map((v) => <option key={v} value={v} />)}</datalist>
            <p className="text-[11px] text-[var(--muted)] leading-relaxed">
              ISIN is the join key for issuer ERI reports and broker imports. Region/sector tags feed the exposure bars; paste a factsheet table on Holdings for a fund&apos;s real mix.
              {meta.nameSource && <> Name from {meta.nameSource}.</>}
            </p>
          </Section>
        </div>
      </aside>
    </div>
  );
}
