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

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export default async function handler(req, res) {
  const raw = (req.query?.symbols ?? "").toString();
  const symbols = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (!symbols.length) {
    res.status(400).json({ error: "Pass ?symbols=AAA.L,BBB (comma-separated)." });
    return;
  }

  // Sequential, not Promise.all: firing every symbol's quote() concurrently
  // was the actual cause of "bulk refresh misses a few, but refreshing that
  // one ticker individually works fine" — yahoo-finance2 shares a single
  // crumb/cookie session per process, and hammering it with N simultaneous
  // requests intermittently trips Yahoo's own per-session throttling for a
  // handful of the concurrent calls (which then report "no data"/fetch
  // failed), while a single isolated request from LivePricesPanel's
  // per-ticker refresh never hits that contention. A small stagger between
  // requests trades a little latency for every symbol actually resolving on
  // the first bulk pass, same as it does one at a time.
  const quotes = [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      const q = await yf.quote(sym);
      if (!q || q.regularMarketPrice == null) quotes.push({ symbol: sym, error: "no data" });
      else quotes.push({
        symbol: sym,
        price: q.regularMarketPrice,
        currency: q.currency || null,          // e.g. "GBp", "GBP", "USD"
        name: q.shortName || q.longName || null,
      });
    } catch (e) {
      quotes.push({ symbol: sym, error: (e && e.message) || "fetch failed" });
    }
    if (i < symbols.length - 1) await new Promise((r) => setTimeout(r, 120));
  }

  // Cache at the edge briefly so repeated refreshes don't hammer Yahoo.
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.status(200).json({ quotes });
}
