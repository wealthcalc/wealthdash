/* ======================================================================
   DMO "Gilt Purchase and Sale Service" (D10B) price parser.

   The DMO's own binary .xls export requires a real BIFF parser (heavy
   dependency for a personal project); its RTF export ("Word" button,
   exportFormatValue=doc) is Crystal-Reports-generated but trivially easy
   to get plain text out of, so that's what this parses instead.

   Row shape, confirmed against a real fetched report (2026-07-02) and
   cross-checked against externally-verified gilts (T26A GB00BNNGP668 ->
   22 Oct 2026, TN28 GB00BMBL1G81 -> 31 Jan 2028 — both match this app's
   already-registered maturities exactly):
     conventional : ISIN  PurchaseClean  PurchaseDirty  RedemptionDate  Name  SaleClean  SaleDirty  Rump
     index-linked : ISIN  PurchaseClean  PurchaseDirty  IndexRatio  RedemptionDate  IndexationLag  Name  SaleClean  SaleDirty  Rump
   Index-linked gilts insert two extra fields (Index Ratio, Indexation Lag)
   between PurchaseDirty and the Name — which is why parsing anchors on the
   ISIN and the two numbers immediately following it, rather than counting
   columns positionally (a fixed-column read would misparse every
   index-linked row, since this app doesn't otherwise support them anyway
   but should not silently corrupt a neighbouring conventional gilt's data).

   One empirically-resolved quirk: Crystal Reports emits each cell as an
   independently absolutely-positioned RTF paragraph (\pvpg\phpg\posx\posy),
   so on-page reading order is NOT guaranteed to match the RTF stream order.
   The header text literally reads "Sale Dirty Price" before "Sale Clean
   Price", but the DATA stream order is [clean, dirty] — the same order as
   the purchase pair. This was caught by testing against real fetched data
   (asserting dirty >= clean, a hard invariant) rather than trusted from the
   header text alone.
   ====================================================================== */

// Strips RTF control words/groups and embedded binary shape data (Crystal
// Reports inlines background shapes as long hex blobs with no separating
// control words, which would otherwise survive as noise).
//
// Character escapes are DECODED rather than deleted. That matters here for
// one specific reason: the DMO writes gilt coupons as vulgar fractions, so
// "1½% Treasury Gilt 2026" reaches us as `\u189?` (RTF unicode escape with
// an ASCII fallback char) or `\'bd` (cp1252 byte escape). The original
// implementation deleted both, leaving "1 ? %" — which is why the gilt name
// was previously unusable as a source of the coupon rate and every gilt had
// to have its coupon typed in by hand from a broker page. Eighths (⅛, ⅜)
// aren't in cp1252 and the DMO emits those as literal "1 / 8" text, so both
// forms have to be handled downstream — see parseGiltName.
const CP1252 = { a3: "£", bc: "¼", bd: "½", be: "¾", b0: "°", 92: "'", 93: "“", 94: "”", 96: "-", 97: "-" };
export function stripRtf(raw) {
  return raw
    // \uNNNN with its optional single-character fallback (which may be "?"
    // or, in Crystal's output, a space). Must run BEFORE the generic
    // control-word strip, which would otherwise eat the \uNNNN itself.
    .replace(/\\u(-?\d+)\s?\??/g, (_, n) => {
      const code = Number(n);
      return String.fromCharCode(code < 0 ? code + 65536 : code);
    })
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => CP1252[hex.toLowerCase()] ?? "")
    .replace(/\\[a-zA-Z]+-?\d*/g, " ")
    .replace(/[{}\\]/g, " ")
    .replace(/[0-9a-fA-F]{40,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* --------------------------- gilt name → coupon ----------------------- */
const VULGAR = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875, "⅓": 1 / 3, "⅔": 2 / 3 };
// The gilt's NAME, anchored on the "%" that precedes "Treasury
// Gilt/Stock". Hyphens survive stripping inconsistently (Crystal splits
// "Index-linked" across independently positioned cells), so separators are
// matched loosely as [-_ ].
const NAME_RE = /%\s*((?:Index[-_ ]*linked[-_ ]*)?Treasury\s*(?:Gilt|Stock|Loan)[^%]*?(\d{4}))/i;

// The coupon is whatever sits IMMEDIATELY before that "%", read by
// anchoring to the end of the preceding text rather than scanning forward.
// That distinction matters: the row is "…84.12 22 Oct 2030 0 3 / 8 %
// Treasury Gilt 2030", so a forward scan happily swallows the price and the
// redemption year on its way to the "%".
const RATE_FRACTION = /(\d+)?\s*(\d+)\s*\/\s*(\d+)\s*$/;                 // "0 3 / 8", "4 1 / 8"
const RATE_VULGAR = /(\d+)?\s*([¼½¾⅛⅜⅝⅞⅓⅔])\s*$/;                        // "1½", "4 ¼"
const RATE_PLAIN = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*$/;                     // "4", "3.75"

// Parses "0 3 / 8 % Treasury Gilt 2030" -> { coupon: 0.375, indexLinked: false, ... }.
// Returns coupon: null when the rate can't be read with certainty — a gilt
// registered with a wrong coupon silently misprices every future cashflow,
// so guessing is worse than declining.
export function parseGiltName(chunk) {
  const text = String(chunk || "");
  const m = text.match(NAME_RE);
  if (!m) return { name: null, coupon: null, indexLinked: false, maturityYear: null };
  const name = m[1].replace(/_/g, "-").replace(/\s+/g, " ").trim();
  const indexLinked = /index[-_ ]*linked/i.test(name);
  const before = text.slice(0, m.index);

  let coupon = null;
  const frac = before.match(RATE_FRACTION);
  const vulgar = before.match(RATE_VULGAR);
  const plain = before.match(RATE_PLAIN);
  if (frac) coupon = (frac[1] ? +frac[1] : 0) + +frac[2] / +frac[3];
  else if (vulgar) coupon = (vulgar[1] ? +vulgar[1] : 0) + VULGAR[vulgar[2]];
  else if (plain) coupon = +plain[1];

  if (coupon != null) coupon = Math.round(coupon * 1e6) / 1e6;
  // A rate outside anything the UK has ever issued means the parse went
  // wrong (most often it read the redemption year), not that the gilt is
  // exotic — so it's reported as unknown rather than passed on.
  if (coupon != null && (!Number.isFinite(coupon) || coupon < 0 || coupon > 20)) coupon = null;
  return { name, coupon, indexLinked, maturityYear: +m[2] };
}

const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
// "22 Oct 2026" -> "2026-10-22". Null for anything else — never a partial date.
export function dmoRedemptionToIso(s) {
  const m = String(s || "").match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${String(m[1]).padStart(2, "0")}` : null;
}

// Parses cleaned text into { [ISIN]: { purchaseClean, purchaseDirty, saleClean, saleDirty, redemptionDate, rump } }.
// Rows that don't match the expected shape are skipped, never guessed at.
export function parseGiltPrices(cleanText) {
  const out = {};
  const isinRe = /GB00[A-Z0-9]{8}/g;
  const matches = [...cleanText.matchAll(isinRe)];
  for (let i = 0; i < matches.length; i++) {
    const isin = matches[i][0];
    const start = matches[i].index + isin.length;
    const end = i + 1 < matches.length ? matches[i + 1].index : cleanText.length;
    const chunk = cleanText.slice(start, end);

    const nums = chunk.match(/-?\d+\.\d+/g) || [];
    if (nums.length < 2) continue;
    const purchaseClean = parseFloat(nums[0]);
    const purchaseDirty = parseFloat(nums[1]);

    // Index-linked rows carry two extra fields between PurchaseDirty and
    // the Name: the Index Ratio (a decimal, so it lands in `nums`) and the
    // Indexation Lag ("3 Months" — no decimal point, so it doesn't). The
    // index ratio is the whole ballgame for an IL gilt: prices are quoted
    // in REAL terms, and the cash value is price x ratio. TG36's ratio is
    // ~1.59, so treating a real price as a cash price understates the
    // holding by nearly 40%.
    const isIL = /index[-_ ]*linked/i.test(chunk);
    const lagM = isIL ? chunk.match(/(\d+)\s*Months?/i) : null;
    const indexationLagMonths = lagM ? +lagM[1] : null;
    // Only trusted when the row is genuinely index-linked AND has the extra
    // number: a conventional row has exactly four numbers (purchase pair +
    // sale pair), so nums[2] there is the SALE clean price, not a ratio.
    const ratio = isIL && nums.length >= 5 ? parseFloat(nums[2]) : null;
    // A ratio outside this range means the columns didn't line up. RPI has
    // roughly tripled since the oldest live linker was issued, so 5 is a
    // generous ceiling and anything below 1 would mean deflation since issue.
    const indexRatio = ratio != null && ratio >= 0.5 && ratio <= 5 ? ratio : null;

    const dateM = chunk.match(/(\d{2})\s*_\s*(\w{3})\s*_\s*(\d{4})/);
    const redemptionDate = dateM ? `${dateM[1]} ${dateM[2]} ${dateM[3]}` : null;

    const rumpM = chunk.match(/(Yes|No)\s*$/) || chunk.match(/(Yes|No)/);
    const rump = rumpM ? rumpM[1] === "Yes" : null;
    let saleClean = null, saleDirty = null;
    if (nums.length >= 4) {
      saleClean = parseFloat(nums[nums.length - 2]);
      saleDirty = parseFloat(nums[nums.length - 1]);
    }

    // Name/coupon/maturity: everything needed to REGISTER the gilt, not just
    // to price one already registered. Any of these may be null (an
    // unreadable coupon is reported as unknown, never guessed).
    const { name, coupon, indexLinked } = parseGiltName(chunk);
    const maturity = dmoRedemptionToIso(redemptionDate);

    out[isin] = {
      purchaseClean, purchaseDirty, saleClean, saleDirty, redemptionDate, rump,
      name, coupon, indexLinked, maturity, indexRatio, indexationLagMonths,
    };
  }
  return out;
}

// UK-day formatter for the DMO request parameter, DD/MM/YYYY.
export function ukDateStr(d) {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}
