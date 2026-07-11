// Vercel serverless function: Yahoo Finance historical price series proxy,
// for the Benchmark comparison feature (Phase 2, step 5).
//
// Same rationale as api/fx.mjs and api/quotes.mjs — Yahoo can't be called
// directly from the browser (no CORS, cookie/crumb handshake), so this runs
// server-side and returns a plain JSON close series.
//
// GET /api/benchmark?symbol=VWRL.L&from=2024-01-01&to=2026-07-08
//   -> { symbol, name, currency, prices: [{ date, close }, ...] }
//
// Any Yahoo-recognised symbol is accepted (same policy as api/quotes.mjs,
// which already accepts arbitrary tickers) rather than a hardcoded
// allowlist — the client suggests common index trackers (a global tracker,
// a UK all-share tracker, etc.) but doesn't restrict input to them, since a
// user's actual benchmark of choice is a personal judgement call, not
// something this app should gatekeep.
//
// Close prices are returned exactly as Yahoo reports them (native currency,
// e.g. GBp for LSE-listed lines) — the client is responsible for FX/pence
// normalisation if it mixes benchmarks across currencies, same convention
// as api/quotes.mjs.

import YahooFinance from "yahoo-finance2";
import { guard } from "./_lib/guard.mjs";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const symbol = (req.query?.symbol ?? "").toString().trim();
  const from = (req.query?.from ?? "").toString().trim();
  const to = (req.query?.to ?? "").toString().trim() || new Date().toISOString().slice(0, 10);
  if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.status(400).json({ error: "Pass ?symbol=VWRL.L&from=YYYY-MM-DD&to=YYYY-MM-DD (to defaults to today)." });
    return;
  }

  try {
    const period1 = new Date(from + "T00:00:00Z");
    period1.setUTCDate(period1.getUTCDate() - 7); // pad backward so a start date right on a
    // holiday/weekend still finds an on-or-before close once the client aligns dates.
    const period2 = new Date(to + "T00:00:00Z");
    period2.setUTCDate(period2.getUTCDate() + 1); // Yahoo's period2 is exclusive-ish; pad a day.

    const [chart, quote] = await Promise.all([
      yf.chart(symbol, { period1, period2, interval: "1d" }),
      yf.quote(symbol).catch(() => null),
    ]);
    const quotes = (chart?.quotes || []).filter((q) => q && q.close != null && q.date);
    if (!quotes.length) { res.status(404).json({ error: `No Yahoo price history for ${symbol} in that range.` }); return; }

    const prices = quotes.map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: q.close }));
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({
      symbol, name: quote?.shortName || quote?.longName || symbol, currency: quote?.currency || null,
      prices,
    });
  } catch (e) {
    res.status(502).json({ error: (e && e.message) || "fetch failed" });
  }
}
