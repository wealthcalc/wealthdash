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
import { ibTradeFromRow, ibCashFromRow, ibDate } from "./ibkr-import.mjs";

function getterFor(attrs) {
  return (...keys) => {
    for (const k of keys) {
      if (attrs[k] !== undefined && attrs[k] !== "") return attrs[k];
    }
    return undefined;
  };
}

// InterestAccrualsCurrency rows -> income entries. A DIFFERENT shape from
// CashTransaction (interestAccrued not amount, fromDate/toDate not a
// settle date, no per-row symbol/isin — it's an account-level accrual, not
// a per-security cash movement) so this doesn't reuse ibCashFromRow; it's
// its own small mapping. IBKR includes a synthetic "BASE_SUMMARY" row (the
// whole account's accrual already converted to base currency) alongside
// any real per-currency rows — when real currency rows exist, those are
// used (each is its own genuine FX exposure); BASE_SUMMARY is only used
// as a fallback when it's the only row available, which is normal for a
// single-currency (e.g. all-GBP) account.
function shapeInterestAccruals(rows = [], { defaultWrapper = "GIA" } = {}) {
  const nonBase = rows.filter((r) => (r.currency || "").toUpperCase() !== "BASE_SUMMARY");
  const useRows = nonBase.length ? nonBase : rows.filter((r) => (r.currency || "").toUpperCase() === "BASE_SUMMARY");
  const out = [];
  for (const r of useRows) {
    const raw = +r.interestaccrued;
    if (!raw) continue; // zero accrual for the period — nothing to record
    const date = ibDate(r.todate || r.fromdate);
    if (!date) continue;
    const isBase = (r.currency || "").toUpperCase() === "BASE_SUMMARY";
    const amount = Math.round(Math.abs(raw) * 100) / 100;
    out.push({
      date, ticker: "", kind: "interest",
      nativeCurrency: isBase ? "GBP" : (r.currency || "GBP").toUpperCase(),
      nativeAmount: amount,
      fxRate: isBase || (r.currency || "").toUpperCase() === "GBP" ? 1 : null,
      amount: isBase || (r.currency || "").toUpperCase() === "GBP" ? amount : null,
      needsFx: !isBase && (r.currency || "").toUpperCase() !== "GBP",
      wrapper: defaultWrapper,
    });
  }
  return out;
}

// raw: { trades, cashTransactions, interestAccruals, cashReport,
// openPositions, fromDate, toDate, period } — the exact shape
// api/ibkr-flex.mjs returns.
export function shapeFlexPull(raw = {}, { defaultWrapper = "GIA", baseCurrency = "GBP" } = {}) {
  const warnings = [];
  const rawTrades = raw.trades || [];
  const rawCash = raw.cashTransactions || [];
  const rawInterest = raw.interestAccruals || [];

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
  const fromInterest = shapeInterestAccruals(rawInterest, { defaultWrapper });
  income.push(...fromInterest);

  const needFx = trades.filter((t) => t.needsFx).length + income.filter((t) => t.needsFx).length;
  if (needFx) warnings.push(`${needFx} row(s) in a non-GBP currency need an FX rate; fetching by trade date.`);

  // Diagnose an empty pull specifically, rather than one generic message —
  // "no rows at all" (check your Flex Query's sections), "rows exist but
  // the date range is a single day" (check the query's date period), and
  // "cash transactions absent but interest accruals came through" all need
  // a different fix from the user, and a flat "no rows found" doesn't
  // point at any of them.
  if (!trades.length && !income.length) {
    if (!rawTrades.length && !rawCash.length && !rawInterest.length) {
      warnings.push("IBKR returned no Trade, Cash Transaction, or Interest Accrual rows — check your Flex Query includes at least one of those sections (Performance & Reports → Flex Queries → edit your query).");
    } else {
      warnings.push("IBKR returned rows, but none produced an importable trade or income entry — likely a zero-value period. If you expected more, check the Flex Query's date range.");
    }
  } else if (!trades.length && rawTrades.length === 0 && raw.fromDate && raw.toDate && raw.fromDate === raw.toDate) {
    warnings.push(`This pull only covers ${raw.fromDate.slice(0, 4)}-${raw.fromDate.slice(4, 6)}-${raw.fromDate.slice(6, 8)} (period: ${raw.period || "single day"}) — no trades in that window isn't unusual. To pull your trade history, widen the Flex Query's date range in IBKR (Edit query → General Configuration → Date Period → e.g. "Last 365 Days" or a custom range).`);
  }
  if (rawInterest.length && !rawCash.length) {
    warnings.push("Your Flex Query has Interest Accruals but not Cash Transactions — interest is imported, but dividends won't come through until you add the Cash Transactions section too.");
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
