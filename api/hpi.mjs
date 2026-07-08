// Vercel serverless function: HM Land Registry UK House Price Index (HPI)
// proxy — used to estimate a property's current value from its purchase
// price/date by regional index growth, the same "official source proxy"
// pattern as api/gilt-prices.mjs and api/fx.mjs.
//
// Endpoint verified by hand, 2026-07 (not assumed): the interactive
// "browse" tool at landregistry.data.gov.uk/app/ukhpi downloads its results
// from this CSV endpoint, which returns real, well-formed data without
// needing the SPARQL/linked-data layer:
//   https://landregistry.data.gov.uk/app/ukhpi/download/new.csv
//     ?location=http://landregistry.data.gov.uk/id/region/{slug}
//     &from=YYYY-MM-DD[&to=YYYY-MM-DD]
// Region slugs (lowercase, hyphenated) spot-checked against the live API:
// london, scotland, wales, yorkshire-and-the-humber, east-of-england.
//
// GET /api/hpi?region=london&from=2018-06   -> purchase-month + latest index
//
// `from` is the purchase month (YYYY-MM); the Land Registry series only
// goes back to Jan 1995 (England & Wales), Jan 2004 (Scotland), or Jan 2005
// (Northern Ireland) — a request before that returns the earliest month
// actually available, flagged via `purchaseMonth` in the response not
// matching the requested `from`, rather than erroring.

const REGION_SLUGS = new Set([
  "north-east", "north-west", "yorkshire-and-the-humber", "east-midlands",
  "west-midlands", "east-of-england", "london", "south-east", "south-west",
  "england", "wales", "scotland", "northern-ireland", "united-kingdom",
]);

const num = (v) => (v === "" || v == null ? null : (Number.isFinite(+v) ? +v : null));

// Minimal CSV line parser for this specific feed: quoted fields, no embedded
// newlines, commas only inside quotes — avoids pulling in a CSV dependency
// for a serverless function that only ever reads this one shape of file.
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const splitLine = (line) => {
    const out = []; let cur = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else cur += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = splitLine(lines[0]);
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = splitLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

export default async function handler(req, res) {
  const region = (req.query?.region ?? "").toString().trim().toLowerCase();
  const from = (req.query?.from ?? "").toString().trim(); // YYYY-MM

  if (!region || !REGION_SLUGS.has(region)) {
    res.status(400).json({ error: `Pass ?region= one of: ${[...REGION_SLUGS].join(", ")}`, validRegions: [...REGION_SLUGS] });
    return;
  }
  if (from && !/^\d{4}-\d{2}$/.test(from)) {
    res.status(400).json({ error: "Pass ?from=YYYY-MM (the purchase month), or omit for full history." });
    return;
  }

  try {
    const fromDate = from ? `${from}-01` : "1995-01-01";
    const url = `https://landregistry.data.gov.uk/app/ukhpi/download/new.csv?location=${encodeURIComponent("http://landregistry.data.gov.uk/id/region/" + region)}&from=${fromDate}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) { res.status(502).json({ error: `Land Registry returned HTTP ${r.status}` }); return; }
    const text = await r.text();
    const rows = parseCsv(text).filter((row) => row.Period);
    if (!rows.length) { res.status(404).json({ error: "No HPI data returned for this region/date." }); return; }

    const first = rows[0];
    // Sales volumes (and occasionally the index itself) lag the headline
    // publication by a couple of months while transactions settle — walk
    // back from the end to the most recent row that actually has an index,
    // rather than reporting a blank trailing month as "latest".
    let latest = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (num(rows[i]["House price index All property types"]) != null) { latest = rows[i]; break; }
    }
    if (!latest) { res.status(404).json({ error: "No published index value found in range." }); return; }

    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json({
      region, regionName: first.Name,
      purchaseMonth: first.Period,
      purchaseIndex: num(first["House price index All property types"]),
      purchaseAvgPrice: num(first["Average price All property types"]),
      latestMonth: latest.Period,
      latestIndex: num(latest["House price index All property types"]),
      latestAvgPrice: num(latest["Average price All property types"]),
    });
  } catch (e) {
    res.status(502).json({ error: (e && e.message) || "HPI fetch failed." });
  }
}
