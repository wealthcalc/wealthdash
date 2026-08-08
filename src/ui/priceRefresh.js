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
import { priceSanity } from "../core/price-sanity.mjs";

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
  // The prices held BEFORE this refresh — the baseline the sanity check
  // compares against. Optional: without it, jumps simply aren't detected.
  prices: priorPrices = {},
  dmoReportDate = null, setPrices, setPriceMeta, setDmoReportDate,
  onProgress = () => {},
} = {}) {
  const giltTickers = tickers.filter((tk) => secMeta[tk]?.kind === "gilt");
  const pensionFundTickers = tickers.filter((tk) => secMeta[tk]?.kind === "fund");
  const otherTickers = tickers.filter((tk) => secMeta[tk]?.kind !== "gilt" && secMeta[tk]?.kind !== "fund");
  const meta = (tk) => tickerMeta(tk, { avMeta, txns });

  const done = {}; const fxCache = {};
  // Mirror of what this run wrote, so the sanity check at the end can look at
  // the batch as a whole rather than re-reading React state mid-flight.
  const newPrices = {}, newMeta = {};
  const getFx = async (ccy) => { if (ccy === "GBP" || ccy === "GBp") return 1; if (!(ccy in fxCache)) fxCache[ccy] = await fxToGBP(ccy); return fxCache[ccy]; };
  const applyQuote = (tk, raw, ccy, fx, source) => {
    const g = toGBP(raw, ccy, fx);
    if (g == null) return false;
    const value = +g.toFixed(4);
    const m = { asOf: new Date().toISOString(), raw, ccy, source };
    newPrices[tk] = value; newMeta[tk] = m;
    setPrices((p) => ({ ...p, [tk]: value }));
    setPriceMeta((p) => ({ ...p, [tk]: m }));
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
  // /api/quotes now batches all symbols into one upstream Yahoo request and
  // does its own isolated retry server-side for anything the batch omitted,
  // so the common "a few tickers came back empty" case is handled before the
  // response even reaches us. This client-side pass is therefore a genuine
  // last resort — it only fires when the whole endpoint was unreachable (a
  // deploy, a cold start that timed out, no network) — and it re-asks in ONE
  // batched call rather than one request per symbol, which is what used to
  // turn a single failure into N sequential round-trips.
  const stragglers = otherTickers.filter((tk) => !done[tk]);
  if (stragglers.length) {
    onProgress(`Retrying ${stragglers.length} ticker${stragglers.length === 1 ? "" : "s"}…`);
    try {
      const by2 = await yahooFetch(stragglers.map((tk) => meta(tk).yahoo));
      for (const tk of stragglers) {
        const q = by2[meta(tk).yahoo];
        if (q && q.price != null) { const fx = await getFx(q.currency); if (applyQuote(tk, q.price, q.currency, fx, "Yahoo")) done[tk] = true; }
      }
    } catch { /* leave for the AV fallback below */ }
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
  // Sanity-check what just arrived against what it replaced. A symbol
  // collision or a bad tick produces a plausible-looking number, and once it
  // reaches a daily snapshot it corrupts the trend and every performance
  // figure derived from it — so the warning has to come at the point of
  // arrival, not later. Detection only: a 30% fall might be a bad quote or a
  // bad day, and this can't tell.
  const sanity = priceSanity({ prices: newPrices, previous: priorPrices, priceMeta: newMeta, secMeta });

  const total = otherTickers.length + giltTickers.length;
  const got = Object.keys(done).length;
  const fundNote = pensionFundTickers.length ? ` ${pensionFundTickers.length} pension fund${pensionFundTickers.length === 1 ? "" : "s"} skipped — no live quote source; paste your scheme's price table on the Pension & LISA tab.` : "";
  onProgress("");
  const sanityNote = sanity.issues.length
    ? ` ⚠ ${sanity.issues.length} price${sanity.issues.length === 1 ? " looks" : "s look"} wrong — ${sanity.issues[0].message}${sanity.issues.length > 1 ? ` (+${sanity.issues.length - 1} more)` : ""}`
    : "";
  return {
    updated: got, total,
    sanity,
    message: `${warn}Updated ${got}/${total} prices${got < total ? " — enter the rest manually." : "."}${giltMsg ? ` (${giltMsg})` : ""}${fundNote}${sanityNote}`,
  };
}
