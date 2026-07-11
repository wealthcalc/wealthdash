/* ======================================================================
   FIDELITY UK TRANSACTION-HISTORY IMPORT — built against a REAL export
   (TransactionHistory.csv, July 2026), not documentation guesses. The
   format: ~6 metadata rows (account/timeframe/valuation), then a header
   `Order date,Completion date,Transaction type,Investments,Product
   Wrapper,Account Number,Source investment,Amount,Quantity,Price per
   unit,Reference Number,Status,` (note the trailing comma), dates as
   "06 Jul 2026", tickers embedded as the LAST parenthesised token of the
   security name ("GREENCOAT UK WIND PLC, ORD GBP0.01 (UKW)").

   The interesting Fidelity quirk: dealing charges are SEPARATE ROWS
   ("Dealing Fee", "Stamp Duty Or Financial Transaction Tax") with no
   security reference — only a shared account + order date with the trade
   they belong to. This maps exactly onto the ledger's `fees` field
   (Phase 2.5): when an order-date+account group holds EXACTLY ONE trade,
   its fee rows fold into that trade's `fees`; with several trades that
   day the attachment would be a guess, so the fees are surfaced as a
   warning instead of silently misassigned — same "don't fabricate"
   principle as everywhere else.

   Output shape is IDENTICAL to parseIBKR()/shapeFlexPull() — {trades,
   income, warnings} with the same field names — so the Import tab's
   existing preview, duplicate detection (Reference Number rides in the
   ibkrId slot) and import path are reused verbatim. Dates: trades use
   ORDER date (the contract date — what CGT disposal dates key off),
   income uses COMPLETION date (the payment date).
   Pure and node-tested (fidelity-import.test.mjs).
   ====================================================================== */
import { parseCSVRows } from "./ibkr-import.mjs";

const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

// "06 Jul 2026" -> "2026-07-06" (also tolerates already-ISO input).
export function fidelityDate(s) {
  const t = String(s || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1].padStart(2, "0")}` : null;
}

// Ticker = the LAST "(...)" group of the security name, if it looks like
// a symbol. "VANGUARD FUNDS PLC, ... (VHYL)" -> VHYL.
export function fidelityTicker(name) {
  const matches = [...String(name || "").matchAll(/\(([A-Z0-9.]{1,10})\)/g)];
  return matches.length ? matches[matches.length - 1][1] : "";
}

export function fidelityWrapper(productWrapper) {
  const w = String(productWrapper || "").toLowerCase();
  if (w.includes("isa")) return "ISA";
  if (w.includes("sipp") || w.includes("pension")) return "SIPP";
  return "GIA"; // Investment Account, Cash Management Account, unknown
}

const FEE_TYPES = new Set(["dealing fee", "stamp duty or financial transaction tax", "ptm levy", "foreign exchange charge"]);
const norm = (s) => String(s || "").trim().toLowerCase();
const num = (s) => { const v = parseFloat(String(s ?? "").replace(/[£,]/g, "")); return Number.isFinite(v) ? v : null; };

export function parseFidelity(text) {
  const rows = parseCSVRows(String(text || "").trim());
  const warnings = [];
  // Header can sit below a metadata preamble — find it by its landmarks.
  const hi = rows.findIndex((r) => {
    const cells = r.map(norm);
    return cells.includes("order date") && cells.includes("transaction type");
  });
  if (hi < 0) return { trades: [], income: [], warnings: ["No Fidelity header row found — expected columns like 'Order date' and 'Transaction type'."] };
  const header = rows[hi].map(norm);
  const col = (name) => header.indexOf(name);
  const C = {
    order: col("order date"), completion: col("completion date"), type: col("transaction type"),
    inv: col("investments"), wrapper: col("product wrapper"), account: col("account number"),
    source: col("source investment"), amount: col("amount"), qty: col("quantity"),
    ref: col("reference number"), status: col("status"),
  };

  const trades = [], income = [], feeEvents = [];
  const skipped = {}; // type -> count, for the summary warning
  let notCompleted = 0;

  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => !String(c || "").trim())) continue;
    const get = (idx) => (idx >= 0 && idx < r.length ? String(r[idx] ?? "").trim() : "");
    const status = norm(get(C.status));
    if (status && status !== "completed") { notCompleted++; continue; }
    const type = norm(get(C.type));
    const orderDate = fidelityDate(get(C.order));
    const payDate = fidelityDate(get(C.completion)) || orderDate;
    const wrapper = fidelityWrapper(get(C.wrapper));
    const account = get(C.account);
    const ref = get(C.ref);
    const amount = num(get(C.amount));

    if (type === "buy" || type === "sell") {
      const ticker = fidelityTicker(get(C.inv));
      const qty = Math.abs(num(get(C.qty)) ?? 0);
      if (!ticker) { warnings.push(`${get(C.order)}: ${type.toUpperCase()} row with no recognisable ticker in "${get(C.inv)}" — add it manually.`); continue; }
      if (!orderDate || !(qty > 0) || amount == null) { warnings.push(`${get(C.order)}: malformed ${type.toUpperCase()} row for ${ticker} — skipped.`); continue; }
      trades.push({
        date: orderDate, ticker, isin: "", side: type.toUpperCase(),
        quantity: qty, nativeCurrency: "GBP", nativeAmount: Math.abs(amount), fxRate: 1,
        gbpAmount: Math.round(Math.abs(amount) * 100) / 100, needsFx: false,
        wrapper, account: account ? `Fidelity ${account}` : "Fidelity",
        fees: 0, ibkrId: ref ? `FID-${ref}` : null, source: "Fidelity UK",
      });
    } else if (FEE_TYPES.has(type)) {
      if (orderDate && amount != null && Math.abs(amount) > 0) {
        feeEvents.push({ date: orderDate, account, amount: Math.abs(amount), label: get(C.type) });
      }
    } else if (type === "cash dividend") {
      const ticker = fidelityTicker(get(C.source));
      if (payDate && amount != null && amount > 0) {
        income.push({
          date: payDate, ticker, isin: "", kind: "dividend",
          nativeCurrency: "GBP", nativeAmount: amount, fxRate: 1,
          amount: Math.round(amount * 100) / 100, needsFx: false,
          wrapper, ibkrId: ref ? `FID-${ref}` : null, source: "Fidelity UK",
        });
      }
    } else if (type === "cash interest") {
      if (payDate && amount != null && amount > 0) {
        income.push({
          date: payDate, ticker: "", isin: "", kind: "interest",
          nativeCurrency: "GBP", nativeAmount: amount, fxRate: 1,
          amount: Math.round(amount * 100) / 100, needsFx: false,
          wrapper, ibkrId: ref ? `FID-${ref}` : null, source: "Fidelity UK",
        });
      }
    } else if (type) {
      // Cash In/Out, transfers, Service Fee (an account charge, not a
      // dealing cost), Tax On Interest, etc — counted, never silently lost.
      skipped[get(C.type)] = (skipped[get(C.type)] || 0) + 1;
    }
  }

  // Attach fee rows to trades sharing (account, order date) — only when
  // the attachment is unambiguous.
  const groups = new Map();
  for (const t of trades) {
    const k = `${t.account}|${t.date}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(t);
  }
  for (const f of feeEvents) {
    const k = `${f.account ? `Fidelity ${f.account}` : "Fidelity"}|${f.date}`;
    const g = groups.get(k) || [];
    if (g.length === 1) g[0].fees = Math.round((g[0].fees + f.amount) * 100) / 100;
    else warnings.push(`${f.date}: ${f.label} of £${f.amount.toFixed(2)} couldn't be attached ${g.length === 0 ? "— no trade that day in that account" : `— ${g.length} trades that day, ambiguous`}; add it to the right trade's Fees manually.`);
  }

  const skippedSummary = Object.entries(skipped).map(([t, n]) => `${n}× ${t}`).join(", ");
  if (skippedSummary) warnings.push(`Skipped non-trade cash rows (by design): ${skippedSummary}.`);
  if (notCompleted) warnings.push(`${notCompleted} row(s) not marked Completed — skipped.`);
  return { trades, income, warnings };
}
