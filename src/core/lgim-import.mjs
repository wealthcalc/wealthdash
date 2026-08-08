/* ======================================================================
   L&G WORKPLACE FUND PRICES — paste importer.

   Why paste rather than fetch: the scheme's price table (e.g.
   legalandgeneral.com/workplace/asset-management/citi-uk-plan/) is not on
   the page it appears on. That page embeds a widget from a different host,
   and the widget renders client-side — so a server-side fetch of either URL
   returns markup with no prices in it. Rather than pretend otherwise, this
   takes the text you copied (from the page or a print/PDF of it) and turns
   it into prices. It's the same trade the private-investment importer makes:
   a paste that always works beats a scrape that breaks silently.

   The awkward part is that a copied table wraps fund names unpredictably.
   A PDF print produces:

       Citi UK Plan Annuity Targeting          <- name, first half
          0.24%  0.00%  0.24%  510.72p  06/08/2026  Download data
       Fund                                    <- name, second half

   while a browser copy usually keeps each row on one line. Both are handled:
   rows are found by their DATA signature (three percentages, a pence price
   and a date), and any loose name fragments around them are stitched back
   on, split at the scheme's own name prefix (auto-detected, so this isn't
   hard-coded to one scheme).

   Prices are quoted in PENCE ("510.72p") and dated with the day the price
   was struck — usually a day or two back, because these funds price daily
   in arrears. Both facts are preserved: the caller converts pence to pounds
   and stamps the QUOTE date, not the import time, so staleness warnings
   judge a fund against its own price date.
   Pure and node-tested (lgim-import.test.mjs).
   ====================================================================== */

// A priced row: three percentages, then "1,134.39p", then "06/08/2026".
// Separators are OPTIONAL: copying the live table out of the browser yields
// no whitespace at all between cells —
//   "Citi UK Plan Annuity Targeting Fund0.24%0.00%0.24%510.72p06/08/2026"
// — whereas a PDF print pads them with spaces. The %, p and / characters are
// unambiguous delimiters, so both parse with the same expression.
// `p(?![A-Za-z])` rather than `p\b`: in the browser copy the date runs
// straight into the price ("510.72p06/08/2026"), and there is no word
// boundary between "p" and "0" — `\b` silently matched nothing at all.
const DATA_RE = /([\d.]+)\s*%\s*([\d.]+)\s*%\s*([\d.]+)\s*%\s*([\d,]+\.?\d*)\s*p(?![A-Za-z])\s*(\d{2}\/\d{2}\/\d{4})/;
// Lines that are page furniture rather than data. Deliberately NOT matching
// a bare "Fund"/"Funds": the PDF layout wraps names so that "Fund" lands on
// its own line as the tail of a real fund name, and filtering it here quietly
// truncated every wrapped name. The header's stray "Funds" is harmless — it
// gets trimmed by trimToPrefix below.
const NOISE_RE = /^(https?:\/\/|page \d+ of \d+|download data$|price history$|annual$|management charge$|additional$|expenses$|total expense$|ratio$|price$|date$|navigation$)/i;
// A trailing print timestamp like "08/08/2026, 10 42" or "10:42".
const STAMP_RE = /^\d{2}\/\d{2}\/\d{4},?\s*\d{1,2}[:\s]\d{2}/;

const clean = (s) => String(s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

// "1,134.39" -> 1134.39
const num = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

// "06/08/2026" (DD/MM/YYYY, UK) -> "2026-08-06"
export function ukDateToIso(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || "").trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  const dd = +d, mm = +mo;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y}-${mo}-${d}`;
};

// Comparable form of a fund name: case/punctuation/spacing insensitive, so
// "Citi UK Plan Property Fund – Active" matches "...Fund - Active" (the page
// mixes en-dashes and hyphens).
export function normaliseFundName(s) {
  return String(s || "")
    .replace(/[‐-―]/g, "-")   // any dash -> hyphen
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

// Most common opening two words across the candidate names — the scheme's
// own prefix ("citi uk"). Used to decide where one wrapped name ends and the
// next begins, without hard-coding a scheme.
function detectPrefix(fragments) {
  const counts = new Map();
  for (const f of fragments) {
    const words = clean(f).split(" ");
    if (words.length < 2) continue;
    const key = `${words[0]} ${words[1]}`.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null, bestN = 1; // needs to repeat to count as a prefix
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}

/* text: the copied table. Returns { rows, warnings }.
   rows: [{ name, amc, additionalExpenses, ter, pricePence, price, date }]
   `price` is GBP per unit (pence / 100); `date` is the ISO quote date. */
export function parseLgimPaste(text) {
  const warnings = [];
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(clean)
    .filter((l) => l && !NOISE_RE.test(l) && !STAMP_RE.test(l));

  // Pass 1: classify each line as a data row (with any inline name) or a
  // loose name fragment.
  const items = [];
  for (const line of lines) {
    const m = DATA_RE.exec(line);
    if (m) {
      items.push({
        kind: "data",
        inlineName: clean(line.slice(0, m.index)),
        amc: num(m[1]), additionalExpenses: num(m[2]), ter: num(m[3]),
        pricePence: num(m[4]), rawDate: m[5],
      });
    } else {
      items.push({ kind: "text", text: line });
    }
  }

  // Pass 2: stitch loose fragments onto the row they belong to. A fragment
  // that starts with the scheme prefix begins a NEW name (so it belongs to
  // the row that follows); anything before it completes the previous name.
  const prefix = detectPrefix([
    ...items.filter((i) => i.kind === "text").map((i) => i.text),
    ...items.filter((i) => i.kind === "data" && i.inlineName).map((i) => i.inlineName),
  ]);
  const startsName = (s) => (prefix ? clean(s).toLowerCase().startsWith(prefix) : true);
  // Trim anything before the scheme prefix. Two real cases: the run-together
  // header row ("FundsAnnual management charge…") landing in front of the
  // first fund, and prose pasted alongside the table ("here is the copy &
  // paste from the website data: Citi UK Plan European…").
  const trimToPrefix = (s) => {
    if (!prefix) return clean(s);
    const t = clean(s);
    const i = t.toLowerCase().indexOf(prefix);
    return i > 0 ? t.slice(i) : t;
  };

  const rows = [];
  let pendingHead = "";   // name fragment(s) awaiting their data row
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "text") {
      if (startsName(it.text) || !rows.length) pendingHead = pendingHead ? `${pendingHead} ${it.text}` : it.text;
      else rows[rows.length - 1].name = clean(`${rows[rows.length - 1].name} ${it.text}`); // tail of the previous name
      continue;
    }
    // An inline name is self-contained (browser copy), so it wins outright —
    // prepending a pending fragment would glue the header row onto the first
    // fund. A pending fragment is only the name when the row has none of its
    // own (the PDF's wrapped layout).
    const name = trimToPrefix(it.inlineName || pendingHead);
    pendingHead = "";
    const date = ukDateToIso(it.rawDate);
    if (!date) { warnings.push(`Skipped a row with an unreadable date "${it.rawDate}".`); continue; }
    if (!(it.pricePence > 0)) { warnings.push(`Skipped "${name || "a fund"}" — no usable price.`); continue; }
    rows.push({
      name,
      amc: it.amc, additionalExpenses: it.additionalExpenses, ter: it.ter,
      pricePence: it.pricePence,
      price: Math.round((it.pricePence / 100) * 1e6) / 1e6, // pence -> £/unit
      date,
    });
  }

  const unnamed = rows.filter((r) => !r.name).length;
  if (unnamed) warnings.push(`${unnamed} priced row${unnamed === 1 ? "" : "s"} had no readable fund name — match them by hand.`);
  if (!rows.length) warnings.push("No fund prices found in that text. Copy the whole price table, including the Price and Date columns.");
  return { rows, warnings };
}

/* ---------------------------------------------------------------------
   The same table, straight from the widget's own JSON API.

   The scheme page embeds a fund-centre widget which loads its data from
   /srp/api/fund-centre/<site>/?audience=<n>&language=<n>. That endpoint is
   public and unauthenticated, so the app can fetch it through a proxy and
   skip the copy-paste entirely — parseLgimPaste stays as the fallback for
   when the endpoint moves or a different provider is involved.

   Two traps, both handled here:

   1. FIELDS ARE POSITIONAL. Each fund's `data` is a bare array whose
      meaning comes from metadata.fund_fields. Hard-coding indices would
      break silently the day a column is added, so indices are resolved by
      code_name every time. `midPrice` appears TWICE (once as a string
      placeholder, once as the real currency value) — the currency one is
      what's wanted.
   2. THE PRICE IS ALREADY IN POUNDS. The JSON carries 5.10721 and the
      metadata's format rule ("{:#,##0.00}p(*100)") is what turns it into
      the 510.72p shown on screen. Dividing by 100 here — as the paste
      parser correctly does for the rendered pence — would undervalue the
      holding a hundredfold.
   --------------------------------------------------------------------- */
export function parseLgimApi(json) {
  const warnings = [];
  const fields = json?.metadata?.fund_fields;
  const funds = json?.funds;
  if (!Array.isArray(fields) || !Array.isArray(funds)) {
    return { rows: [], warnings: ["That doesn't look like a fund-centre response."] };
  }
  // Resolve by name, preferring the typed entry where a code_name repeats.
  const idxOf = (codeName, preferType) => {
    let fallback = -1;
    for (let i = 0; i < fields.length; i++) {
      if (fields[i]?.code_name !== codeName) continue;
      if (preferType && fields[i].type === preferType) return i;
      fallback = i;
    }
    return fallback;
  };
  const iName = idxOf("name"), iCode = idxOf("code");
  const iPrice = idxOf("midPrice", "currency"), iDate = idxOf("midPrice__date");
  const iAmc = idxOf("amc"), iAe = idxOf("ae"), iTer = idxOf("ter");
  if (iPrice < 0 || iDate < 0) return { rows: [], warnings: ["The response carried no price column."] };

  const pctNum = (s) => {
    const n = parseFloat(String(s ?? "").replace("%", ""));
    return Number.isFinite(n) ? n : null;
  };
  const rows = [];
  for (const f of funds) {
    const d = f?.data;
    if (!Array.isArray(d)) continue;
    const name = clean(d[iName]);
    const price = num(d[iPrice]);                    // already £/unit
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(d[iDate] || "")) ? d[iDate] : ukDateToIso(d[iDate]);
    if (!(price > 0) || !date) {
      warnings.push(`Skipped "${name || "an unnamed fund"}" — no usable price or date.`);
      continue;
    }
    if ((f.currency || "GBP") !== "GBP") {
      warnings.push(`Skipped "${name}" — priced in ${f.currency}, not GBP.`);
      continue;
    }
    rows.push({
      name,
      code: iCode >= 0 ? clean(d[iCode]) || null : null,
      amc: pctNum(d[iAmc]), additionalExpenses: pctNum(d[iAe]), ter: pctNum(d[iTer]),
      price: Math.round(price * 1e6) / 1e6,
      pricePence: Math.round(price * 100 * 1e4) / 1e4,  // for display parity with the page
      date,
    });
  }
  if (!rows.length && !warnings.length) warnings.push("The response contained no funds.");
  return { rows, warnings };
}

/* Suggest a holding for a fund the mapping doesn't yet know.

   Real holdings are rarely named the way the provider names them — a fund
   the scheme calls "Citi UK Plan Global Equity Fund - Passive" is quite
   reasonably filed as "Citi SIPP — L&G Global Equity Fund (Passive)". Exact
   matching gives up there, which would mean hand-mapping every fund on the
   first run.

   So: score candidates on shared words, weighting each word by how RARE it
   is among the candidates. "citi", "fund" and "equity" appear everywhere and
   say nothing; "global", "japan" and "shariah" are what actually identify a
   fund. A suggestion is only offered when the best candidate clears a
   threshold AND beats the runner-up by a clear margin — an ambiguous guess
   is worse than none, because the user would rubber-stamp it.

   This only PRE-SELECTS the dropdown. Nothing is applied without the user
   confirming, because a wrong price on a pension holding is expensive. */
const tokens = (s) => normaliseFundName(s).split(" ").filter((t) => t.length > 1);

/* Stable key for "I've told you this fund isn't one of mine".

   A scheme feed lists every fund in the plan — 25 of them here — while a
   member typically holds two or three. Without a memory of what's been
   dismissed, every refresh re-proposes the same two dozen wrong matches, and
   the user has to decline them again. Keyed on the provider's fund code
   where there is one so it survives renames, falling back to the normalised
   name. */
export const lgimIgnoreKey = (row) => (row?.code
  ? `code:${String(row.code).trim().toUpperCase()}`
  : `name:${normaliseFundName(row?.name)}`);

export function suggestLgimMatch(row, candidates = []) {
  if (!candidates.length) return null;
  // Inverse document frequency across the candidate names. A word the
  // candidates never use ("uk", "plan" — the provider's own house style)
  // scores ZERO rather than maximum: it says nothing about WHICH holding this
  // is, and weighting it highly buried the real signal.
  const df = new Map();
  for (const c of candidates) for (const t of new Set(tokens(c.name))) df.set(t, (df.get(t) || 0) + 1);
  const weight = (t) => (df.has(t) ? Math.log((candidates.length + 1) / (df.get(t) + 1)) + 0.01 : 0);

  const rowTokens = new Set(tokens(row.name));
  // Asymmetric on purpose: score how much of the FEED name this holding
  // explains, not how similar the two strings are. A holding carrying extra
  // detail the provider omits ("[L&G North America Equity Index Fund]")
  // shouldn't be punished for it — that's exactly the note a user adds.
  const denom = [...rowTokens].reduce((s, t) => s + weight(t), 0);
  if (denom <= 0) return null;

  const scored = candidates.map((c) => {
    const cand = new Set(tokens(c.name));
    let shared = 0;
    for (const t of rowTokens) if (cand.has(t)) shared += weight(t);
    return { ticker: c.ticker, score: shared / denom };
  }).sort((a, b) => b.score - a.score);

  const [best, next] = scored;
  if (!best || best.score < 0.25) return null;
  if (next && best.score - next.score < 0.08) return null; // too close to call
  return { ticker: best.ticker, score: Math.round(best.score * 100) / 100 };
}

/* Map rows onto the app's tickers.

   Priority is deliberate: the provider's own fund CODE ("DDES") first, since
   it survives the marketing renames that fund names undergo; then the saved
   name mapping; then the display name. Anything unrecognised is returned for
   the UI to ask about — guessing would put a wrong price on a pension
   holding, which is worse than asking once. */
export function matchLgimRows(rows = [], { secMeta = {} } = {}) {
  const byCode = new Map(), byName = new Map();
  for (const [ticker, meta] of Object.entries(secMeta)) {
    if (!meta) continue;
    const code = String(meta.lgimCode || "").trim().toUpperCase();
    if (code && !byCode.has(code)) byCode.set(code, ticker);
    for (const candidate of [meta.lgimName, meta.name]) {
      const key = normaliseFundName(candidate);
      if (key && !byName.has(key)) byName.set(key, ticker);
    }
  }
  const matched = [], unmatched = [];
  const seen = new Set();
  for (const row of rows) {
    const code = String(row.code || "").trim().toUpperCase();
    const ticker = (code && byCode.get(code)) || byName.get(normaliseFundName(row.name));
    if (ticker && !seen.has(ticker)) { seen.add(ticker); matched.push({ ticker, ...row }); }
    else unmatched.push(row);
  }
  return { matched, unmatched };
}
