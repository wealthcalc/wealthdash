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
export function stripRtf(raw) {
  return raw
    .replace(/\\'[0-9a-fA-F]{2}/g, "")
    .replace(/\\[a-zA-Z]+-?\d*/g, " ")
    .replace(/[{}\\]/g, " ")
    .replace(/[0-9a-fA-F]{40,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

    const dateM = chunk.match(/(\d{2})\s*_\s*(\w{3})\s*_\s*(\d{4})/);
    const redemptionDate = dateM ? `${dateM[1]} ${dateM[2]} ${dateM[3]}` : null;

    const rumpM = chunk.match(/(Yes|No)\s*$/) || chunk.match(/(Yes|No)/);
    const rump = rumpM ? rumpM[1] === "Yes" : null;
    let saleClean = null, saleDirty = null;
    if (nums.length >= 4) {
      saleClean = parseFloat(nums[nums.length - 2]);
      saleDirty = parseFloat(nums[nums.length - 1]);
    }

    out[isin] = { purchaseClean, purchaseDirty, saleClean, saleDirty, redemptionDate, rump };
  }
  return out;
}

// UK-day formatter for the DMO request parameter, DD/MM/YYYY.
export function ukDateStr(d) {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}
