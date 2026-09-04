import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseGiltPrices, ukDateStr, stripRtf, parseGiltName, dmoRedemptionToIso } from "../../api/_lib/dmo-gilt-parser.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Real text captured from a live DMO D10B RTF export (2 Jul 2026), already
// stripped of RTF control codes — see api/gilt-prices.mjs for the fetch side.
// Two gilts in this fixture (T26A, TN28) have redemption dates that were
// independently cross-checked against this app's own already-registered
// (externally-verified) gilt maturities, catching two real parser bugs
// during development: a redemption-date regex that didn't tolerate stray
// spaces, and a sale-price pair that turned out to be [clean, dirty] in the
// RTF stream despite the header text listing "Sale Dirty" before "Sale
// Clean" — Crystal Reports emits each cell as an independently
// absolutely-positioned paragraph, so stream order isn't reading order.
const fixture = readFileSync(join(__dirname, "dmo-gilt-fixture.txt"), "utf8");

test("parses conventional gilt rows: prices, redemption date, rump flag", () => {
  const result = parseGiltPrices(fixture);
  const g = result["GB00BYZW3G56"]; // 1½% Treasury Gilt 2026
  assert.equal(g.purchaseClean, 99.90);
  assert.equal(g.saleClean, 99.91);
  assert.equal(g.redemptionDate, "22 Jul 2026");
  assert.equal(g.rump, false);
});

test("dirty >= clean always holds (the invariant that caught the ordering bug)", () => {
  const result = parseGiltPrices(fixture);
  for (const [isin, g] of Object.entries(result)) {
    if (g.saleDirty == null) continue; // fixture-boundary row, no full data
    assert.ok(g.purchaseDirty >= g.purchaseClean, `${isin}: purchase dirty >= clean`);
    assert.ok(g.saleDirty >= g.saleClean, `${isin}: sale dirty >= clean`);
  }
});

test("redemption dates match this app's already-registered gilt maturities", () => {
  const result = parseGiltPrices(fixture);
  // T26A and TN28 maturities were verified independently (DMO/HL listings)
  // in an earlier build step — this is a second, independent confirmation.
  assert.equal(result["GB00BNNGP668"].redemptionDate, "22 Oct 2026"); // T26A
  assert.equal(result["GB00BMBL1G81"].redemptionDate, "31 Jan 2028"); // TN28
  assert.equal(result["GB00BNNGP668"].purchaseClean, 99.06);
  assert.equal(result["GB00BMBL1G81"].purchaseClean, 94.31);
});

test("index-linked rows (extra Index Ratio + Indexation Lag fields) don't corrupt parsing", () => {
  const result = parseGiltPrices(fixture);
  const g = result["GB00BMF9LJ15"]; // 0⅛% Index-linked Treasury Gilt 2033
  assert.equal(g.purchaseClean, 95.24);
  assert.equal(g.redemptionDate, "22 Nov 2033");
});

test("unrecognisable rows (too few numbers) are skipped, not guessed at", () => {
  const result = parseGiltPrices("GB00ZZZZZZZZ no numbers here at all");
  assert.equal(result["GB00ZZZZZZZZ"], undefined);
});

/* -------------------- coupon recovery (fractions) --------------------- */
// The fixture above is REAL captured text, stripped by the ORIGINAL
// stripRtf — which deleted RTF character escapes, so "1½%" arrives as
// "1 ? %". That's exactly why gilt coupons previously had to be typed in
// by hand. These tests cover the decoding on synthetic RTF (the real bytes
// aren't checked in) plus the fixture's surviving ASCII-fraction rows.

test("RTF character escapes are decoded, not deleted — this is where the coupon lives", () => {
  assert.equal(stripRtf("GB00X 1\\u189?% Treasury Gilt 2026"), "GB00X 1½% Treasury Gilt 2026");
  assert.equal(stripRtf("4\\'bc% Treasury Gilt 2032"), "4¼% Treasury Gilt 2032");
  assert.equal(stripRtf("3\\'be% Treasury Gilt 2044"), "3¾% Treasury Gilt 2044");
  // The old behaviour, for contrast: deletion left an unusable "1 ? %".
  assert.ok(!stripRtf("1\\u189?% Treasury Gilt 2026").includes("?"));
});

test("stripRtf still removes control words and inlined binary shape data", () => {
  const noise = "{\\rtf1\\ansi\\deff0 " + "a1b2c3d4".repeat(8) + " GB00BMBL1D50 84.12}";
  const out = stripRtf(noise);
  assert.ok(out.includes("GB00BMBL1D50 84.12"));
  assert.ok(!/rtf1|ansi|deff/.test(out));
  assert.ok(!out.includes("a1b2c3d4a1b2"), "long hex blobs are still stripped");
});

test("coupons parse from every shape the DMO writes them in", () => {
  const c = (s) => parseGiltName(s).coupon;
  assert.equal(c("84.12 22 Oct 2030 0 3 / 8 % Treasury Gilt 2030 84.13"), 0.375);
  assert.equal(c("1½% Treasury Gilt 2026"), 1.5);
  assert.equal(c("4 1 / 8 % Treasury Gilt 2027"), 4.125);
  assert.equal(c("4¼% Treasury Gilt 2032"), 4.25);
  assert.equal(c("4% Treasury Gilt 2031"), 4);
  assert.equal(c("2½% Treasury Stock 2050"), 2.5);
});

test("an unreadable coupon is null — a wrong one misprices every cashflow", () => {
  // The fixture's ½/¼/¾ rows lost their fraction to the old stripper; the
  // parser must decline rather than read "1 ? %" as 1.
  const r = parseGiltName("1 ? % Treasury Gilt 2026");
  assert.equal(r.coupon, null);
  assert.equal(r.maturityYear, 2026, "the rest of the row is still usable");
  assert.equal(parseGiltName("not a gilt at all").coupon, null);
  assert.equal(parseGiltName("").name, null);
  assert.equal(parseGiltName(undefined).coupon, null);
});

test("index-linked gilts are identified so they can be refused rather than mismodelled", () => {
  const r = parseGiltName("0 1 / 8 % Index _ linked Treasury Gilt 2033");
  assert.equal(r.indexLinked, true);
  assert.equal(r.coupon, 0.125);
  assert.equal(parseGiltName("0 3 / 8 % Treasury Gilt 2030").indexLinked, false);
});

test("the fixture's ASCII-fraction rows now yield a registerable coupon and maturity", () => {
  const result = parseGiltPrices(fixture);
  const t26a = result["GB00BNNGP668"]; // 0⅜% Treasury Gilt 2026
  assert.equal(t26a.coupon, 0.375);
  assert.equal(t26a.maturity, "2026-10-22", "ISO maturity, ready for secMeta");
  assert.equal(t26a.indexLinked, false);

  const tn28 = result["GB00BMBL1G81"]; // 0⅛% Treasury Gilt 2028
  assert.equal(tn28.coupon, 0.125);
  assert.equal(tn28.maturity, "2028-01-31");

  const il = result["GB00BMF9LJ15"];
  assert.equal(il.indexLinked, true);
});

test("redemption dates convert to ISO, or to nothing at all", () => {
  assert.equal(dmoRedemptionToIso("22 Oct 2026"), "2026-10-22");
  assert.equal(dmoRedemptionToIso("7 Mar 2028"), "2028-03-07");
  assert.equal(dmoRedemptionToIso("22 Xyz 2026"), null);
  assert.equal(dmoRedemptionToIso(""), null);
  assert.equal(dmoRedemptionToIso(null), null);
});

test("ukDateStr formats as DD/MM/YYYY for the DMO request parameter", () => {
  assert.equal(ukDateStr(new Date("2026-07-02T00:00:00Z")), "02/07/2026");
  assert.equal(ukDateStr(new Date("2026-01-09T00:00:00Z")), "09/01/2026");
});
