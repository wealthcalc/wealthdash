// Vercel serverless function: L&G workplace fund-centre proxy.
//
// Why this exists: workplace pension funds have no Yahoo/AV quote. The
// scheme's price page (e.g. legalandgeneral.com/workplace/asset-management/
// citi-uk-plan/) only EMBEDS a fund-centre widget hosted elsewhere, and that
// widget renders client-side — so neither URL yields prices to a plain
// fetch. The widget itself, though, loads a clean public JSON feed, which is
// what this forwards. No credentials are involved: it's the same data the
// page shows anyone who visits it.
//
//   GET /api/lgim-prices?site=32          -> { fetchedAt, source, json }
//
// The response is handed back verbatim for core/lgim-import.mjs to parse, so
// the shape lives in one tested place rather than being decoded twice.

import { guard } from "./_lib/guard.mjs";

const HOST = "https://widgets-lgim.huguenots.co.uk";
// `site` is the scheme's fund-centre id (32 = Citi UK Plan). Digits only —
// this must never become an open redirect to an arbitrary host/path.
const SITE_RE = /^\d{1,6}$/;

export default async function handler(req, res) {
  if (!guard(req, res)) return;

  const site = (req.query?.site ?? "32").toString().trim();
  const audience = (req.query?.audience ?? "79").toString().trim();
  const language = (req.query?.language ?? "1").toString().trim();
  if (![site, audience, language].every((v) => SITE_RE.test(v))) {
    res.status(400).json({ error: "site, audience and language must be numeric ids." });
    return;
  }

  const url = `${HOST}/srp/api/fund-centre/${site}/?audience=${audience}&language=${language}`;
  try {
    const r = await fetch(url, {
      headers: {
        // Some CDN configurations reject requests with no UA/Accept at all.
        "User-Agent": "Mozilla/5.0 (compatible; wealth-dashboard/1.0)",
        Accept: "application/json, text/plain, */*",
      },
    });
    if (!r.ok) {
      res.status(502).json({ error: `Fund centre returned HTTP ${r.status}.`, url });
      return;
    }
    const json = await r.json();
    if (!json || !Array.isArray(json.funds)) {
      res.status(502).json({ error: "Fund centre response had no funds array.", url });
      return;
    }
    // Prices strike once daily, so an hour at the edge is generous and keeps
    // repeated refreshes off the provider entirely.
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ fetchedAt: new Date().toISOString(), source: url, json });
  } catch (e) {
    res.status(502).json({ error: (e && e.message) || "Could not reach the fund centre.", url });
  }
}
