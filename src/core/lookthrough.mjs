/* ======================================================================
   LOOK-THROUGH v1 — real fund exposure tables instead of (or blended
   with) single hand-tags. A fund's factsheet publishes its region/sector
   percentage breakdown; the user pastes that table once per fund
   (Holdings tab), it lands in secMeta[ticker].exposure, and the
   portfolio's exposure becomes value-weighted TRUTH for those funds
   instead of "I tagged VWRL as Global".

   Blending hierarchy per holding, coverage always reported:
     1. exposure table (factsheet paste)  -> distribute value across buckets
     2. hand tag (region/sector string)   -> whole value in one bucket
     3. neither                           -> "untagged", kept visible
   A table summing to <100% puts the remainder in "Other" rather than
   silently rescaling — factsheets legitimately have cash/other lines.

   Similarity: Σ min(weightA, weightB) over shared buckets — the overlap
   of two funds' REGION MIX. This is a mix-similarity proxy, NOT
   constituent overlap (two funds can hold identical countries via
   different stocks); the UI must label it as such. True constituent
   overlap needs holdings files — the Phase 3 version of this feature.
   Pure and node-tested (lookthrough.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;

// Canonical labels for the messy strings issuers print. Keyed lowercase.
export const REGION_ALIASES = {
  "united states": "US", "usa": "US", "us": "US", "u.s.": "US", "north america": "US & Canada",
  "united kingdom": "UK", "uk": "UK", "u.k.": "UK", "great britain": "UK",
  "europe ex uk": "Europe ex-UK", "europe ex-uk": "Europe ex-UK", "europe": "Europe ex-UK",
  "eurozone": "Europe ex-UK", "developed europe": "Europe ex-UK",
  "japan": "Japan",
  "asia pacific ex japan": "Asia ex-Japan", "pacific ex japan": "Asia ex-Japan", "asia ex japan": "Asia ex-Japan", "asia": "Asia ex-Japan",
  "emerging markets": "Emerging markets", "emerging": "Emerging markets", "em": "Emerging markets",
  "canada": "Canada", "australia": "Asia ex-Japan",
  "cash and/or derivatives": "Cash/other", "cash and derivatives": "Cash/other", "cash": "Cash/other", "other": "Cash/other", "others": "Cash/other",
  "global": "Global",
};

export const canonicalRegion = (label) => {
  const k = String(label || "").trim().toLowerCase().replace(/\s+/g, " ");
  return REGION_ALIASES[k] || String(label || "").trim();
};

// Parse a pasted factsheet breakdown: one "Label   62.1%" per line
// (tabs/spaces/colons; % optional; ignores blank lines and lines without
// a trailing number). Returns { table: {label: pct}, sum, warnings }.
export function parseExposurePaste(text, { canonical = canonicalRegion } = {}) {
  const table = {};
  const warnings = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.+?)[\s:\t]+([\d.]+)\s*%?$/);
    if (!m) { warnings.push(`Ignored line: "${line}"`); continue; }
    const pct = parseFloat(m[2]);
    if (!Number.isFinite(pct) || pct < 0) { warnings.push(`Ignored line: "${line}"`); continue; }
    const key = canonical(m[1]);
    table[key] = r2((table[key] || 0) + pct);
  }
  const sum = r2(Object.values(table).reduce((s, v) => s + v, 0));
  if (Object.keys(table).length && (sum < 90 || sum > 110)) {
    warnings.push(`Percentages sum to ${sum}% — expected ~100%. Saved as-is; the remainder shows as "Other".`);
  }
  return { table, sum, warnings };
}

// Blended portfolio exposure. field: "region" | "sector".
export function portfolioExposure({ positions = [], secMeta = {}, field } = {}) {
  const buckets = new Map();
  const add = (key, mv) => buckets.set(key, (buckets.get(key) || 0) + mv);
  let total = 0, viaTable = 0, viaTag = 0, untagged = 0;

  for (const p of positions) {
    if (!p.priced || !(p.marketValue > 0)) continue;
    total += p.marketValue;
    const meta = secMeta[p.ticker] || {};
    const table = meta.exposure?.[field];
    if (table && typeof table === "object" && Object.keys(table).length) {
      viaTable += p.marketValue;
      let covered = 0;
      for (const [label, pct] of Object.entries(table)) {
        const v = (+pct || 0) / 100;
        if (v <= 0) continue;
        add(field === "region" ? canonicalRegion(label) : String(label).trim(), p.marketValue * v);
        covered += v;
      }
      if (covered < 0.999) add("Cash/other", p.marketValue * (1 - Math.min(1, covered)));
      if (covered > 1.001) { /* >100% factsheet — already warned at paste time; weights stand as given */ }
    } else {
      const tag = String(meta[field] || "").trim();
      if (tag) { viaTag += p.marketValue; add(field === "region" ? canonicalRegion(tag) : tag, p.marketValue); }
      else { untagged += p.marketValue; add("untagged", p.marketValue); }
    }
  }

  return {
    buckets: [...buckets.entries()]
      .map(([key, marketValue]) => ({ key, marketValue: r2(marketValue), pct: total > 0 ? marketValue / total : 0 }))
      .sort((a, b) => b.marketValue - a.marketValue),
    total: r2(total),
    coverage: {
      lookthroughPct: total > 0 ? viaTable / total : 0,
      taggedPct: total > 0 ? viaTag / total : 0,
      untaggedPct: total > 0 ? untagged / total : 0,
    },
  };
}

// Mix similarity of two exposure tables: Σ min(wA, wB) with each side
// normalised to 1 first (so a 98%-summing factsheet compares fairly).
export function mixSimilarity(tableA = {}, tableB = {}, { canonical = canonicalRegion } = {}) {
  const normalise = (t) => {
    const out = {};
    let sum = 0;
    for (const [k, v] of Object.entries(t)) { const key = canonical(k); out[key] = (out[key] || 0) + (+v || 0); sum += +v || 0; }
    if (sum <= 0) return null;
    for (const k of Object.keys(out)) out[k] /= sum;
    return out;
  };
  const a = normalise(tableA), b = normalise(tableB);
  if (!a || !b) return null;
  let sim = 0;
  for (const k of Object.keys(a)) if (b[k]) sim += Math.min(a[k], b[k]);
  return sim;
}

// Pairwise similarity across open, priced holdings that HAVE exposure
// tables — [{a, b, similarity}] sorted most-similar first.
export function overlapMatrix({ positions = [], secMeta = {}, field = "region" } = {}) {
  const seen = new Set();
  const funds = [];
  for (const p of positions) {
    if (!p.priced || !(p.marketValue > 0) || seen.has(p.ticker)) continue;
    seen.add(p.ticker);
    const table = secMeta[p.ticker]?.exposure?.[field];
    if (table && Object.keys(table).length) funds.push({ ticker: p.ticker, table });
  }
  const pairs = [];
  for (let i = 0; i < funds.length; i++) for (let j = i + 1; j < funds.length; j++) {
    const similarity = mixSimilarity(funds[i].table, funds[j].table);
    if (similarity != null) pairs.push({ a: funds[i].ticker, b: funds[j].ticker, similarity });
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}
