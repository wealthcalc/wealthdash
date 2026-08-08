import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLgimPaste, matchLgimRows, normaliseFundName, ukDateToIso } from "../core/lgim-import.mjs";

/* The real thing: copied straight out of the live L&G scheme page. Note the
   complete ABSENCE of separators between cells, the run-together header row,
   the thousands separator in "1,134.39p", the en-dash in "Property Fund –
   Active", and a line of the user's own prose pasted in front of one fund. */
const BROWSER_PASTE = `FundsAnnual management chargeAdditional expensesTotal expense ratioPriceDatePrice history
Citi UK Plan Annuity Targeting Fund0.24%0.00%0.24%510.72p06/08/2026Download data
Citi UK Plan Cash Targetting Fund (L/S)0.21%0.00%0.21%115.93p06/08/2026Download data
Citi UK Plan Commodities Derivatives Fund - Active0.520%0.340%0.860%125.15p06/08/2026Download data
Citi UK Plan Growth Fund0.4065%0.0161%0.4226%1,134.39p06/08/2026Download data
here is the copy & paste from the website data: Citi UK Plan European (Ex UK) Equity Fund - Passive0.140%0.000%0.140%457.88p06/08/2026Download data
Citi UK Plan Property Fund – Active0.22%0.68%0.90%169.53p06/08/2026Download data
Citi UK Plan US Equity Fund - Passive0.140%0.000%0.140%1,139.89p06/08/2026Download data`;

/* A PDF print of the same page wraps names around the numeric row instead. */
const PDF_PASTE = `                      Annual               Additional       Total expense
       Funds                  management charge    expenses         ratio          Price     Date      Price history

       Citi UK Plan Annuity Targeting
                              0.24%                0.00%            0.24%        510.72p   06/08/2026  Download data
       Fund

       Citi UK Plan Commodities
                              0.520%               0.340%           0.860%       125.15p   06/08/2026  Download data
       Derivatives Fund - Active

       Citi UK Plan Environmental Fund     0.14%   0.01%   0.15%    161.92p   06/08/2026   Download data

https://www.legalandgeneral.com/workplace/asset-management/citi-uk-plan/         08/08/2026, 10 42
                                                                                       Page 1 of 3`;

test("ukDateToIso: DD/MM/YYYY is read as UK order, not US", () => {
  assert.equal(ukDateToIso("06/08/2026"), "2026-08-06"); // 6 August, not 8 June
  assert.equal(ukDateToIso("31/12/2025"), "2025-12-31");
  assert.equal(ukDateToIso("2026-08-06"), null);
  assert.equal(ukDateToIso("06/13/2026"), null);         // no month 13
});

test("browser paste: parses every fund despite having no separators at all", () => {
  const { rows, warnings } = parseLgimPaste(BROWSER_PASTE);
  assert.equal(rows.length, 7, "one row per fund, header excluded");
  assert.deepEqual(warnings, []);

  const first = rows[0];
  assert.equal(first.name, "Citi UK Plan Annuity Targeting Fund", "header row isn't glued onto the name");
  assert.equal(first.pricePence, 510.72);
  assert.equal(first.price, 5.1072, "pence converted to £ per unit");
  assert.equal(first.date, "2026-08-06", "the QUOTE date, not today");
  assert.equal(first.amc, 0.24);
  assert.equal(first.additionalExpenses, 0);
  assert.equal(first.ter, 0.24);
});

test("browser paste: thousands separators, en-dashes and stray prose survive", () => {
  const { rows } = parseLgimPaste(BROWSER_PASTE);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

  assert.equal(byName["Citi UK Plan Growth Fund"].pricePence, 1134.39, "1,134.39p parsed");
  assert.equal(byName["Citi UK Plan Growth Fund"].price, 11.3439);
  assert.equal(byName["Citi UK Plan US Equity Fund - Passive"].price, 11.3989);
  assert.ok(byName["Citi UK Plan Property Fund – Active"], "en-dash name kept verbatim");
  // The pasted sentence is stripped back to where the fund name starts.
  assert.ok(byName["Citi UK Plan European (Ex UK) Equity Fund - Passive"], "prose prefix removed");
});

test("PDF print: names wrapped around the numbers are stitched back together", () => {
  const { rows } = parseLgimPaste(PDF_PASTE);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, "Citi UK Plan Annuity Targeting Fund", "head + tail rejoined");
  assert.equal(rows[1].name, "Citi UK Plan Commodities Derivatives Fund - Active");
  assert.equal(rows[2].name, "Citi UK Plan Environmental Fund", "single-line row still works");
  assert.equal(rows[0].price, 5.1072);
  // URL and "Page 1 of 3" furniture must not become a fund.
  assert.ok(!rows.some((r) => /legalandgeneral|page \d/i.test(r.name)));
});

test("normaliseFundName ignores case, dash style and spacing", () => {
  assert.equal(
    normaliseFundName("Citi UK Plan Property Fund – Active"),
    normaliseFundName("citi uk plan property fund - active")
  );
  assert.equal(
    normaliseFundName("Citi UK Plan  Cash Targetting Fund (L/S)"),
    normaliseFundName("Citi UK Plan Cash Targetting Fund (L S)")
  );
});

test("matching: an explicit lgimName wins, display name is the fallback, rest are asked about", () => {
  const { rows } = parseLgimPaste(BROWSER_PASTE);
  const secMeta = {
    CITIGRW: { kind: "fund", lgimName: "Citi UK Plan Growth Fund" },
    CITIUSP: { kind: "fund", name: "Citi UK Plan US Equity Fund - Passive" },
    VWRL: { name: "Vanguard All-World" },
  };
  const { matched, unmatched } = matchLgimRows(rows, { secMeta });

  const byTicker = Object.fromEntries(matched.map((m) => [m.ticker, m]));
  assert.equal(byTicker.CITIGRW.price, 11.3439, "matched on the saved mapping");
  assert.equal(byTicker.CITIUSP.price, 11.3989, "matched on the display name");
  assert.equal(matched.length, 2);
  assert.equal(unmatched.length, rows.length - 2, "unknown funds are surfaced, never guessed");
  assert.ok(!matched.some((m) => m.ticker === "VWRL"), "unrelated holdings aren't touched");
});

test("empty and junk input degrade to a warning, not a crash or a bad price", () => {
  assert.deepEqual(parseLgimPaste("").rows, []);
  assert.match(parseLgimPaste("").warnings[0], /No fund prices found/);
  assert.deepEqual(parseLgimPaste("just some words\nand more words").rows, []);
  // A row whose price can't be read is skipped rather than imported as zero.
  const { rows } = parseLgimPaste("Citi UK Plan Odd Fund0.24%0.00%0.24%0.00p06/08/2026");
  assert.equal(rows.length, 0);
});
