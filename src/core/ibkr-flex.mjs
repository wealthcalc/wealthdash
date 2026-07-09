/* ======================================================================
   IBKR FLEX WEB SERVICE — LIVE PULL, client-side shaping.

   api/ibkr-flex.mjs proxies the two-step SendRequest -> GetStatement flow
   (CORS/credentials issue — has to run server-side) and hands back plain
   { normalisedAttrName: value } objects per Trade/CashTransaction/
   CashReportCurrency row. This module turns those into EXACTLY the same
   { trades, income, warnings, baseCurrency, format } shape parseIBKR()
   (core/ibkr-import.mjs) produces from a pasted CSV, by reusing that
   module's own row-mapping functions (ibTradeFromRow/ibCashFromRow) — so
   a live Flex pull and a pasted Flex/Activity CSV go through IDENTICAL
   FX/currency handling, wrapper defaulting, and needsFx flagging, and
   ImportTab's existing preview/dedupe/import UI works on either without
   caring which one produced it.

   IBKR has no concept of a UK ISA/SIPP/LISA/VCT wrapper — a Flex-sourced
   account is an ordinary taxable brokerage account, i.e. GIA — so
   `defaultWrapper` should normally stay "GIA"; the UI still lets the user
   override it, same as the pasted-CSV path, in case this is genuinely a
   sub-account of something else.
   ====================================================================== */
import { ibTradeFromRow, ibCashFromRow } from "./ibkr-import.mjs";

function getterFor(attrs) {
  return (...keys) => {
    for (const k of keys) {
      if (attrs[k] !== undefined && attrs[k] !== "") return attrs[k];
    }
    return undefined;
  };
}

// raw: { trades, cashTransactions, cashReport, openPositions } — the exact
// shape api/ibkr-flex.mjs returns.
export function shapeFlexPull(raw = {}, { defaultWrapper = "GIA", baseCurrency = "GBP" } = {}) {
  const warnings = [];
  const rawTrades = raw.trades || [];
  const rawCash = raw.cashTransactions || [];

  const trades = [];
  for (const attrs of rawTrades) {
    const t = ibTradeFromRow(getterFor(attrs), defaultWrapper, baseCurrency, warnings);
    if (t) trades.push(t);
  }
  const income = [];
  for (const attrs of rawCash) {
    const c = ibCashFromRow(getterFor(attrs), defaultWrapper, baseCurrency);
    if (c) income.push(c);
  }

  const needFx = trades.filter((t) => t.needsFx).length + income.filter((t) => t.needsFx).length;
  if (needFx) warnings.push(`${needFx} row(s) in a non-GBP currency need an FX rate; fetching by trade date.`);
  if (!rawTrades.length && !rawCash.length) {
    warnings.push("IBKR returned no Trade or Cash Transaction rows — check your Flex Query includes the Trades and Cash Transactions sections (Performance & Reports → Flex Queries).");
  }
  return { trades, income, warnings, baseCurrency, format: "flex" };
}

// Cash Report balances by currency — a reconciliation aid ("IBKR reports
// £X cash — does that match what's on the Wealth tab?"), not imported
// into anything automatically. IBKR includes a synthetic "BASE_SUMMARY"
// row (the whole account's cash converted to base currency) alongside the
// real per-currency rows — filtered out here since it isn't a currency.
export function shapeCashReport(raw = {}) {
  return (raw.cashReport || [])
    .filter((r) => r.currency && r.currency.toLowerCase() !== "base_summary")
    .map((r) => ({
      currency: r.currency.toUpperCase(),
      endingCash: +r.endingcash || 0,
      endingSettledCash: +r.endingsettledcash || 0,
    }));
}
