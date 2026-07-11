import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFidelity, fidelityDate, fidelityTicker, fidelityWrapper } from "../core/fidelity-import.mjs";

const FIXTURE = readFileSync(new URL("./fidelity-fixture.csv", import.meta.url), "utf8");

test("date, ticker and wrapper primitives", () => {
  assert.equal(fidelityDate("06 Jul 2026"), "2026-07-06");
  assert.equal(fidelityDate("2026-07-06"), "2026-07-06");
  assert.equal(fidelityDate("garbage"), null);
  assert.equal(fidelityTicker("VANGUARD FUNDS PLC, FTSE ALL WLD HIGH DIV YLD UCITS ETF USD (VHYL)"), "VHYL");
  assert.equal(fidelityTicker("GREENCOAT UK WIND PLC, ORD GBP0.01 (UKW)"), "UKW");
  assert.equal(fidelityTicker("SOME FUND WITH NO SYMBOL"), "");
  assert.equal(fidelityWrapper("Investment ISA"), "ISA");
  assert.equal(fidelityWrapper("Investment Account"), "GIA");
  assert.equal(fidelityWrapper("SIPP"), "SIPP");
});

test("parses trades with order-date, GBP consideration and account label", () => {
  const { trades } = parseFidelity(FIXTURE);
  const ukw = trades.find((t) => t.ticker === "UKW");
  assert.equal(ukw.date, "2026-07-06"); // ORDER date (contract date), not completion
  assert.equal(ukw.side, "BUY");
  assert.equal(ukw.quantity, 3921);
  assert.equal(ukw.gbpAmount, 4078.93);
  assert.equal(ukw.wrapper, "ISA");
  assert.equal(ukw.account, "Fidelity AS00000001");
  assert.equal(ukw.ibkrId, "FID-9000000006"); // Reference Number rides the dedupe slot
  const ko = trades.find((t) => t.ticker === "KO");
  assert.equal(ko.side, "SELL");
});

test("fee rows fold into the day's single trade; ambiguous days warn instead", () => {
  const { trades, warnings } = parseFidelity(FIXTURE);
  const ukw = trades.find((t) => t.ticker === "UKW");
  assert.ok(Math.abs(ukw.fees - 27.76) < 1e-9); // 7.50 dealing + 20.26 stamp duty
  // 05 Jun: TWO trades (IMB buy + KO sell) in the same account/day — the
  // £7.50 dealing fee must NOT be guessed onto one of them.
  const imb = trades.find((t) => t.ticker === "IMB");
  assert.equal(imb.fees, 0);
  assert.ok(warnings.some((w) => w.includes("2 trades that day")), warnings.join("\n"));
});

test("dividends use completion date and the Source investment ticker; interest has no ticker", () => {
  const { income } = parseFidelity(FIXTURE);
  const vhyl = income.find((e) => e.ticker === "VHYL");
  assert.equal(vhyl.kind, "dividend");
  assert.equal(vhyl.date, "2026-07-01"); // completion (payment) date < order date here
  assert.equal(vhyl.amount, 505.99);
  const interest = income.filter((e) => e.kind === "interest");
  assert.equal(interest.length, 2);
  assert.ok(interest.every((e) => e.ticker === ""));
  // dividends across wrappers both captured (ISA + GIA)
  assert.equal(income.filter((e) => e.kind === "dividend").length, 3);
});

test("cash movements/fees-on-account are counted, cancelled rows skipped, no-ticker buys warned", () => {
  const { trades, warnings } = parseFidelity(FIXTURE);
  assert.equal(trades.length, 3); // UKW, IMB, KO — cancelled IMB and no-symbol fund excluded
  assert.ok(warnings.some((w) => w.includes("no recognisable ticker")));
  assert.ok(warnings.some((w) => w.includes("not marked Completed")));
  const summary = warnings.find((w) => w.startsWith("Skipped non-trade cash rows"));
  assert.ok(summary.includes("Cash Out For Buy"));
  assert.ok(summary.includes("Service Fee"));
  assert.ok(summary.includes("Tax On Interest"));
});

test("junk input degrades to a clear warning", () => {
  const r = parseFidelity("this,is,not\na,fidelity,file");
  assert.deepEqual(r.trades, []);
  assert.ok(r.warnings[0].includes("No Fidelity header row"));
});
