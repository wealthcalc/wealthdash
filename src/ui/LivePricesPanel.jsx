import React, { useState, useMemo, useCallback, useRef } from "react";
import { RefreshCw, Check } from "lucide-react";
import { gbp, dmoDateToIso, fetchDmoGiltPrices, num, avQuote, fxToGBP, toGBP, avBudget, avBump, Field } from "../ui/shared.jsx";
import { refreshAllPrices } from "./priceRefresh.js";
import useAppStore from "../state/appStore.js";

// Callers pass only `tickers` — everything else (prices, AV key/meta,
// price meta, ledger, security meta, DMO date) is raw persisted state this
// panel now reads from the store itself via per-slice selectors. This
// panel was the single worst prop-drilling offender: three tabs each
// forwarded the same 12 props here verbatim, so any new piece of price
// plumbing meant touching four files. Selector subscriptions also mean a
// price tick re-renders this panel, not the whole tab tree above it.
function LivePricesPanel({ tickers }) {
  const avKey = useAppStore((s) => s.avKey), setAvKey = useAppStore((s) => s.setAvKey);
  const avMeta = useAppStore((s) => s.avMeta), setAvMeta = useAppStore((s) => s.setAvMeta);
  const prices = useAppStore((s) => s.prices), setPrices = useAppStore((s) => s.setPrices);
  const priceMeta = useAppStore((s) => s.priceMeta), setPriceMeta = useAppStore((s) => s.setPriceMeta);
  const txns = useAppStore((s) => s.txns);
  const secMeta = useAppStore((s) => s.secMeta);
  const dmoReportDate = useAppStore((s) => s.dmoReportDate), setDmoReportDate = useAppStore((s) => s.setDmoReportDate);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState("");
  const [msg, setMsg] = useState("");

  // Individual gilts aren't on Yahoo/Alpha Vantage — verified, not assumed
  // (see api/gilt-prices.mjs) — so they're fetched from the DMO instead,
  // wherever they show up in a price list (Wealth tab included, not just Gilts).
  const giltTickers = tickers.filter((tk) => secMeta[tk]?.kind === "gilt");
  // Pension/LISA fund units (kind "fund") are insurer-administered, not
  // exchange-traded — sending them to Yahoo/AV risks a coincidental ticker
  // collision silently overwriting a fund's price with an unrelated stock's,
  // which is exactly the bug that prompted this fix. No live source exists
  // for these (checked; L&G's own ToS blocks scraping) — manual entry only.
  const pensionFundTickers = tickers.filter((tk) => secMeta[tk]?.kind === "fund");
  const otherTickers = tickers.filter((tk) => secMeta[tk]?.kind !== "gilt" && secMeta[tk]?.kind !== "fund");

  const ledgerCcy = useMemo(() => {
    const m = {}; for (const t of txns) if (!m[t.ticker] && t.nativeCurrency) m[t.ticker] = t.nativeCurrency; return m;
  }, [txns]);
  const defYahoo = (tk) => (ledgerCcy[tk] === "GBP" ? `${tk}.L` : tk);   // Yahoo LSE suffix = .L
  const defAv = (tk) => (ledgerCcy[tk] === "GBP" ? `${tk}.LON` : tk);    // Alpha Vantage LSE suffix = .LON
  const defCcy = (tk) => (ledgerCcy[tk] === "USD" ? "USD" : ledgerCcy[tk] === "EUR" ? "EUR" : "GBp");
  const meta = (tk) => ({
    yahoo: avMeta[tk]?.yahoo ?? defYahoo(tk),
    av: avMeta[tk]?.av ?? avMeta[tk]?.symbol ?? defAv(tk),
    currency: avMeta[tk]?.currency ?? defCcy(tk),
  });
  const setMeta = (tk, patch) => setAvMeta((m) => ({ ...m, [tk]: { ...meta(tk), ...patch } }));
  const used = avBudget().n;

  const applyQuote = (tk, raw, ccy, fx, source) => {
    const g = toGBP(raw, ccy, fx);
    if (g == null) { setMsg(`${tk}: couldn't convert ${ccy} to GBP`); return false; }
    setPrices((p) => ({ ...p, [tk]: +g.toFixed(4) }));
    setPriceMeta((p) => ({ ...p, [tk]: { asOf: new Date().toISOString(), raw, ccy, source } }));
    return true;
  };
  const yahooFetch = async (syms) => {
    const r = await fetch(`/api/quotes?symbols=${encodeURIComponent(syms.join(","))}`);
    if (!r.ok) throw new Error(`function ${r.status}`);
    const j = await r.json();
    const by = {}; (j.quotes || []).forEach((q) => { by[q.symbol] = q; });
    return by;
  };

  const fetchOne = async (tk) => {
    setBusy(true); setProg(`Fetching ${tk}...`); setMsg("");
    if (secMeta[tk]?.kind === "gilt") {
      try {
        const { pricesByTicker, matched, date, skipped } = await fetchDmoGiltPrices([{ ticker: tk, isin: secMeta[tk]?.isin }], { knownReportDate: dmoReportDate });
        if (skipped) { setMsg(`${tk}: already have today's DMO report (${dmoReportDate}) — no need to ask again.`); setBusy(false); setProg(""); return; }
        if (matched) {
          setPrices((p) => ({ ...p, [tk]: pricesByTicker[tk] }));
          setPriceMeta((p) => ({ ...p, [tk]: { asOf: new Date().toISOString(), raw: pricesByTicker[tk] * 100, ccy: "GBP", source: "DMO" } }));
          if (setDmoReportDate && date) setDmoReportDate(dmoDateToIso(date));
          setMsg(`${tk}: clean price ${gbp(pricesByTicker[tk] * 100)}/£100 nominal from DMO (${date})`);
        } else setMsg(`${tk}: not in today's DMO report — try again after ~2pm, or enter manually.`);
      } catch (e) { setMsg(`${tk}: ${e.message}`); }
      setBusy(false); setProg(""); return;
    }
    if (secMeta[tk]?.kind === "fund") {
      setMsg(`${tk}: no live source for pension/LISA fund units (insurer-administered, not exchange-traded) — enter manually, on the Pension & LISA tab.`);
      setBusy(false); setProg(""); return;
    }
    const m = meta(tk);
    try {
      const q = (await yahooFetch([m.yahoo]))[m.yahoo];
      if (q && q.price != null) {
        const fx = await fxToGBP(q.currency);
        if (applyQuote(tk, q.price, q.currency, fx, "Yahoo")) { setMsg(`${tk}: ${num(q.price, 2)} ${q.currency} to ${gbp(toGBP(q.price, q.currency, fx))} (Yahoo)`); setBusy(false); setProg(""); return; }
      }
    } catch { /* fall through to AV */ }
    if (avKey && avBudget().n < 25) {
      try {
        const raw = await avQuote(m.av, avKey); avBump();
        const fx = await fxToGBP(m.currency);
        if (applyQuote(tk, raw, m.currency, fx, "AV")) { setMsg(`${tk}: ${num(raw, 2)} ${m.currency} to ${gbp(toGBP(raw, m.currency, fx))} (Alpha Vantage)`); setBusy(false); setProg(""); return; }
      } catch (e) { setMsg(`${tk}: ${e.message}`); setBusy(false); setProg(""); return; }
    }
    setMsg(`${tk}: no live price (deploy the Yahoo function${avKey ? "" : "; no AV key set"}) - enter manually.`);
    setBusy(false); setProg("");
  };

  // Bulk fetch — delegated to the shared engine (ui/priceRefresh.js) so the
  // Home tab's needs-attention rail can trigger the exact same refresh.
  const fetchAll = async () => {
    setBusy(true); setMsg("");
    const res = await refreshAllPrices({
      tickers, txns, secMeta, avMeta, avKey, dmoReportDate,
      setPrices, setPriceMeta, setDmoReportDate, onProgress: setProg,
    });
    setMsg(res.message);
    setBusy(false);
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)]">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-4 py-2.5 text-sm">
        <span className="font-medium flex items-center gap-2"><RefreshCw size={14} className="text-[var(--accent)]" /> Live prices <span className="text-xs font-normal text-[var(--muted)]">- {giltTickers.length ? "DMO for gilts, " : ""}Yahoo then Alpha Vantage then manual{pensionFundTickers.length ? ` (${pensionFundTickers.length} pension fund${pensionFundTickers.length === 1 ? "" : "s"} excluded — no live source)` : ""}</span></span>
        <span className="text-xs text-[var(--muted)]">{open ? "hide" : "set up"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-[var(--border)] pt-3">
          <div className="flex items-end gap-2 flex-wrap">
            <button onClick={fetchAll} disabled={busy} className="btn-accent disabled:opacity-50"><RefreshCw size={15} className={busy ? "animate-spin" : ""} /> Fetch prices</button>
            {(prog || msg) && <span className="text-xs text-[var(--muted)] pb-2">{prog || msg}</span>}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[var(--muted)]">
                <tr>{["Ticker", "Yahoo symbol", "AV symbol", "Ccy (AV)", "", "Last quote", "Source", "As of"].map((h, i) => <th key={i} className="py-1 px-2 font-medium text-left">{h}</th>)}</tr>
              </thead>
              <tbody>
                {tickers.map((tk) => {
                  const isGilt = secMeta[tk]?.kind === "gilt";
                  const isFund = secMeta[tk]?.kind === "fund";
                  const m = meta(tk), pm = priceMeta[tk];
                  return (
                    <tr key={tk} className="border-t border-[var(--border)]">
                      <td className="py-1 px-2 font-medium">{tk}</td>
                      {isGilt ? (
                        <td className="py-1 px-2 text-[var(--muted)]" colSpan={3}>DMO (via ISIN {secMeta[tk]?.isin || "— not set"})</td>
                      ) : isFund ? (
                        <td className="py-1 px-2 text-[var(--muted)]" colSpan={3}>No live source — pension/LISA fund, set manually on the Pension &amp; LISA tab</td>
                      ) : (<>
                        <td className="py-1 px-2"><input value={m.yahoo} onChange={(e) => setMeta(tk, { yahoo: e.target.value.trim() })} className="input num w-24 py-0.5" /></td>
                        <td className="py-1 px-2"><input value={m.av} onChange={(e) => setMeta(tk, { av: e.target.value.trim() })} className="input num w-24 py-0.5" /></td>
                        <td className="py-1 px-2">
                          <select value={m.currency} onChange={(e) => setMeta(tk, { currency: e.target.value })} className="input py-0.5">
                            {["GBp", "GBP", "USD", "EUR"].map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                      </>)}
                      <td className="py-1 px-2"><button onClick={() => fetchOne(tk)} disabled={busy || isFund} className="text-[var(--accent)] disabled:opacity-40" title={isFund ? "No live source for pension funds" : "Fetch this one"}>&#8635;</button></td>
                      <td className="py-1 px-2 num text-[var(--muted)]">{pm ? `${num(pm.raw, 2)} ${pm.ccy}` : "-"}</td>
                      <td className="py-1 px-2">{pm?.source ? <span className="text-[11px] px-1.5 py-0.5 rounded-full" style={{ color: pm.source === "Yahoo" ? "var(--m-pool)" : pm.source === "DMO" ? "var(--gain)" : "var(--m-bb)", background: "var(--chip)" }}>{pm.source}</span> : <span className="text-[var(--muted)]">-</span>}</td>
                      <td className="py-1 px-2 num text-[var(--muted)]">{pm ? new Date(pm.asOf).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <details className="text-xs">
            <summary className="cursor-pointer text-[var(--muted)]">Alpha Vantage fallback key ({used}/25 used today)</summary>
            <div className="mt-2">
              <Field label="Alpha Vantage key - used only if Yahoo fails (saved on this device)">
                <input type="password" value={avKey} onChange={(e) => setAvKey(e.target.value.trim())} placeholder="paste your Alpha Vantage key" className="input num w-64" />
              </Field>
            </div>
          </details>

          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Yahoo is primary - it returns each quote's currency, so GBP normalisation is automatic (pence /100, USD/EUR via ECB rates) with no daily cap. It needs the <span className="font-medium">/api/quotes</span> serverless function deployed (LSE symbols use the <span className="font-medium">.L</span> suffix). If Yahoo is down or misses a symbol, Alpha Vantage fills in silently using the AV symbol (<span className="font-medium">.LON</span>) and the currency you set per line, capped at 25 calls/day. Anything neither can price, you enter by hand. Check "Last quote" against a price you know if a value looks off.
          </p>
        </div>
      )}
    </div>
  );
}

/* --------------------------- Wealth tab ----------------------------- */
// The "see everything" home view (build step 2): total wealth, per-wrapper and
// consolidated holdings, allocation. Pure view — every figure comes from the
// node-tested wealth core (core/portfolio.mjs), not from view-side arithmetic.

export default LivePricesPanel;
export { LivePricesPanel };
