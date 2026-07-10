/* Shared UI primitives, formatters, price/FX fetch helpers and seed data —
   extracted verbatim from CgtDashboard.jsx (UI split, phase 1). */
import React, { useState, useMemo, useCallback, useRef } from "react";
import { dedupeAgainstExisting as _dedupeAgainstExisting } from "../core/dedupe.mjs";

// Safe localStorage wrapper: persists on the deployed app, silently no-ops in
// sandboxed preview frames where storage access throws.
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sandbox */ } },
};


const fmtRate = (r) => `${(r * 100).toFixed(0)}%`;
const unitsHeldAt = (txns, dateStr, ticker) => {
  const want = ticker ? String(ticker).toUpperCase() : null;
  let q = 0; for (const t of txns) { if (t.side !== "BUY" && t.side !== "SELL") continue; if (want && String(t.ticker || "").toUpperCase() !== want) continue; if (t.date <= dateStr) q += (t.side === "BUY" ? 1 : -1) * t.quantity; } return q;
};

// Seed ISIN/domicile data for holdings, sourced from issuer fact sheets. Only
// covers tickers actually held (per the 2026-07 GIA ledger import); anything
// else is left blank for the user to fill in. `eri` flags offshore reporting
// funds (Irish/Lux-domiciled accumulating ETFs) that generate excess reportable
// income when held unsheltered; UK investment trusts are ordinary companies and
// pay ordinary dividends, not ERI, even though they accumulate/reinvest.
const SECURITY_SEED = {
  SJPA: { isin: "IE00B4L5YX21", name: "iShares Core MSCI Japan IMI UCITS ETF (Acc)", domicile: "IE", eri: true },
  CSP1: { isin: "IE00B5BMR087", name: "iShares Core S&P 500 UCITS ETF (Acc)", domicile: "IE", eri: true },
  EMIM: { isin: "IE00BKM4GZ66", name: "iShares Core MSCI EM IMI UCITS ETF (Acc)", domicile: "IE", eri: true },
  XNAQ: { isin: "IE00BMFKG444", name: "Xtrackers Nasdaq 100 UCITS ETF 1C", domicile: "IE", eri: true },
  UIFS: { isin: "IE00B4JNQZ49", name: "iShares S&P 500 Financials Sector UCITS ETF (Acc)", domicile: "IE", eri: true },
  HSTC: { isin: "IE00BMWXKN31", name: "HSBC Hang Seng TECH UCITS ETF", domicile: "IE", eri: true },
  IITU: { isin: "IE00B3WJKG14", name: "iShares S&P 500 Information Technology Sector UCITS ETF (Acc)", domicile: "IE", eri: true },
  SPXL: { isin: "IE000XZSV718", name: "SPDR S&P 500 UCITS ETF (Acc)", domicile: "IE", eri: true },
  SMT: { isin: "GB00BLDYK618", name: "Scottish Mortgage Investment Trust plc", domicile: "GB", eri: false, kind: "investment_trust" },
  ATT: { isin: "GB00BNG2M159", name: "Allianz Technology Trust plc", domicile: "GB", eri: false, kind: "investment_trust" },
  BNKR: { isin: "GB00BN4NDR39", name: "Bankers Investment Trust plc", domicile: "GB", eri: false, kind: "investment_trust" },
  AIAG: { isin: "IE00BK5BCD43", name: "iShares AI & Automation Growth UCITS ETF", domicile: "IE", eri: true },
  CYSE: { isin: "IE00BLPK3577", name: "iShares Cybersecurity UCITS ETF", domicile: "IE", eri: true },
  DFEU: { isin: "IE000IAXNM41", name: "Defense Europe UCITS ETF", domicile: "IE", eri: true },
  RBTX: { isin: "IE00BYZK4552", name: "iShares Robotics & Automation UCITS ETF", domicile: "IE", eri: true },
  RENG: { isin: "IE00BK5BCH80", name: "iShares Renewable Energy UCITS ETF", domicile: "IE", eri: true },
  // Closed positions (fully disposed) — kept for ERI matching on the years they
  // were actually held; a closed position can still owe ERI for any accounting
  // period that fell inside its holding window.
  SWDA: { isin: "IE00B4L5Y983", name: "iShares Core MSCI World UCITS ETF (Acc)", domicile: "IE", eri: true },
  CNX1: { isin: "IE00B53SZB19", name: "iShares NASDAQ 100 UCITS ETF (Acc)", domicile: "IE", eri: true },
  DGIT: { isin: "IE00BYZK4883", name: "iShares Digitalisation UCITS ETF (Acc)", domicile: "IE", eri: true },
  USDV: { isin: "IE00B6YX5D40", name: "SPDR S&P US Dividend Aristocrats UCITS ETF (Dist)", domicile: "IE", eri: true },
  SAIC: { isin: "GB0007873697", name: "Scottish American Investment Company plc", domicile: "GB", eri: false, kind: "investment_trust" },
  // Individual gilts (kind: "gilt" -> CGT-exempt via TCGA 1992 s115; coupons
  // taxable as interest in taxable wrappers). coupon = annual %, semi-annual
  // payments on the cycle anchored at maturity. Identifiers verified 2026-07
  // against multiple sources (LSE/TradingView/broker listings). Register any
  // other gilt from the Gilts tab.
  TN28: { isin: "GB00BMBL1G81", name: "0⅛% Treasury Gilt 2028", domicile: "GB", eri: false, kind: "gilt", coupon: 0.125, maturity: "2028-01-31" },
  TG31: { isin: "GB00BMGR2809", name: "0¼% Treasury Gilt 2031", domicile: "GB", eri: false, kind: "gilt", coupon: 0.25, maturity: "2031-07-31" },
  T26A: { isin: "GB00BNNGP668", name: "0⅜% Treasury Gilt 2026", domicile: "GB", eri: false, kind: "gilt", coupon: 0.375, maturity: "2026-10-22" },
};


/* ----------------------------- helpers ------------------------------ */
const gbp = (x) => (x < 0 ? "−£" : "£") + Math.abs(x).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gbp0 = (x) => (x < 0 ? "−£" : "£") + Math.round(Math.abs(x)).toLocaleString("en-GB");
// One chip style per wrapper, used everywhere a wrapper tag is shown, so
// adding a wrapper (like VCT) means updating one place, not three.
const WRAPPER_CHIP_CLASS = {
  GIA: "bg-[var(--chip)] text-[var(--fg)]",
  ISA: "bg-[color:color-mix(in_srgb,var(--gain)_18%,transparent)] text-[var(--gain)]",
  SIPP: "bg-[color:color-mix(in_srgb,var(--gain)_18%,transparent)] text-[var(--gain)]",
  LISA: "bg-[color:color-mix(in_srgb,var(--gain)_18%,transparent)] text-[var(--gain)]",
  VCT: "bg-[color:color-mix(in_srgb,var(--m-same)_18%,transparent)] text-[var(--m-same)]",
};
const wrapperChipClass = (w) => WRAPPER_CHIP_CLASS[w] || "bg-[color:color-mix(in_srgb,var(--m-bb)_18%,transparent)] text-[var(--m-bb)]";
const WrapperChip = ({ wrapper }) => <span className={"text-[10px] font-semibold px-1.5 py-0.5 rounded " + wrapperChipClass(wrapper)}>{wrapper}</span>;

// Shared sub-tab bar, used inside the CGT and Income mega-tabs so related
// tools live under one top-level tab instead of cluttering the main nav.
function SubTabs({ tabs, active, onChange }) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1 border-b border-[var(--border)] mb-4">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={active === k} onClick={() => onChange(k)}
          className={"px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition " +
            (active === k ? "border-[var(--accent)] text-[var(--fg)]" : "border-transparent text-[var(--muted)] hover:text-[var(--fg)]")}>
          {label}
        </button>
      ))}
    </div>
  );
}

// DD/MM/YYYY (DMO's format) -> ISO (YYYY-MM-DD), for comparing/storing report dates.
const dmoDateToIso = (ddmmyyyy) => { const [d, m, y] = ddmmyyyy.split("/"); return `${y}-${m}-${d}`; };

// Shared DMO gilt-price fetch, used by both the Gilts tab and the Wealth tab's
// live-prices panel (individual gilts aren't on Yahoo/Alpha Vantage, so they
// need the DMO proxy). Given [{ticker, isin}] targets, fetches clean prices and
// returns { pricesByTicker: {tk: clean/100}, matched, date }. Clean price is
// per £100 nominal; the app stores price per £1 nominal, hence /100.
//
// DMO publishes ONE report per business day (~2pm) — once we already have
// today's report, a re-fetch is guaranteed to return identical data. Pass
// `knownReportDate` (the ISO date of the last report already fetched) and
// this skips the network round-trip entirely unless `force` is set.
async function fetchDmoGiltPrices(targets, { knownReportDate, force = false } = {}) {
  const todayIso = todayISO();
  if (!force && knownReportDate === todayIso) {
    return { pricesByTicker: {}, matched: 0, date: null, total: 0, skipped: true, knownReportDate };
  }
  const withIsin = targets.filter((t) => t.isin);
  if (!withIsin.length) return { pricesByTicker: {}, matched: 0, date: null, error: "No gilt has an ISIN to look up." };
  const isins = withIsin.map((t) => t.isin).join(",");
  const r = await fetch(`/api/gilt-prices?isins=${encodeURIComponent(isins)}`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  const pricesByTicker = {};
  let matched = 0;
  for (const t of withIsin) {
    const hit = body.prices[t.isin];
    if (hit) { pricesByTicker[t.ticker] = hit.clean / 100; matched++; }
  }
  return { pricesByTicker, matched, date: body.date, reportDateIso: body.date ? dmoDateToIso(body.date) : null, total: withIsin.length };
}
const num = (x, dp = 2) => (x ?? 0).toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const round2 = (x) => Math.round((+x || 0) * 100) / 100;

// £-prefixed input with thousands separators while not focused, plain
// editable number while focused (so typing isn't fighting live formatting).
// Used for cash balances, where "£73,137.00" is much easier to read at a
// glance than a bare "73137".
function CurrencyInput({ value, onChange, className = "" }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(String(value ?? 0));
  React.useEffect(() => { if (!editing) setRaw(String(value ?? 0)); }, [value, editing]);
  return (
    <div className={"relative " + className}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted)] text-sm">£</span>
      <input
        type={editing ? "number" : "text"}
        className="input num w-full pl-5 text-right"
        value={editing ? raw : num(+value || 0, 2)}
        onFocus={() => { setEditing(true); setRaw(String(value ?? 0)); }}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => { setEditing(false); onChange(+raw || 0); }}
      />
    </div>
  );
}
// Same show-formatted/edit-plain pattern as CurrencyInput, but for
// non-currency numbers (quantities, FX-converted amounts not in GBP) —
// thousands separators while not focused, no £ prefix, decimals preserved
// (quantities are often fractional, e.g. DRIP shares).
function NumberInput({ value, onChange, className = "", dp = 2, disabled = false }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(String(value ?? 0));
  React.useEffect(() => { if (!editing) setRaw(String(value ?? 0)); }, [value, editing]);
  const display = () => {
    const v = +value || 0;
    const decimals = v % 1 ? Math.min(dp, 6) : 0;
    return num(v, decimals);
  };
  return (
    <input
      type={editing ? "number" : "text"}
      disabled={disabled}
      className={"input num text-right disabled:opacity-50 " + className}
      value={editing ? raw : display()}
      onFocus={() => { setEditing(true); setRaw(String(value ?? 0)); }}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => { setEditing(false); onChange(+raw || 0); }}
    />
  );
}
const uid = () => Math.random().toString(36).slice(2, 9);
const todayISO = () => new Date().toISOString().slice(0, 10);

const SAMPLE = [
  { id: uid(), date: "2022-11-15", ticker: "WFC", side: "BUY", quantity: 120, nativeCurrency: "USD", nativeAmount: 5036, fxRate: 0.83, gbpAmount: 4180, note: "RSU vest" },
  { id: uid(), date: "2023-11-15", ticker: "WFC", side: "BUY", quantity: 140, nativeCurrency: "USD", nativeAmount: 6650, fxRate: 0.80, gbpAmount: 5320, note: "RSU vest" },
  { id: uid(), date: "2024-11-15", ticker: "WFC", side: "BUY", quantity: 160, nativeCurrency: "USD", nativeAmount: 11544, fxRate: 0.79, gbpAmount: 9120, note: "RSU vest" },
  { id: uid(), date: "2025-06-02", ticker: "WFC", side: "SELL", quantity: 200, nativeCurrency: "USD", nativeAmount: 18718, fxRate: 0.78, gbpAmount: 14600, note: "part sale" },
  { id: uid(), date: "2015-08-03", ticker: "AAPL", side: "BUY", quantity: 100, nativeCurrency: "USD", nativeAmount: 11500, fxRate: 0.64, gbpAmount: 7360, note: "" },
  { id: uid(), date: "2022-09-01", ticker: "AAPL", side: "SELL", quantity: 20, nativeCurrency: "USD", nativeAmount: 3200, fxRate: 0.86, gbpAmount: 2752, note: "" },
  { id: uid(), date: "2024-09-15", ticker: "AAPL", side: "SELL", quantity: 25, nativeCurrency: "USD", nativeAmount: 5500, fxRate: 0.76, gbpAmount: 4180, note: "pre-Budget" },
  { id: uid(), date: "2025-09-10", ticker: "AAPL", side: "SELL", quantity: 30, nativeCurrency: "USD", nativeAmount: 6900, fxRate: 0.74, gbpAmount: 5106, note: "" },
];

const METHOD = {
  SAME_DAY: { label: "Same-day", v: "--m-same" },
  THIRTY_DAY: { label: "30-day", v: "--m-bb" },
  SECTION_104: { label: "S104 pool", v: "--m-pool" },
};

/* ---- Alpha Vantage live prices (client-side; free tier: 25/day, 5/min) ----
   GLOBAL_QUOTE returns a price but NO currency, so the currency is set per
   ticker and every quote is normalised to GBP (GBp pence ÷100; USD/EUR via FX). */
const AV_URL = "https://www.alphavantage.co/query";
async function avQuote(symbol, key) {
  const res = await fetch(`${AV_URL}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`);
  const j = await res.json();
  if (j.Note || j.Information) throw new Error("Alpha Vantage limit hit (25/day, 5/min) — try again later.");
  const q = j["Global Quote"];
  const p = q && q["05. price"];
  if (p == null || p === "") throw new Error(`No quote for "${symbol}" (LSE symbols need .LON).`);
  return parseFloat(p);
}
/* ---- FX rate resolution: three-tier fallback.
   1. Frankfurter (frankfurter.dev) — primary, free, no key, no shared budget.
   2. Yahoo Finance, via the /api/fx serverless proxy — same infra as live
      prices, covers gaps when Frankfurter lacks a date/pair or is down.
   3. Alpha Vantage FX_DAILY — last resort, since it shares the same 25/day
      budget as equity price lookups (see avBudget/avBump below).
   All three return the same thing: GBP per 1 unit of the given currency. ---- */
async function fxViaFrankfurter(ccy, date) {
  try { const r = await fetch(`https://api.frankfurter.dev/v1/${date}?from=${ccy}&to=GBP`); const j = await r.json(); return j?.rates?.GBP ?? null; }
  catch { return null; }
}
async function fxViaYahoo(ccy, date) {
  try { const r = await fetch(`/api/fx?ccy=${encodeURIComponent(ccy)}&date=${encodeURIComponent(date)}`); if (!r.ok) return null; const j = await r.json(); return j?.rate ?? null; }
  catch { return null; }
}
async function fxViaAlphaVantage(ccy, date, key) {
  if (!key) return null;
  try {
    const res = await fetch(`${AV_URL}?function=FX_DAILY&from_symbol=${encodeURIComponent(ccy)}&to_symbol=GBP&apikey=${encodeURIComponent(key)}`);
    const j = await res.json();
    if (j.Note || j.Information) return null; // rate limit or bad key — fail soft, let the caller try elsewhere
    const series = j["Time Series FX (Daily)"];
    if (!series) return null;
    const onOrBefore = Object.keys(series).filter((d) => d <= date).sort();
    const pick = onOrBefore.length ? onOrBefore[onOrBefore.length - 1] : Object.keys(series).sort()[0];
    const close = pick && series[pick] && series[pick]["4. close"];
    return close ? parseFloat(close) : null;
  } catch { return null; }
}
async function fxHistorical(ccy, date) {
  if (ccy === "GBP" || ccy === "GBp") return 1;
  let rate = await fxViaFrankfurter(ccy, date);
  if (rate) return rate;
  rate = await fxViaYahoo(ccy, date);
  if (rate) return rate;
  const key = store.get("cgt.avkey", "");
  if (key && avBudget().n < 25) {
    rate = await fxViaAlphaVantage(ccy, date, key);
    if (rate) { avBump(); return rate; }
  }
  return null;
}
async function fxToGBP(ccy) {
  if (ccy === "GBP" || ccy === "GBp") return 1;
  return fxHistorical(ccy, todayISO());
}
const toGBP = (raw, ccy, fx) => (ccy === "GBp" ? raw / 100 : ccy === "GBP" ? raw : fx ? raw * fx : null);
const avBudget = () => { const c = store.get("cgt.avcount", { date: "", n: 0 }); return c.date === todayISO() ? c : { date: todayISO(), n: 0 }; };
const avBump = () => { const c = avBudget(); c.n += 1; store.set("cgt.avcount", c); return c.n; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KIND_LABEL = { equity: "Equities", fund: "Funds (ETF)", investment_trust: "Investment trusts", gilt: "Gilts", bond_fund: "Bond funds", cash: "Cash", unknown: "Unclassified" };
const ALLOC_COLORS = ["var(--accent)", "var(--m-same)", "var(--m-bb)", "var(--gain)", "var(--m-pool)", "var(--loss)"];

function AllocBar({ title, buckets, labelOf = (k) => k }) {
  if (!buckets.length) return null;
  return (
    <div>
      <div className="text-xs font-medium text-[var(--muted)] mb-1.5">{title}</div>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-[var(--panel2)]">
        {buckets.map((b, i) => (
          <div key={b.key} title={`${labelOf(b.key)}: ${gbp(b.marketValue)} (${num(b.pct * 100, 1)}%)`}
            style={{ width: `${Math.max(b.pct * 100, 0.5)}%`, background: ALLOC_COLORS[i % ALLOC_COLORS.length] }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-xs">
        {buckets.map((b, i) => (
          <span key={b.key} className="flex items-center gap-1 text-[var(--muted)]">
            <span className="w-2 h-2 rounded-full inline-block" style={{ background: ALLOC_COLORS[i % ALLOC_COLORS.length] }} />
            {labelOf(b.key)} <span className="num">{num(b.pct * 100, 1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}



/* --------------------------- Returns tab ---------------------------- */
// Returns & income analytics (build step 3). Pure view over computeReturns()
// (core/returns.mjs) — XIRR everywhere, per-holding TWR, snapshot-based
// portfolio TWR, trailing vs forward income yields. Everything pre-tax.
const pct = (x, dp = 1) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${num(x * 100, dp)}%`);
const pctPlain = (x, dp = 2) => (x == null ? "—" : `${num(x * 100, dp)}%`);
const toneOf = (x) => (x == null ? undefined : x >= 0 ? "gain" : "loss");
const SHORT_SPAN = 90; // days below which an annualised rate is mostly noise

// Annualised rates over short spans explode (2 days of +1% annualises to
// six figures) — that's a solver artefact, not information. Below SHORT_SPAN
// days, or beyond ±1,000%/yr, show n/a with the reason instead of the number.
const ABSURD_RATE = 10; // |rate| > 1,000%/yr
const rateIsDisplayable = (r) =>
  r && r.rate != null && (r.spanDays ?? 9999) >= SHORT_SPAN && Math.abs(r.rate) <= ABSURD_RATE;

function RateCell({ r }) {
  if (!r || r.rate == null) return <span className="text-[var(--muted)]" title={r?.reason || ""}>—</span>;
  if (!rateIsDisplayable(r)) {
    const why = (r.spanDays ?? 9999) < SHORT_SPAN
      ? `Only ${r.spanDays} day${r.spanDays === 1 ? "" : "s"} of history — annualising this young a position produces meaningless numbers. Shows once ${SHORT_SPAN} days exist.`
      : "Annualised rate beyond ±1,000%/yr — a solver artefact of a near-zero time span or extreme cashflows, not a real return.";
    return <span className="text-[var(--muted)]" title={why}>n/a</span>;
  }
  return (
    <span className={"num " + (r.rate >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}
      title={`${r.spanDays} days of history`}>
      {pct(r.rate)}
    </span>
  );
}

/* ----------------------------- import dedupe -------------------------- */
// Logic moved to core/dedupe.mjs (pure, node-tested) — re-exported here
// under the same name so every existing caller in this file is unaffected.
const dedupeAgainstExisting = _dedupeAgainstExisting;

/* ------------------------- sortable table headers -------------------- */
// Generic click-to-sort support shared by every data table in the app
// (Transactions, Holdings, Gilts, Returns, Income). `useSort` just tracks
// {key, dir}; clicking the currently-active column flips direction, clicking
// a new one resets to ascending. `sortRows` sorts with per-column accessor
// functions rather than baking comparison logic into each tab, and always
// pushes null/undefined/"" values (unpriced holdings, unresolved FX, etc.)
// to the end regardless of direction, so a blank cell never jumps to the
// top just because it's "smaller" than a number.
function useSort(defaultKey, defaultDir = "asc") {
  const [sort, setSort] = useState({ key: defaultKey, dir: defaultDir });
  const toggleSort = useCallback((key) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }, []);
  return [sort, toggleSort];
}
function sortRows(rows, sort, accessors) {
  const get = sort && accessors[sort.key];
  if (!get) return rows;
  const withKey = rows.map((r) => ({ r, v: get(r) }));
  withKey.sort((a, b) => {
    const av = a.v, bv = b.v;
    const aNull = av == null || av === "";
    const bNull = bv == null || bv === "";
    if (aNull && bNull) return 0;
    if (aNull) return 1;  // nulls/blanks always last, in either direction
    if (bNull) return -1;
    const cmp = typeof av === "string" || typeof bv === "string"
      ? String(av).localeCompare(String(bv))
      : (av < bv ? -1 : av > bv ? 1 : 0);
    return sort.dir === "asc" ? cmp : -cmp;
  });
  return withKey.map((x) => x.r);
}
// Drop-in <th> — pass the same padding/alignment classes the table already
// used (this repo's tables aren't all padded identically), plus an `id` that
// matches a key in the `accessors` object passed to sortRows.
// A plain onClick on a `<th>` (the original implementation) is invisible to
// keyboard and screen-reader users — a `<th>` isn't natively focusable or
// operable, so there was no way to sort a table without a mouse. Fixed by
// putting a real `<button>` inside (native keyboard support for free: Tab,
// Enter, Space) and exposing sort state via `aria-sort` on the `<th>` itself,
// the attribute assistive tech actually looks at for "this column is sorted".
function SortTh({ id, label, sort, onSort, align = "left", className = "" }) {
  const active = sort.key === id;
  const dir = active ? sort.dir : null;
  const arrow = active ? (dir === "desc" ? "▼" : "▲") : "";
  const ariaSort = active ? (dir === "desc" ? "descending" : "ascending") : "none";
  return (
    <th scope="col" aria-sort={ariaSort} className={"whitespace-nowrap " + (align === "right" ? "text-right" : "text-left") + " " + className}>
      <button type="button" onClick={() => onSort(id)}
        aria-label={`Sort by ${label}${active ? `, currently ${dir === "desc" ? "descending" : "ascending"}` : ""}`}
        className={"inline-flex items-center gap-1 bg-transparent border-0 p-0 m-0 font-inherit cursor-pointer select-none hover:text-[var(--fg)] " + (align === "right" ? "flex-row-reverse" : "")}>
        {label}{arrow && <span aria-hidden="true" className="text-[8px] text-[var(--accent)]">{arrow}</span>}
      </button>
    </th>
  );
}

/* ----------------------------- atoms -------------------------------- */
// `title` alone is an unreliable accessible name (some browser/AT
// combinations don't expose it as one at all) — every IconBtn caller passes
// `title` for the visible tooltip, so this derives `aria-label` from it
// automatically rather than requiring every call site to pass both.
function IconBtn({ children, as = "button", title, "aria-label": ariaLabel, ...p }) {
  const C = as;
  return <C {...p} title={title} aria-label={ariaLabel || title} className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)] text-[var(--fg)] cursor-pointer">{children}</C>;
}
function Field({ label, children }) {
  return <label className="flex flex-col gap-1"><span className="text-xs text-[var(--muted)]">{label}</span>{children}</label>;
}
function Stat({ label, value, sub, tone, big }) {
  const c = tone === "gain" ? "text-[var(--gain)]" : tone === "loss" ? "text-[var(--loss)]" : "text-[var(--fg)]";
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className={`num font-semibold ${big ? "text-2xl" : "text-lg"} ${c} mt-0.5`}>{value}</div>
      {sub && <div className="text-xs text-[var(--muted)] mt-0.5">{sub}</div>}
    </div>
  );
}
function Row({ k, v, tone, bold }) {
  const c = tone === "gain" ? "text-[var(--gain)]" : tone === "loss" ? "text-[var(--loss)]" : "";
  return <div className="flex justify-between"><span className="text-[var(--muted)] font-sans">{k}</span><span className={`${c} ${bold ? "font-semibold" : ""}`}>{v}</span></div>;
}
function MethodChip({ m }) {
  const d = METHOD[m];
  return <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ color: `var(${d.v})`, background: "var(--chip)" }}>{d.label}</span>;
}
function Empty({ msg }) {
  return <div className="rounded-xl border border-dashed border-[var(--border)] py-12 text-center text-sm text-[var(--muted)]">{msg}</div>;
}
// Two-step delete (click again within 4s to confirm) instead of a browser
// confirm() dialog, which doesn't behave consistently across embedding
// contexts — same pattern used for pension-provider removal, promoted here
// once a second tab (Property) needed the identical thing.
function TwoStepDelete({ onConfirm, label = "Delete" }) {
  const [confirming, setConfirming] = useState(false);
  React.useEffect(() => { if (confirming) { const t = setTimeout(() => setConfirming(false), 4000); return () => clearTimeout(t); } }, [confirming]);
  return confirming ? (
    <button onClick={onConfirm} className="text-xs text-[var(--loss)] font-semibold underline decoration-dotted" aria-label={`Confirm: ${label}`}>Click to confirm</button>
  ) : (
    <button onClick={() => setConfirming(true)} className="text-[var(--muted)] hover:text-[var(--loss)]" title={label} aria-label={label}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
    </button>
  );
}

/* inline utility classes used above */
// Guarded end-to-end so this module can load outside a browser (tests / SSR
// smoke renders) — the original guarded only appendChild, not createElement.
const _style = typeof document !== "undefined" ? document.createElement("style") : null;
if (_style) _style.textContent = `
  .input{background:var(--panel2);border:1px solid var(--border);border-radius:.5rem;padding:.4rem .6rem;font-size:.875rem;color:var(--fg);outline:none;box-sizing:border-box;line-height:1.25}
  input.input,select.input{height:2.25rem}
  textarea.input{min-height:9rem;line-height:1.5;resize:vertical}
  .input:focus{border-color:var(--accent)}
  select.input{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%23888' stroke-width='1.5'%3e%3cpath d='M5 7.5l5 5 5-5'/%3e%3c/svg%3e");background-repeat:no-repeat;background-position:right .5rem center;background-size:1rem;padding-right:1.75rem}
  .btn-accent{display:inline-flex;align-items:center;gap:.4rem;background:var(--accent);color:var(--accent-fg);font-size:.875rem;font-weight:600;padding:.45rem .8rem;border-radius:.5rem;cursor:pointer;height:2.25rem;box-sizing:border-box}
  .btn-accent:hover{opacity:.92}
`;
if (_style && !document.getElementById("cgt-util")) { _style.id = "cgt-util"; document.head.appendChild(_style); }

export {
  store, fmtRate, unitsHeldAt, SECURITY_SEED, gbp, gbp0,
  WRAPPER_CHIP_CLASS, wrapperChipClass, WrapperChip, SubTabs,
  dmoDateToIso, fetchDmoGiltPrices, num, round2, CurrencyInput, NumberInput,
  uid, todayISO, SAMPLE, METHOD,
  AV_URL, avQuote, fxViaFrankfurter, fxViaYahoo, fxViaAlphaVantage, fxHistorical, fxToGBP, toGBP, avBudget, avBump, sleep,
  KIND_LABEL, ALLOC_COLORS, AllocBar, pct, pctPlain, toneOf, SHORT_SPAN, RateCell, rateIsDisplayable,
  IconBtn, Field, Stat, Row, MethodChip, Empty, TwoStepDelete,
  useSort, sortRows, SortTh, dedupeAgainstExisting,
};
