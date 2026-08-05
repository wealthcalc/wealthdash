// Vercel serverless function: Yahoo Finance quote proxy.
//
// Why this exists: Yahoo's endpoints can't be called from the browser (no CORS,
// plus a cookie/crumb handshake). This runs server-side, so the dashboard can
// fetch live prices via same-origin GET /api/quotes?symbols=SWDA.L,WFC
//
// Returns per-symbol: { symbol, price, currency, name } or { symbol, error }.
// The client normalises to GBP (Yahoo returns "GBp" for pence-quoted LSE lines,
// "USD"/"EUR" for others), so this function stays thin and stateless.
//
// Deploy: place at /api/quotes.mjs and add "yahoo-finance2" to dependencies.
// The .mjs extension forces ESM regardless of your package.json "type".

import YahooFinance from "yahoo-finance2";
import { guard } from "./_lib/guard.mjs";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// yahoo-finance2 accepts an ARRAY of symbols and resolves it in ONE upstream
// request. That matters more than it looks.
//
// This function used to loop symbols one at a time with a 120ms stagger, to
// dodge the per-session throttling that firing them all concurrently
// provoked. It fixed the contention but replaced it with a worse failure
// mode: N sequential round-trips meant total time grew with the portfolio,
// and past roughly a dozen symbols the invocation exceeded the platform's
// function timeout. The client then saw one failed bulk call and re-fetched
// every ticker individually — the "bulk fails midway, then N fetch one by
// one" behaviour. Batching is the actual answer: a single upstream call for
// all symbols has neither the concurrency contention nor the latency pile-up.
//
// Chunked only because a very long symbol list makes an unwieldy upstream
// URL; chunks run in sequence, so 50 symbols is 3 upstream calls, not 50.
const CHUNK = 20;
const MAX_SYMBOLS = 50;

// Yahoo occasionally returns a payload that trips the library's strict schema
// validation for an otherwise perfectly good quote. Failing a whole batch
// over that would reintroduce exactly the all-or-nothing this removes.
const OPTS = { validateResult: false };

const shape = (q) => ({
  symbol: q.symbol,
  price: q.regularMarketPrice,
  currency: q.currency || null,        // e.g. "GBp", "GBP", "USD"
  name: q.shortName || q.longName || null,
});

// One symbol, isolated — the rescue path for anything a batch didn't return.
async function quoteOne(sym) {
  try {
    const q = await yf.quote(sym, {}, OPTS);
    if (!q || q.regularMarketPrice == null) return { symbol: sym, error: "no data" };
    return shape({ ...q, symbol: sym });
  } catch (e) {
    return { symbol: sym, error: (e && e.message) || "fetch failed" };
  }
}

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const raw = (req.query?.symbols ?? "").toString();
  const symbols = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_SYMBOLS);
  if (!symbols.length) {
    res.status(400).json({ error: "Pass ?symbols=AAA.L,BBB (comma-separated)." });
    return;
  }

  const bySymbol = new Map();
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    try {
      const out = await yf.quote(chunk, {}, OPTS);
      for (const q of (Array.isArray(out) ? out : [out])) {
        if (q && q.symbol && q.regularMarketPrice != null) bySymbol.set(q.symbol, shape(q));
      }
    } catch {
      // A whole chunk failing is rare, and usually one bad symbol poisoning
      // the request — fall back to per-symbol for THIS chunk only, so one dud
      // ticker can't cost the other nineteen their prices.
      const rescued = await Promise.all(chunk.map(quoteOne));
      for (const q of rescued) if (q.price != null) bySymbol.set(q.symbol, q);
    }
  }

  // Anything the batch simply didn't return (Yahoo silently omits unknown or
  // momentarily unavailable symbols) gets one isolated retry here, server-side
  // — so the client doesn't need a second pass of its own for the common case.
  const missing = symbols.filter((s) => !bySymbol.has(s));
  if (missing.length) {
    const rescued = await Promise.all(missing.map(quoteOne));
    for (const q of rescued) bySymbol.set(q.symbol, q);
  }

  // Preserve the caller's order, and always answer for every symbol asked.
  const quotes = symbols.map((s) => bySymbol.get(s) || { symbol: s, error: "no data" });

  // Cache at the edge briefly so repeated refreshes don't hammer Yahoo.
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.status(200).json({ quotes });
}
