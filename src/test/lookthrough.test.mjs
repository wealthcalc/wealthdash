import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseExposurePaste, portfolioExposure, mixSimilarity, overlapMatrix, canonicalRegion,
} from "../core/lookthrough.mjs";

/* ---------------------------- paste parsing ---------------------------- */

test("parses a typical factsheet paste with tabs, %, and messy labels", () => {
  const { table, sum, warnings } = parseExposurePaste(
    "United States\t62.1%\nJapan  6.2\nUnited Kingdom: 3.5%\nEmerging Markets 9.8%\nCash and/or Derivatives 0.4%\n\nsome header line"
  );
  assert.equal(table.US, 62.1);
  assert.equal(table.Japan, 6.2);
  assert.equal(table.UK, 3.5);
  assert.equal(table["Emerging markets"], 9.8);
  assert.equal(table["Cash/other"], 0.4);
  assert.equal(sum, 82);
  assert.ok(warnings.some((w) => w.includes("some header line")));
  assert.ok(warnings.some((w) => w.includes("82%"))); // sum sanity warning
});

test("duplicate labels merge; canonicalisation maps aliases", () => {
  const { table } = parseExposurePaste("USA 30\nUnited States 32.5");
  assert.equal(table.US, 62.5);
  assert.equal(canonicalRegion("  ASIA PACIFIC EX JAPAN "), "Asia ex-Japan");
  assert.equal(canonicalRegion("Ruritania"), "Ruritania"); // unknown labels pass through
});

/* -------------------------- portfolio exposure ------------------------- */

const pos = (ticker, marketValue, priced = true) => ({ ticker, marketValue, priced });
const SECMETA = {
  VWRL: { exposure: { region: { "United States": 60, Japan: 6, "United Kingdom": 4, "Emerging Markets": 10, Other: 20 } } },
  SMT: { region: "Global" },          // hand tag only
  UKW: {},                            // nothing
};

test("blends exposure tables over hand tags over untagged, with coverage tiers", () => {
  const { buckets, coverage, total } = portfolioExposure({
    positions: [pos("VWRL", 10000), pos("SMT", 2000), pos("UKW", 1000)],
    secMeta: SECMETA, field: "region",
  });
  assert.equal(total, 13000);
  const by = Object.fromEntries(buckets.map((b) => [b.key, b.marketValue]));
  assert.equal(by.US, 6000);                 // 60% of 10k
  assert.equal(by.Japan, 600);
  assert.equal(by["Cash/other"], 2000);      // 20% "Other" line canonicalises to Cash/other
  assert.equal(by.Global, 2000);             // SMT's whole value via its tag
  assert.equal(by.untagged, 1000);           // UKW
  assert.ok(Math.abs(coverage.lookthroughPct - 10000 / 13000) < 1e-9);
  assert.ok(Math.abs(coverage.taggedPct - 2000 / 13000) < 1e-9);
  assert.ok(Math.abs(coverage.untaggedPct - 1000 / 13000) < 1e-9);
});

test("a table summing under 100% books the remainder to Cash/other, not a rescale", () => {
  const meta = { X: { exposure: { region: { "United States": 50 } } } };
  const { buckets } = portfolioExposure({ positions: [pos("X", 1000)], secMeta: meta, field: "region" });
  const by = Object.fromEntries(buckets.map((b) => [b.key, b.marketValue]));
  assert.equal(by.US, 500);
  assert.equal(by["Cash/other"], 500);
});

/* ------------------------------ similarity ----------------------------- */

test("mix similarity: identical mixes = 1, disjoint = 0, normalised first", () => {
  const a = { "United States": 60, Japan: 40 };
  assert.ok(Math.abs(mixSimilarity(a, { US: 30, Japan: 20 }) - 1) < 1e-9); // same mix, different scale
  assert.equal(mixSimilarity(a, { UK: 100 }), 0);
  const half = mixSimilarity(a, { "United States": 60, UK: 40 });
  assert.ok(Math.abs(half - 0.6) < 1e-9);
  assert.equal(mixSimilarity({}, a), null);
});

test("overlap matrix pairs only table-backed open holdings, most similar first", () => {
  const meta = {
    VWRL: { exposure: { region: { US: 60, Japan: 6, UK: 4, EM: 10, Other: 20 } } },
    SWDA: { exposure: { region: { US: 62, Japan: 6, UK: 4, Other: 28 } } },
    IUKD: { exposure: { region: { UK: 100 } } },
    SMT: { region: "Global" }, // tag only — excluded
  };
  const pairs = overlapMatrix({
    positions: [pos("VWRL", 1), pos("SWDA", 1), pos("IUKD", 1), pos("SMT", 1)],
    secMeta: meta,
  });
  assert.equal(pairs.length, 3); // 3 choose 2 among table-backed funds
  assert.deepEqual([pairs[0].a, pairs[0].b].sort(), ["SWDA", "VWRL"]);
  assert.ok(pairs[0].similarity > 0.8);
  assert.ok(pairs[pairs.length - 1].similarity < 0.2); // IUKD vs a world fund
});
