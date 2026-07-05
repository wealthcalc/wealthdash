// Vercel serverless function: DMO "Gilt Purchase and Sale Service" price proxy.
//
// Why this exists: individual UK gilts aren't covered by Alpha Vantage (no
// bond/ISIN asset class in their API) or Yahoo Finance (only gilt indices
// and gilt funds, not individual ISINs) — verified by hand, not assumed.
// The DMO itself publishes official daily prices for this purpose, free,
// as PDF/Excel/Word exports. This calls their RTF ("Word") export, which is
// far easier to parse reliably than the binary .xls (no BIFF dependency),
// and normalises the result to { ISIN: { clean, dirty, redemptionDate } }.
//
// Only conventional gilts are returned with full confidence; index-linked
// gilts parse fine too (see _lib/dmo-gilt-parser.mjs) but this app doesn't
// model them, so the client should ignore ISINs it hasn't registered.
//
// GET /api/gilt-prices                       -> most recent business day found
// GET /api/gilt-prices?date=2026-07-02        -> a specific date (YYYY-MM-DD)
// GET /api/gilt-prices?isins=GB00BMBL1G81,... -> filter to specific ISINs
//
// DMO prices are published once daily (~2pm) and don't exist for weekends
// or bank holidays, so this walks backward up to 7 days to find the most
// recent report — the same "closest available" approach as api/fx.mjs.

import { stripRtf, parseGiltPrices, ukDateStr } from "./_lib/dmo-gilt-parser.mjs";

const REPORT_URL = (dateStr) =>
  `https://www.dmo.gov.uk/umbraco/surface/DataExport/GetDataExport?reportCode=D10B&exportFormatValue=doc&parameters=%26Trade%20Date%3D${encodeURIComponent(dateStr)}`;

async function fetchForDate(dateStr) {
  const r = await fetch(REPORT_URL(dateStr), { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const rtf = await r.text();
  // A day with no report still returns 200 with the template/header only —
  // detect that by requiring at least one real ISIN to show up.
  if (!/GB00[A-Z0-9]{8}/.test(rtf)) return null;
  const clean = stripRtf(rtf);
  const parsed = parseGiltPrices(clean);
  return Object.keys(parsed).length ? parsed : null;
}

export default async function handler(req, res) {
  const isinFilter = (req.query?.isins ?? "").toString().split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const requestedDate = (req.query?.date ?? "").toString().trim();

  let start;
  if (requestedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      res.status(400).json({ error: "Pass ?date=YYYY-MM-DD (optional) and/or ?isins=GB00...,GB00... (optional)." });
      return;
    }
    start = new Date(requestedDate + "T00:00:00Z");
  } else {
    start = new Date();
  }

  try {
    let parsed = null, usedDate = null;
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setUTCDate(d.getUTCDate() - i);
      const dateStr = ukDateStr(d);
      parsed = await fetchForDate(dateStr);
      if (parsed) { usedDate = dateStr; break; }
    }
    if (!parsed) {
      res.status(404).json({ error: "No DMO gilt price report found in the last 7 days." });
      return;
    }

    const result = {};
    for (const [isin, data] of Object.entries(parsed)) {
      if (isinFilter.length && !isinFilter.includes(isin)) continue;
      // Clean/dirty as the average of DMO's purchase & sale quotes — a small,
      // roughly symmetric retail spread, so the midpoint is a fair single
      // "market" figure for personal valuation (not a trading price).
      result[isin] = {
        clean: Math.round(((data.purchaseClean + data.saleClean) / 2) * 1e6) / 1e6,
        dirty: Math.round(((data.purchaseDirty + data.saleDirty) / 2) * 1e6) / 1e6,
        purchaseClean: data.purchaseClean,
        saleClean: data.saleClean,
        redemptionDate: data.redemptionDate,
      };
    }

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ date: usedDate, prices: result });
  } catch (e) {
    res.status(502).json({ error: (e && e.message) || "fetch failed" });
  }
}
