/* ======================================================================
   PRICE REFRESH ENGINE — the bulk fetch that used to live inside
   LivePricesPanel, extracted so any surface (Home's needs-attention rail,
   the Wealth/Holdings panels) can trigger the same refresh without
   navigating. Behaviour is unchanged: DMO for gilts (skipping the network
   round-trip when today's report is already held), Yahoo in bulk for
   everything exchange-traded, Alpha Vantage as the rate-limited fallback
   (25/day, 5/min), pension/LISA fund units excluded (no live source —
   a Yahoo ticker collision could silently overwrite them).
   ====================================================================== */
import {
  dmoDateToIso, fetchDmoGiltPrices, avQuote, fxToGBP, toGBP, avBudget, avBump, sleep,
} from "./shared.jsx";

// Yahoo/AV symbols + AV currency for a ticker: explicit avMeta wins, else
// defaults derived from the ledger's native currency (LSE suffixes).
export function tickerMeta(tk, { avMeta = {}, txns = [] } = {}) {
  let ccy = null;
  for (const t of txns) if (t.ticker === tk && t.nativeCurrency) { ccy = t.nativeCurrency; break; }
  return {
    yahoo: avMeta[tk]?.yahoo ?? (ccy === "GBP" ? `${tk}.L` : tk),
    av: avMeta[tk]?.av ?? avMeta[tk]?.symbol ?? (ccy === "GBP" ? `${tk}.LON` : tk),
    currency: avMeta[tk]?.currency ?? (ccy === "USD" ? "USD" : ccy === "EUR" ? "EUR" : "GBp"),
  };
}

async function yahooFetch(syms) {
  const r = await fetch(`/api/quotes?symbols=${encodeURIComponent(syms.join(","))}`);
  if (!r.ok) throw new Error(`function ${r.status}`);
  const j = await r.json();
  const by = {}; (j.quotes || []).forEach((q) => { by[q.symbol] = q; });
  return by;
}

// One bulk refresh. onProgress(text) drives any spinner UI; the resolved
// object carries the summary the caller can show. Never throws — every
// failure path degrades to "enter the rest manually", same as before.
export async function refreshAllPrices({
  tickers = [], txns = [], secMeta = {}, avMeta = {}, avKey = "",
  dmoReportDate = null, setPrices, setPriceMeta, setDmoReportDate,
  onProgress = () => {},
} = {}) {
  const giltTickers = tickers.filter((tk) => secMeta[tk]?.kind === "gilt");
  const pensionFundTickers = tickers.filter((tk) => secMeta[tk]?.kind === "fund");
  const otherTickers = tickers.filter((tk) => secMeta[tk]?.kind !== "gilt" && secMeta[tk]?.kind !== "fund");
  const meta = (tk) => tickerMeta(tk, { avMeta, txns });

  const done = {}; const fxCache = {};
  const getFx = async (ccy) => { if (ccy === "GBP" || ccy === "GBp") return 1; if (!(ccy in fxCache)) fxCache[ccy] = await fxToGBP(ccy); return fxCache[ccy]; };
  const applyQuote = (tk, raw, ccy, fx, source) => {
    const g = toGBP(raw, ccy, fx);
    if (g == null) return false;
    setPrices((p) => ({ ...p, [tk]: +g.toFixed(4) }));
    setPriceMeta((p) => ({ ...p, [tk]: { asOf: new Date().toISOString(), raw, ccy, source } }));
    return true;
  };

  let giltMsg = "", warn = "";
  if (giltTickers.length) {
    onProgress("Fetching gilts from the DMO…");
    try {
      const { pricesByTicker, matched, date, skipped } = await fetchDmoGiltPrices(
        giltTickers.map((tk) => ({ ticker: tk, isin: secMeta[tk]?.isin })), { knownReportDate: dmoReportDate });
      if (skipped) {
        giltMsg = `gilts already up to date (DMO report ${dmoReportDate})`;
        for (const tk of giltTickers) done[tk] = true;
      } else {
        if (Object.keys(pricesByTicker).length) {
          setPrices((p) => ({ ...p, ...pricesByTicker }));
          setPriceMeta((p) => { const n = { ...p }; for (const tk of Object.keys(pricesByTicker)) n[tk] = { asOf: new Date().toISOString(), raw: pricesByTicker[tk] * 100, ccy: "GBP", source: "DMO" }; return n; });
          for (const tk of Object.keys(pricesByTicker)) done[tk] = true;
          if (setDmoReportDate && date) setDmoReportDate(dmoDateToIso(date));
        }
        giltMsg = `${matched}/${giltTickers.length} gilt${giltTickers.length === 1 ? "" : "s"} from DMO (${date})`;
      }
    } catch (e) { giltMsg = `gilts: ${e.message}`; }
  }
  try {
    onProgress("Fetching from Yahoo…");
    const by = await yahooFetch(otherTickers.map((tk) => meta(tk).yahoo));
    for (const tk of otherTickers) { const q = by[meta(tk).yahoo]; if (q && q.price != null) { const fx = await getFx(q.currency); if (applyQuote(tk, q.price, q.currency, fx, "Yahoo")) done[tk] = true; } }
  } catch { warn = "Yahoo function unreachable — trying Alpha Vantage fallback. "; }
  // A handful of symbols missing a quote after the first batched call is
  // usually transient contention on Yahoo's end (the exact reason "refresh
  // all" used to leave a few tickers that then succeeded when refreshed
  // individually one at a time) rather than those symbols being genuinely
  // unpriceable — so retry just the stragglers, one request per symbol, the
  // same way a manual per-ticker refresh does, before falling through to the
  // far more rate-limited Alpha Vantage.
  let stragglers = otherTickers.filter((tk) => !done[tk]);
  if (stragglers.length) {
    onProgress(`Retrying ${stragglers.length} ticker${stragglers.length === 1 ? "" : "s"} individually…`);
    for (const tk of stragglers) {
      try {
        const by1 = await yahooFetch([meta(tk).yahoo]);
        const q = by1[meta(tk).yahoo];
        if (q && q.price != null) { const fx = await getFx(q.currency); if (applyQuote(tk, q.price, q.currency, fx, "Yahoo")) done[tk] = true; }
      } catch { /* leave for the AV fallback below */ }
    }
  }
  const rest = otherTickers.filter((tk) => !done[tk]);
  if (rest.length && avKey) {
    for (let i = 0; i < rest.length; i++) {
      if (avBudget().n >= 25) { warn += "Alpha Vantage daily limit reached — enter the rest manually. "; break; }
      const tk = rest[i], m = meta(tk);
      onProgress(`Alpha Vantage fallback ${i + 1}/${rest.length}: ${tk}…`);
      try { const raw = await avQuote(m.av, avKey); avBump(); const fx = await getFx(m.currency); if (applyQuote(tk, raw, m.currency, fx, "AV")) done[tk] = true; }
      catch (e) { if (/limit/i.test(e.message)) { warn += "Alpha Vantage limit reached — stopping. "; break; } }
      if (i < rest.length - 1) { onProgress("Waiting (AV 5/min)…"); await sleep(13000); }
    }
  }
  const total = otherTickers.length + giltTickers.length;
  const got = Object.keys(done).length;
  const fundNote = pensionFundTickers.length ? ` ${pensionFundTickers.length} pension fund${pensionFundTickers.length === 1 ? "" : "s"} skipped — no live source, enter manually on the Pension & LISA tab.` : "";
  onProgress("");
  return {
    updated: got, total,
    message: `${warn}Updated ${got}/${total} prices${got < total ? " — enter the rest manually." : "."}${giltMsg ? ` (${giltMsg})` : ""}${fundNote}`,
  };
}
