import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseGiltPrices, ukDateStr } from "../../api/_lib/dmo-gilt-parser.mjs";

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

test("ukDateStr formats as DD/MM/YYYY for the DMO request parameter", () => {
  assert.equal(ukDateStr(new Date("2026-07-02T00:00:00Z")), "02/07/2026");
  assert.equal(ukDateStr(new Date("2026-01-09T00:00:00Z")), "09/01/2026");
});
