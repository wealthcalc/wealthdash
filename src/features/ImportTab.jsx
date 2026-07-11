import React, { useState, useMemo, useCallback, useRef } from "react";
import Papa from "papaparse";
import { Upload, Wand2, RefreshCw, FileUp, AlertTriangle, Copy, Check, Trash2 } from "lucide-react";
import { WRAPPERS, normWrapper } from "../core/portfolio.mjs";
import { guessPensionColumns, mapPensionRow } from "../core/pension-import.mjs";
import { parseIBKR } from "../core/ibkr-import.mjs";
import { parseFidelity } from "../core/fidelity-import.mjs";
import { shapeFlexPull, shapeCashReport } from "../core/ibkr-flex.mjs";
import { parseISharesWorkbook } from "../core/ishares-eri.mjs";
import { buildRsuImport, guessTickerFromFilename, detectRsuCsvFormat } from "../core/rsu-import.mjs";
import { gbp, num, uid, todayISO, fxHistorical, Field, Empty, SubTabs, round2, dedupeAgainstExisting } from "../ui/shared.jsx";

const FIELDS = ["date", "ticker", "side", "quantity", "nativeCurrency", "nativeAmount", "fxRate", "gbpAmount"];
const FIELDS_DIV = ["date", "ticker", "kind", "nativeCurrency", "nativeAmount", "fxRate", "gbpAmount"];

// Example CSV shown as each textarea's placeholder AND offered via a "Copy
// example format" button next to it — one canonical string per import
// shape, so the button can never drift out of sync with what the user
// actually sees typed in grey.
const IBKR_EXAMPLE = "Symbol,ISIN,TradeDate,Buy/Sell,Quantity,TradePrice,Proceeds,IBCommission,CurrencyPrimary,FXRateToBase,AssetClass\nAAPL,US0378331005,20240115,BUY,10,180,-1800,-1,USD,0.79,STK";
const GENERIC_EXAMPLE = "Date,Symbol,Action,Quantity,Currency,Amount,FXRate\n2025-06-02,WFC,SELL,200,USD,18718,0.78";
const DIV_EXAMPLE = "Date,Symbol,Type,Currency,Amount\n2025-06-15,CSP1,Dividend,USD,42.10\n2025-07-01,,Interest,GBP,15.00";
const PENSION_EXAMPLE = "Date,Symbol,Type,Currency,Amount\n2023-01-06,Pension,Employer Contribution,GBP,600.00\n2023-02-06,Pension,Employer Contribution,GBP,600.00";

// Copies a canonical example CSV to the clipboard so a user can paste it
// into their own spreadsheet/export as a template, without retyping the
// placeholder text shown (greyed out, unselectable as real content) in the
// textarea above it. Fails silently if the Clipboard API is blocked
// (e.g. an insecure context) — the placeholder text is still visible either way.
function CopyExampleButton({ text }) {
  const [copied, setCopied] = useState(false);
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — button just won't confirm */ }
  };
  return (
    <button type="button" onClick={doCopy} title="Copy this example CSV to your clipboard"
      className="text-xs text-[var(--accent)] hover:underline inline-flex items-center gap-1">
      {copied ? <><Check size={12} /> Copied!</> : <><Copy size={12} /> Copy example format</>}
    </button>
  );
}

// Duplicate-detection keys, one per data shape this tab can import into.
// Deliberately loose on precision (rounded to the penny) since a re-export
// can format a number very slightly differently (trailing zeros, rounding at
// the source) without being a genuinely different transaction.
const txnKey = (t) => `${t.date}|${(t.ticker || "").toUpperCase()}|${t.side}|${normWrapper(t.wrapper)}|${round2(t.quantity)}|${round2(t.gbpAmount)}`;
const incomeKey = (e) => `${e.date}|${(e.ticker || "").toUpperCase()}|${e.kind}|${normWrapper(e.wrapper)}|${round2(e.amount)}`;
const pensionKey = (c) => `${c.provider}|${c.date}|${c.type}|${round2(c.nativeAmount)}`;
const eriKey = (e) => `${(e.ticker || "").toUpperCase()}|${e.periodEnd}|${e.distributionDate}`;
// IBKR's own tradeID/transactionID, when a row carries one — an exact
// identity match, immune to a value rounding slightly differently between
// two pulls of the same trade (the failure mode the content-based keys
// above are otherwise exposed to). null on a row with no id (anything
// imported before this field existed, or from a CSV export that didn't
// include the id column) so it never collides with another id-less row —
// dedupeAgainstExisting() falls back to the content key in that case.
const ibkrIdKey = (t) => (t.ibkrId ? `ibkr:${t.ibkrId}` : null);

function ImportTab({
  setTxns, setTab, setIncomeEntries, setEriEntries, secMeta, setPensionCashflows, pensionCashflows = [], recomputeProviderCost,
  txns = [], incomeEntries = [], eriEntries = [],
  ibkrQueryId = "", setIbkrQueryId, ibkrToken = "", setIbkrToken,
  rsuGrants = [], setRsuGrants, rsuEvents = [], setRsuEvents,
}) {
  const [mode, setMode] = useState("ibkr");
  const [wrapper, setWrapper] = useState("GIA");
  const [ibkrSource, setIbkrSource] = useState("live"); // "paste" | "live"
  const [fidRaw, setFidRaw] = useState(""); // Fidelity UK CSV paste
  const [flexBusy, setFlexBusy] = useState(false);
  const [flexError, setFlexError] = useState("");
  const [cashReport, setCashReport] = useState(null);
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState(null);
  const [map, setMap] = useState({});
  const [ib, setIb] = useState(null);       // parseIBKR result
  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState("");
  const [wb, setWb] = useState(null);        // parsed iShares workbook: { fileName, sheets: [{name, headerRowIdx, colMap, headerCells, rows}] }
  const [activeSheet, setActiveSheet] = useState(0);
  const [onlyHeld, setOnlyHeld] = useState(true);
  const [checked, setChecked] = useState({}); // isin -> bool
  const [wbBusy, setWbBusy] = useState(false);

  const readFile = (e, cb) => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => cb(String(r.result)); r.readAsText(f); e.target.value = ""; };

  // ---- IBKR ----
  const parseIb = (text) => { const t = (text ?? raw).trim(); if (!t) return; setIb(parseIBKR(t, { defaultWrapper: wrapper })); };
  React.useEffect(() => { if (ib) setIb((r) => ({ ...r, trades: r.trades.map((t) => ({ ...t, wrapper })), income: r.income.map((t) => ({ ...t, wrapper })) })); }, [wrapper]); // eslint-disable-line

  // ---- IBKR: live pull via the Flex Web Service (api/ibkr-flex.mjs proxies
  // the SendRequest -> GetStatement flow — IBKR has no CORS for browsers).
  // Produces the EXACT same {trades, income, warnings} shape as parseIBKR()
  // above (see core/ibkr-flex.mjs), so it feeds straight into the same `ib`
  // state and the same preview/import UI below, unchanged.
  const pullFromIbkr = async () => {
    if (!ibkrQueryId.trim() || !ibkrToken.trim()) { setFlexError("Enter both your Flex Query ID and token first."); return; }
    setFlexBusy(true); setFlexError(""); setNote(""); setCashReport(null);
    try {
      // POST body, not query string — a GET query puts the Flex token in
      // Vercel's request logs (api/ibkr-flex.mjs rejects GET for this reason).
      const r = await fetch("/api/ibkr-flex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: ibkrToken.trim(), queryId: ibkrQueryId.trim() }),
      });
      const j = await r.json();
      if (!r.ok) { setFlexError(j.error || `IBKR pull failed (${r.status}).`); setFlexBusy(false); return; }
      setIb(shapeFlexPull(j, { defaultWrapper: wrapper }));
      setCashReport(shapeCashReport(j));
    } catch (e) {
      setFlexError(e?.message || "Couldn't reach the IBKR proxy — is this running on the deployed app (not a local sandbox)?");
    }
    setFlexBusy(false);
  };
  const doImportIb = async () => {
    if (!ib) return; setImporting(true); setNote("");
    const cache = {};
    const resolve = async (row, gbpKey) => {
      if (!row.needsFx) return;
      const k = row.nativeCurrency + row.date;
      if (!(k in cache)) cache[k] = await fxHistorical(row.nativeCurrency, row.date);
      const fx = cache[k];
      if (fx) { row.fxRate = fx; row[gbpKey] = Math.round(row.nativeAmount * fx * 100) / 100; }
    };
    const trades = ib.trades.map((t) => ({ ...t })), income = ib.income.map((t) => ({ ...t }));
    for (const t of trades) await resolve(t, "gbpAmount");
    for (const t of income) await resolve(t, "amount");
    const newTxns = trades.filter((t) => t.gbpAmount != null).map((t) => ({ id: uid(), date: t.date, ticker: t.ticker, isin: t.isin, side: t.side, quantity: t.quantity, nativeCurrency: t.nativeCurrency, nativeAmount: t.nativeAmount, fxRate: t.fxRate || 1, gbpAmount: t.gbpAmount, fees: +t.fees || 0, account: t.account || "", wrapper: t.wrapper, note: `${t.source || "IBKR"} import`, ibkrId: t.ibkrId || null }));
    const newIncome = income.filter((t) => t.amount != null).map((t) => ({ id: uid(), date: t.date, ticker: t.ticker, kind: t.kind, amount: t.amount, wrapper: t.wrapper, note: `${t.source || "IBKR"} import`, ibkrId: t.ibkrId || null }));
    const fxSkipped = (trades.length - newTxns.length) + (income.length - newIncome.length);
    // Prefer an exact IBKR tradeID/transactionID match over the
    // content-based key when a row carries one — see ibkrIdKey's comment.
    const dedTxns = dedupeAgainstExisting(newTxns, txns, [ibkrIdKey, txnKey]);
    const dedIncome = dedupeAgainstExisting(newIncome, incomeEntries, [ibkrIdKey, incomeKey]);
    const dupSkipped = dedTxns.skipped + dedIncome.skipped;
    setTxns((p) => [...p, ...dedTxns.rows]);
    if (dedIncome.rows.length) setIncomeEntries((p) => [...p, ...dedIncome.rows]);
    setImporting(false);
    const parts = [`Imported ${dedTxns.rows.length} trades and ${dedIncome.rows.length} income rows.`];
    if (dupSkipped) parts.push(`${dupSkipped} duplicate row(s) already in your ledger — skipped.`);
    if (fxSkipped) parts.push(`${fxSkipped} row(s) skipped — FX could not be resolved; add them manually.`);
    if (dupSkipped || fxSkipped) setNote(parts.join(" "));
    else setTab(dedTxns.rows.length ? "ledger" : "income");
  };

  // Preview-time duplicate detection, reusing the same keys doImportIb's
  // own dedupeAgainstExisting() call will apply at import time (id-based
  // first, content-based fallback — see ibkrIdKey's comment) — this just
  // surfaces it earlier so a "dup" badge is visible before the user
  // commits, rather than only learning about skipped rows afterwards.
  const existingTxnKeys = useMemo(() => new Set(txns.map(txnKey)), [txns]);
  const existingIncomeKeys = useMemo(() => new Set(incomeEntries.map(incomeKey)), [incomeEntries]);
  const existingTxnIds = useMemo(() => new Set(txns.map(ibkrIdKey).filter((k) => k != null)), [txns]);
  const existingIncomeIds = useMemo(() => new Set(incomeEntries.map(ibkrIdKey).filter((k) => k != null)), [incomeEntries]);
  const isDupTrade = (t) => existingTxnIds.has(ibkrIdKey(t)) || existingTxnKeys.has(txnKey(t));
  const isDupIncome = (e) => existingIncomeIds.has(ibkrIdKey(e)) || existingIncomeKeys.has(incomeKey(e));
  const ibDupTrades = ib ? ib.trades.filter(isDupTrade).length : 0;
  const ibDupIncome = ib ? ib.income.filter(isDupIncome).length : 0;
  const removeIbTrade = (i) => setIb((r) => ({ ...r, trades: r.trades.filter((_, idx) => idx !== i) }));
  const removeIbIncome = (i) => setIb((r) => ({ ...r, income: r.income.filter((_, idx) => idx !== i) }));

  // ---- generic ----
  const parse = () => {
    const res = Papa.parse(raw.trim(), { header: true, skipEmptyLines: true });
    if (!res.data?.length) return;
    const cols = res.meta.fields || [];
    const find = (re) => cols.find((c) => re.test(c));
    const guess = {};
    guess.date = find(/date|trade date|settl/i); guess.ticker = find(/ticker|symbol|instrument|stock/i);
    guess.side = find(/side|action|type|buy.?sell|b\/s/i); guess.quantity = find(/qty|quantity|shares|units/i);
    guess.nativeCurrency = find(/currency|ccy/i); guess.nativeAmount = find(/amount|proceeds|cost|value|consideration|net/i);
    guess.fxRate = find(/fx|rate|exchange/i); guess.gbpAmount = find(/gbp|sterling/i);
    setParsed(res.data); setMap(guess);
  };
  const normSide = (v) => /sell|^s$|sld|disp/i.test(v || "") ? "SELL" : "BUY";
  const preview = useMemo(() => (!parsed ? [] : parsed.slice(0, 5).map((r) => mapRow(r, map, normSide, wrapper))), [parsed, map, wrapper]);
  const genericRows = useMemo(() => (!parsed ? [] : parsed.map((r) => mapRow(r, map, normSide, wrapper)).filter((t) => t.date && t.ticker && +t.quantity > 0)), [parsed, map, wrapper]);
  const genericDedup = useMemo(() => dedupeAgainstExisting(genericRows, txns, txnKey), [genericRows, txns]);
  const doImport = () => {
    setTxns((p) => [...p, ...genericDedup.rows]); setTab("ledger");
  };

  // ---- generic dividend/interest CSV ----
  const [rawDiv, setRawDiv] = useState("");
  const [parsedDiv, setParsedDiv] = useState(null);
  const [mapDiv, setMapDiv] = useState({});
  const parseDiv = () => {
    const res = Papa.parse(rawDiv.trim(), { header: true, skipEmptyLines: true });
    if (!res.data?.length) return;
    const cols = res.meta.fields || [];
    const find = (re) => cols.find((c) => re.test(c));
    const guess = {};
    guess.date = find(/date|pay date|ex.?date|settl/i);
    guess.ticker = find(/ticker|symbol|instrument|stock|security/i);
    guess.kind = find(/kind|type|category/i);
    guess.nativeCurrency = find(/currency|ccy/i);
    guess.nativeAmount = find(/amount|gross|net|value|proceeds/i);
    guess.fxRate = find(/fx|rate|exchange/i);
    guess.gbpAmount = find(/gbp|sterling/i);
    setParsedDiv(res.data); setMapDiv(guess);
  };
  const normKind = (v) => /interest|coupon/i.test(v || "") ? "interest" : "dividend";
  const previewDiv = useMemo(() => (!parsedDiv ? [] : parsedDiv.slice(0, 5).map((r) => mapDivRow(r, mapDiv, normKind, wrapper))), [parsedDiv, mapDiv, wrapper]);
  const divRows = useMemo(() => (!parsedDiv ? [] : parsedDiv.map((r) => mapDivRow(r, mapDiv, normKind, wrapper)).filter((t) => t.date && t.ticker && t.amount > 0)), [parsedDiv, mapDiv, wrapper]);
  const divDedup = useMemo(() => dedupeAgainstExisting(divRows, incomeEntries, incomeKey), [divRows, incomeEntries]);
  const doImportDiv = () => {
    setIncomeEntries((p) => [...p, ...divDedup.rows]); setTab("income");
  };

  // ---- pension contribution/switch CSV (Citi/L&G, Aviva, or any other provider) ----
  const [rawPension, setRawPension] = useState("");
  const [parsedPension, setParsedPension] = useState(null);
  const [mapPension, setMapPension] = useState({});
  const [pensionProvider, setPensionProvider] = useState("");
  const existingProviders = useMemo(() => [...new Set(Object.values(secMeta || {}).map((m) => m.provider).filter(Boolean))].sort(), [secMeta]);
  const parsePension = () => {
    const res = Papa.parse(rawPension.trim(), { header: true, skipEmptyLines: true });
    if (!res.data?.length) return;
    setParsedPension(res.data); setMapPension(guessPensionColumns(res.meta.fields || []));
  };
  const previewPension = useMemo(
    () => (!parsedPension || !pensionProvider ? [] : parsedPension.slice(0, 8).map((r) => mapPensionRow(r, mapPension, pensionProvider)).filter(Boolean)),
    [parsedPension, mapPension, pensionProvider]
  );
  const pensionParsedRows = useMemo(
    () => (!parsedPension || !pensionProvider ? [] : parsedPension.map((r) => mapPensionRow(r, mapPension, pensionProvider.trim())).filter(Boolean)),
    [parsedPension, mapPension, pensionProvider]
  );
  const pensionSkipped = useMemo(
    () => (!parsedPension || !pensionProvider ? 0 : parsedPension.length - pensionParsedRows.length),
    [parsedPension, pensionProvider, pensionParsedRows]
  );
  const pensionDedup = useMemo(() => dedupeAgainstExisting(pensionParsedRows, pensionCashflows, pensionKey), [pensionParsedRows, pensionCashflows]);
  const doImportPension = () => {
    if (!pensionProvider.trim()) return;
    const provider = pensionProvider.trim();
    const rows = pensionDedup.rows.map((r) => ({ id: uid(), ...r, gbpAmount: r.ccy === "GBP" ? r.nativeAmount : null }));
    setPensionCashflows((p) => [...p, ...rows]);
    if (recomputeProviderCost) recomputeProviderCost(provider, [...pensionCashflows, ...rows]);
    setTab("pension");
  };

  // ---- iShares / issuer ERI workbook ----
  const heldIsins = useMemo(() => new Set(Object.values(secMeta || {}).map((s) => (s.isin || "").toUpperCase()).filter(Boolean)), [secMeta]);
  const isinToTicker = useMemo(() => {
    const m = {}; for (const [tk, s] of Object.entries(secMeta || {})) if (s.isin) m[s.isin.toUpperCase()] = tk; return m;
  }, [secMeta]);

  const readWorkbookFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    setWbBusy(true); setWb(null); setChecked({});
    const r = new FileReader();
    r.onload = async () => {
      try {
        const XLSX = await import("xlsx"); // loaded on demand — see note at top of file
        const data = new Uint8Array(r.result);
        const book = XLSX.read(data, { type: "array", cellDates: true });
        const sheets = book.SheetNames.map((name) => ({ name, aoa: XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true, defval: "" }) }));
        const result = parseISharesWorkbook(sheets, null); // parse unfiltered; "only held" is a display filter below
        const bestSheet = result.reduce((best, s, i) => {
          const scoreOf = (idx) => result[idx].rows.filter((row) => heldIsins.has(row.isin)).length || result[idx].rows.length;
          return scoreOf(i) > scoreOf(best) ? i : best;
        }, 0);
        setWb({ fileName: f.name, sheets: result });
        setActiveSheet(bestSheet);
      } catch (err) {
        setWb({ fileName: f.name, sheets: [], error: err.message || "Could not read this file as a spreadsheet." });
      }
      setWbBusy(false);
    };
    r.readAsArrayBuffer(f);
    e.target.value = "";
  };

  const sheet = wb?.sheets?.[activeSheet];
  const allRows = sheet?.rows || [];
  const rows = useMemo(() => onlyHeld ? allRows.filter((r) => heldIsins.has(r.isin)) : allRows, [allRows, onlyHeld, heldIsins]);
  React.useEffect(() => {
    const c = {}; rows.forEach((r) => { c[r.isin] = true; }); setChecked(c);
  }, [sheet, onlyHeld]); // eslint-disable-line
  const toggleAll = (v) => { const c = {}; rows.forEach((r) => { c[r.isin] = v; }); setChecked(c); };
  const selectedCount = rows.filter((r) => checked[r.isin]).length;

  const doImportEri = async () => {
    const selected = rows.filter((r) => checked[r.isin]);
    const fxCache = {};
    const toAdd = [];
    for (const r of selected) {
      const ticker = isinToTicker[r.isin] || r.isin;
      let fxRate = r.currency === "GBP" || r.currency === "GBp" ? 1 : 0;
      if (fxRate === 0 && r.distributionDate) {
        const k = r.currency + r.distributionDate;
        if (!(k in fxCache)) fxCache[k] = await fxHistorical(r.currency, r.distributionDate);
        fxRate = fxCache[k] || 0;
      }
      const e = { id: uid(), ticker, periodEnd: r.periodEnd, distributionDate: r.distributionDate, perShare: +r.perShare || 0, currency: r.currency || "GBP", fxRate, treatment: r.treatment || "dividend" };
      if (e.ticker && e.periodEnd && e.distributionDate && e.perShare) toAdd.push(e);
    }
    if (!toAdd.length) return;
    const { rows: uniqueAdd, skipped: dupEri } = dedupeAgainstExisting(toAdd, eriEntries, eriKey);
    if (uniqueAdd.length) setEriEntries((p) => [...p, ...uniqueAdd]);
    const unresolvedFx = toAdd.filter((e) => e.currency !== "GBP" && e.currency !== "GBp" && !e.fxRate).length;
    const parts = [`Imported ${uniqueAdd.length} ERI entries.`];
    if (dupEri) parts.push(`${dupEri} duplicate${dupEri === 1 ? "" : "s"} already recorded — skipped.`);
    if (unresolvedFx) parts.push(`${unresolvedFx} needed an FX rate that couldn't be fetched — set it manually on the Income tab.`);
    if (dupEri || unresolvedFx) setNote(parts.join(" "));
    else setTab("income");
  };

  // ---- RSU vest-release CSV (Wells Fargo/Shareworks-style export) ----
  // rsuRows holds the raw parsed CSV (one entry per source row); grants and
  // events are re-derived from it on every render via buildRsuImport, so a
  // per-row delete just filters rsuRows and everything downstream (grant
  // grouping, vest+tax-cover-sale pairing, dup detection) recomputes fresh —
  // no separate "parsed" vs "editable" state to keep in sync.
  const rsuGrantKey = (g) => `${(g.ticker || "").toUpperCase()}|${g.grantDate}|${(g.note || "").trim()}`;
  const rsuEventKey = (e) => `${e.grantId}|${e.type}|${e.date}|${round2(e.shares)}`;
  const [rsuRaw, setRsuRaw] = useState("");
  const [rsuRows, setRsuRows] = useState(null);
  const [rsuFileName, setRsuFileName] = useState("");
  const [rsuTicker, setRsuTicker] = useState("");
  const parseRsu = (text, fileName) => {
    const t = (text ?? rsuRaw).trim(); if (!t) return;
    const res = Papa.parse(t, { header: true, skipEmptyLines: true });
    if (!res.data?.length) return;
    setRsuRows(res.data);
    const fn = fileName ?? rsuFileName;
    if (fn) setRsuFileName(fn);
    if (!rsuTicker) { const guess = guessTickerFromFilename(fn || rsuFileName); if (guess) setRsuTicker(guess); }
  };
  const rsuFormat = useMemo(() => (rsuRows ? detectRsuCsvFormat(rsuRows) : null), [rsuRows]);
  const rsuBuilt = useMemo(() => (rsuRows ? buildRsuImport(rsuRows, { ticker: rsuTicker }) : null), [rsuRows, rsuTicker]);
  const rsuResolved = useMemo(() => {
    if (!rsuBuilt) return null;
    const existingGrantIds = new Map(rsuGrants.map((g) => [rsuGrantKey(g), g.id]));
    const idFor = {};
    const grants = rsuBuilt.grants.map((g) => {
      const existingId = existingGrantIds.get(rsuGrantKey(g));
      const id = existingId || g.key;
      idFor[g.key] = id;
      return { ...g, id, isNew: !existingId };
    });
    const existingEventKeys = new Set(rsuEvents.map(rsuEventKey));
    const events = rsuBuilt.events.map((e) => {
      const grantId = idFor[e.grantKey];
      return { ...e, grantId, dup: existingEventKeys.has(rsuEventKey({ ...e, grantId })) };
    });
    return { grants, events, warnings: rsuBuilt.warnings };
  }, [rsuBuilt, rsuGrants, rsuEvents]);
  const removeRsuRow = (i) => setRsuRows((r) => r.filter((_, idx) => idx !== i));
  const rsuDupCount = rsuResolved ? rsuResolved.events.filter((e) => e.dup).length : 0;
  const doImportRsu = () => {
    if (!rsuResolved) return;
    const idMap = new Map(rsuResolved.grants.map((g) => [g.id, g.isNew ? uid() : g.id]));
    const newGrants = rsuResolved.grants.filter((g) => g.isNew).map((g) => ({ id: idMap.get(g.id), ticker: g.ticker, grantDate: g.grantDate, note: g.note }));
    const newEvents = rsuResolved.events.filter((e) => !e.dup).map((e) => ({ id: uid(), grantId: idMap.get(e.grantId), type: e.type, date: e.date, shares: e.shares, priceNative: e.priceNative, fxRate: e.fxRate, note: e.note }));
    if (newGrants.length) setRsuGrants((p) => [...p, ...newGrants]);
    if (newEvents.length) setRsuEvents((p) => [...p, ...newEvents]);
    const dupSkipped = rsuResolved.events.length - newEvents.length;
    const parts = [`Imported ${newGrants.length} grant${newGrants.length === 1 ? "" : "s"} and ${newEvents.length} event${newEvents.length === 1 ? "" : "s"}.`];
    if (dupSkipped) parts.push(`${dupSkipped} duplicate event${dupSkipped === 1 ? "" : "s"} already recorded — skipped.`);
    setNote(parts.join(" "));
    setRsuRows(null);
    if (!dupSkipped) setTab("rsu");
  };

  const Tab = ({ k, label }) => (
    <button onClick={() => setMode(k)} className={"px-3 py-1.5 text-sm rounded-lg border " + (mode === k ? "bg-[var(--accent)] text-[var(--accent-fg)] border-transparent" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>{label}</button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Tab k="ibkr" label="Interactive Brokers" /><Tab k="fidelity" label="Fidelity UK" /><Tab k="generic" label="Generic CSV" /><Tab k="dividends" label="Dividends CSV" /><Tab k="pension" label="Pension contributions" /><Tab k="ishares" label="iShares ERI" /><Tab k="rsu" label="RSU vest history" />
      </div>

      {mode !== "ishares" && mode !== "pension" && mode !== "rsu" && mode !== "fidelity" && (
        <div className="flex items-center gap-2 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--panel2)] px-3 py-2">
          <span className="text-xs font-medium text-[var(--muted)]">Import into wrapper:</span>
          {WRAPPERS.map((w) => (
            <button key={w} onClick={() => setWrapper(w)}
              className={"text-xs font-medium px-2.5 py-1 rounded-full border transition " +
                (wrapper === w ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
              {w}
            </button>
          ))}
          {wrapper !== "GIA" && <span className="text-xs text-[var(--muted)] ml-1">{wrapper} is tax-sheltered — these rows won't affect CGT or income tax.</span>}
        </div>
      )}

      {mode === "fidelity" && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
          <p className="text-sm text-[var(--muted)]">
            Paste a Fidelity UK <strong>Transaction History</strong> CSV (Transactions → export). Buys/sells, dividends and interest are picked up; the wrapper comes from each row's own <em>Product Wrapper</em> column (Investment ISA → ISA, Investment Account → GIA), so no wrapper selection is needed. Fidelity reports dealing fees and stamp duty as separate rows — where a day has exactly one trade in that account they're folded into its <em>Fees</em> automatically; ambiguous days are flagged instead of guessed. Cash movements (Cash In/Out, transfers, service fees) are deliberately skipped and listed below so nothing disappears silently. Re-importing an overlapping export is safe — rows dedupe by Fidelity's own reference number.
          </p>
          <textarea value={fidRaw} onChange={(e) => setFidRaw(e.target.value)} rows={6}
            placeholder={"Account ,All Accounts\nTimeframe,Last 30 days\n…\nOrder date,Completion date,Transaction type,Investments,Product Wrapper,…"}
            className="input w-full font-mono text-xs" aria-label="Fidelity UK CSV" />
          <button onClick={() => { const t = fidRaw.trim(); if (t) setIb(parseFidelity(t)); }} className="btn-accent">Parse Fidelity CSV</button>
          <p className="text-xs text-[var(--muted)]">Parsed rows appear in the preview below — same review/import flow as IBKR.</p>
        </div>
      )}

      {mode === "ibkr" && (
        <>
          <div className="flex items-center gap-2 text-xs">
            {[["live", "Pull live (Flex Web Service)"], ["paste", "Paste CSV"]].map(([k, label]) => (
              <button key={k} onClick={() => setIbkrSource(k)}
                className={"px-2.5 py-1 rounded-full border font-medium transition " +
                  (ibkrSource === k ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
                {label}
              </button>
            ))}
          </div>

          {ibkrSource === "live" && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <p className="text-sm text-[var(--muted)]">
                Pulls trades and cash transactions straight from IBKR's Flex Web Service — no copy/paste needed. Requires a Flex Query (Performance &amp; Reports → Flex Queries) with the <strong>Trades</strong> and <strong>Cash Transactions</strong> sections enabled, and the Flex Web Service turned on (same page → Flex Web Service Configuration) to get a token. Both are stored only in this browser and sent straight to IBKR via this app's own proxy — never to anyone else. {wrapper !== "GIA" && <span className="text-[var(--fg)]">Note: {wrapper} is tax-sheltered, so these rows won't affect CGT or income tax.</span>} IBKR has no ISA/SIPP concept — everything pulled lands in the wrapper selected above (defaults to GIA, since an IBKR account is an ordinary taxable brokerage account for UK purposes).
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                <Field label="Flex Query ID"><input value={ibkrQueryId} onChange={(e) => setIbkrQueryId(e.target.value)} placeholder="e.g. 1568009" className="input w-full font-mono text-xs" /></Field>
                <Field label="Flex Web Service token"><input value={ibkrToken} onChange={(e) => setIbkrToken(e.target.value)} placeholder="paste your token" type="password" className="input w-full font-mono text-xs" /></Field>
                <button onClick={pullFromIbkr} disabled={flexBusy} className="btn-accent disabled:opacity-50">{flexBusy ? <RefreshCw size={15} className="animate-spin" /> : <RefreshCw size={15} />} {flexBusy ? "Pulling…" : "Pull from IBKR"}</button>
              </div>
              {flexError && (
                <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-[var(--loss)]" style={{ background: "color-mix(in srgb, var(--loss) 10%, transparent)" }}><AlertTriangle size={14} className="mt-0.5 shrink-0" />{flexError}</div>
              )}
              {cashReport && cashReport.length > 0 && (
                <div className="text-xs text-[var(--muted)]">
                  IBKR cash balance{cashReport.length > 1 ? "s" : ""}: {cashReport.map((c) => `${num(c.endingCash, 2)} ${c.currency}`).join(", ")} — a reconciliation check against the Wealth tab, not imported automatically.
                </div>
              )}
            </div>
          )}

          {ibkrSource === "paste" && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <p className="text-sm text-[var(--muted)]">Paste (or upload) an IBKR <strong>Flex Query</strong> CSV or an <strong>Activity Statement</strong> CSV. Trades and dividends/interest are both picked up. A Flex query carries an FX-to-base rate, so GBP conversion is automatic; Activity exports lack it, so non-GBP rows are converted by trade-date FX on import. {wrapper !== "GIA" && <span className="text-[var(--fg)]">Note: {wrapper} is tax-sheltered, so these rows won't affect CGT or income tax.</span>}</p>
              <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={7} placeholder={IBKR_EXAMPLE} className="input num w-full font-mono text-xs" />
              <div className="flex items-center gap-2">
                <button onClick={() => parseIb()} className="btn-accent"><Wand2 size={15} /> Parse</button>
                <label className="text-sm text-[var(--accent)] cursor-pointer flex items-center gap-1"><Upload size={14} /> Upload CSV<input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => readFile(e, (txt) => { setRaw(txt); parseIb(txt); })} /></label>
                <CopyExampleButton text={IBKR_EXAMPLE} />
              </div>
            </div>
          )}

          {ib && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <div className="flex items-center gap-4 text-sm flex-wrap">
                <span className="font-semibold">{ibkrSource === "live" ? "Live Flex pull" : ib.format === "activity" ? "Activity Statement" : "Flex Query"} detected</span>
                <span className="num">{ib.trades.length} trades</span>
                <span className="num">{ib.income.filter((i) => i.kind === "dividend").length} dividends</span>
                <span className="num">{ib.income.filter((i) => i.kind === "interest").length} interest</span>
                {(ibDupTrades + ibDupIncome) > 0 && (
                  <span className="text-[var(--muted)]">{ibDupTrades + ibDupIncome} look{ibDupTrades + ibDupIncome === 1 ? "s" : ""} like duplicate{ibDupTrades + ibDupIncome === 1 ? "" : "s"} of rows already in your ledger — flagged "dup" below, skipped automatically on import.</span>
                )}
              </div>
              {ib.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-[var(--loss)]" style={{ background: "color-mix(in srgb, var(--loss) 10%, transparent)" }}><AlertTriangle size={14} className="mt-0.5 shrink-0" />{w}</div>
              ))}
              {ib.trades.length > 0 && (
                <div className="overflow-x-auto max-h-72 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="text-[var(--muted)]"><tr>{["date", "ticker", "side", "qty", "ccy", "native", "GBP", "", ""].map((h, i) => <th key={i} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                    <tbody className="num">
                      {ib.trades.map((t, i) => {
                        const dup = isDupTrade(t);
                        return (
                          <tr key={i} className="border-t border-[var(--border)]">
                            <td className="px-2 py-1">{t.date}</td><td className="px-2 py-1">{t.ticker}</td><td className="px-2 py-1">{t.side}</td>
                            <td className="px-2 py-1">{num(t.quantity, t.quantity % 1 ? 4 : 0)}</td><td className="px-2 py-1">{t.nativeCurrency}</td>
                            <td className="px-2 py-1">{num(t.nativeAmount)}</td><td className="px-2 py-1">{t.gbpAmount == null ? "FX on import" : gbp(t.gbpAmount)}</td>
                            <td className="px-2 py-1">{dup && <span className="text-[11px] uppercase font-semibold px-1.5 py-0.5 rounded-full text-[var(--muted)] border border-[var(--border)]">dup</span>}</td>
                            <td className="px-2 py-1"><button onClick={() => removeIbTrade(i)} title="Remove this row" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={13} /></button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {ib.income.length > 0 && (
                <div className="overflow-x-auto max-h-72 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="text-[var(--muted)]"><tr>{["date", "ticker", "kind", "GBP", "", ""].map((h, i) => <th key={i} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                    <tbody className="num">
                      {ib.income.map((e, i) => {
                        const dup = isDupIncome(e);
                        return (
                          <tr key={i} className="border-t border-[var(--border)]">
                            <td className="px-2 py-1">{e.date}</td><td className="px-2 py-1">{e.ticker || "—"}</td><td className="px-2 py-1 capitalize">{e.kind}</td>
                            <td className="px-2 py-1">{e.amount == null ? "FX on import" : gbp(e.amount)}</td>
                            <td className="px-2 py-1">{dup && <span className="text-[11px] uppercase font-semibold px-1.5 py-0.5 rounded-full text-[var(--muted)] border border-[var(--border)]">dup</span>}</td>
                            <td className="px-2 py-1"><button onClick={() => removeIbIncome(i)} title="Remove this row" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={13} /></button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {note && <div className="text-xs text-[var(--muted)]">{note}</div>}
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--muted)]">Imports into <strong>{wrapper}</strong>. Trades → ledger, dividends/interest → Income tab. Duplicates are skipped automatically even if not removed above.</span>
                <button onClick={doImportIb} disabled={importing || (!ib.trades.length && !ib.income.length)} className="btn-accent disabled:opacity-50">{importing ? <RefreshCw size={15} className="animate-spin" /> : <FileUp size={15} />} Import</button>
              </div>
            </div>
          )}
        </>
      )}

      {mode === "generic" && (
        <>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
            <p className="text-sm text-[var(--muted)]">Paste a CSV from any broker. Columns are auto-mapped — adjust below if needed. Rows import into <strong>{wrapper}</strong>.</p>
            <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={7} placeholder={GENERIC_EXAMPLE} className="input num w-full font-mono text-xs" />
            <div className="flex items-center gap-2">
              <button onClick={parse} className="btn-accent"><Wand2 size={15} /> Parse & map</button>
              <CopyExampleButton text={GENERIC_EXAMPLE} />
            </div>
          </div>
          {parsed && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {FIELDS.map((f) => (
                  <Field key={f} label={f}>
                    <select value={map[f] || ""} onChange={(e) => setMap((m) => ({ ...m, [f]: e.target.value }))} className="input w-full text-xs">
                      <option value="">—</option>
                      {(Object.keys(parsed[0] || {})).map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[var(--muted)]"><tr>{["date", "ticker", "side", "qty", "ccy", "native", "fx", "gbp"].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                  <tbody className="num">
                    {preview.map((t, i) => (
                      <tr key={i} className="border-t border-[var(--border)]">
                        <td className="px-2 py-1">{t.date}</td><td className="px-2 py-1">{t.ticker}</td><td className="px-2 py-1">{t.side}</td>
                        <td className="px-2 py-1">{t.quantity}</td><td className="px-2 py-1">{t.nativeCurrency}</td><td className="px-2 py-1">{num(t.nativeAmount)}</td>
                        <td className="px-2 py-1">{num(t.fxRate, 4)}</td><td className="px-2 py-1">{gbp(t.gbpAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--muted)]">{genericDedup.rows.length} new row{genericDedup.rows.length === 1 ? "" : "s"} ready{genericDedup.skipped ? `, ${genericDedup.skipped} duplicate${genericDedup.skipped === 1 ? "" : "s"} already in your ledger (skipped)` : ""}. GBP fills from native × FX when GBP column is unmapped.</span>
                <button onClick={doImport} disabled={!genericDedup.rows.length} className="btn-accent disabled:opacity-50"><FileUp size={15} /> Import {genericDedup.rows.length} row{genericDedup.rows.length === 1 ? "" : "s"}</button>
              </div>
            </div>
          )}
        </>
      )}

      {mode === "dividends" && (
        <>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
            <p className="text-sm text-[var(--muted)]">
              Paste a dividend/interest CSV from any broker (a tax certificate export, consolidated statement, etc). Columns are auto-mapped — adjust below if needed. Rows import into <strong>{wrapper}</strong> as income entries (same as adding them by hand on the Income tab), amounts net of any withholding tax already deducted at source.
            </p>
            <textarea value={rawDiv} onChange={(e) => setRawDiv(e.target.value)} rows={7} placeholder={DIV_EXAMPLE} className="input num w-full font-mono text-xs" />
            <div className="flex items-center gap-2">
              <button onClick={parseDiv} className="btn-accent"><Wand2 size={15} /> Parse & map</button>
              <CopyExampleButton text={DIV_EXAMPLE} />
            </div>
          </div>
          {parsedDiv && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {FIELDS_DIV.map((f) => (
                  <Field key={f} label={f}>
                    <select value={mapDiv[f] || ""} onChange={(e) => setMapDiv((m) => ({ ...m, [f]: e.target.value }))} className="input w-full text-xs">
                      <option value="">—</option>
                      {(Object.keys(parsedDiv[0] || {})).map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[var(--muted)]"><tr>{["date", "ticker", "kind", "GBP amount"].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                  <tbody className="num">
                    {previewDiv.map((t, i) => (
                      <tr key={i} className="border-t border-[var(--border)]">
                        <td className="px-2 py-1">{t.date}</td><td className="px-2 py-1">{t.ticker || "—"}</td>
                        <td className="px-2 py-1 capitalize">{t.kind}</td><td className="px-2 py-1">{gbp(t.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--muted)]">{divDedup.rows.length} new row{divDedup.rows.length === 1 ? "" : "s"} ready{divDedup.skipped ? `, ${divDedup.skipped} duplicate${divDedup.skipped === 1 ? "" : "s"} already recorded (skipped)` : ""}. GBP fills from native × FX when GBP column is unmapped; ticker can be left blank for interest.</span>
                <button onClick={doImportDiv} disabled={!divDedup.rows.length} className="btn-accent disabled:opacity-50"><FileUp size={15} /> Import {divDedup.rows.length} row{divDedup.rows.length === 1 ? "" : "s"}</button>
              </div>
            </div>
          )}
        </>
      )}

      {mode === "pension" && (
        <>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
            <p className="text-sm text-[var(--muted)]">
              Paste a contribution/switch history from a pension provider — column names vary (confirmed against real Citi/L&G and Aviva exports, auto-detected below), and "Switch" rows (fund-to-fund transfers with no net cashflow) are automatically excluded. Everything else with a real, nonzero amount becomes a cashflow used for that provider's money-weighted return (XIRR) on the Pension &amp; LISA tab — it does <em>not</em> create fund transactions, since these exports don't break contributions down by fund.
            </p>
            <Field label="Provider (existing or new)">
              <input list="import-pension-providers" value={pensionProvider} onChange={(e) => setPensionProvider(e.target.value)} className="input w-56" placeholder="e.g. L&G (Citi)" />
              <datalist id="import-pension-providers">{existingProviders.map((p) => <option key={p} value={p} />)}</datalist>
            </Field>
            <textarea value={rawPension} onChange={(e) => setRawPension(e.target.value)} rows={7} placeholder={PENSION_EXAMPLE} className="input num w-full font-mono text-xs" />
            <div className="flex items-center gap-2">
              <button onClick={parsePension} className="btn-accent"><Wand2 size={15} /> Parse & map</button>
              <CopyExampleButton text={PENSION_EXAMPLE} />
            </div>
          </div>
          {parsedPension && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {["date", "type", "currency", "amount"].map((f) => (
                  <Field key={f} label={f}>
                    <select value={mapPension[f] || ""} onChange={(e) => setMapPension((m) => ({ ...m, [f]: e.target.value }))} className="input w-full text-xs">
                      <option value="">—</option>
                      {(Object.keys(parsedPension[0] || {})).map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              {!pensionProvider.trim() && <p className="text-xs text-[var(--loss)]">Set a provider above before importing.</p>}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[var(--muted)]"><tr>{["date", "type", "currency", "amount"].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                  <tbody className="num">
                    {previewPension.map((t, i) => (
                      <tr key={i} className="border-t border-[var(--border)]">
                        <td className="px-2 py-1">{t.date}</td><td className="px-2 py-1">{t.type}</td>
                        <td className="px-2 py-1">{t.ccy}</td><td className="px-2 py-1">{gbp(t.nativeAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--muted)]">
                  {parsedPension.length} rows in file, {pensionParsedRows.length} contributions detected{pensionSkipped ? ` (${pensionSkipped} switches/zero-amount rows excluded)` : ""}{pensionDedup.skipped ? `, ${pensionDedup.skipped} duplicate${pensionDedup.skipped === 1 ? "" : "s"} already recorded (skipped)` : ""}. Preview shows the first 8.
                </span>
                <button onClick={doImportPension} disabled={!pensionProvider.trim() || !pensionDedup.rows.length} className="btn-accent disabled:opacity-50"><FileUp size={15} /> Import {pensionDedup.rows.length} cashflows</button>
              </div>
            </div>
          )}
        </>
      )}

      {mode === "ishares" && (
        <>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
            <p className="text-sm text-[var(--muted)]">
              Upload an iShares/BlackRock <strong>"UK Reportable Income"</strong> workbook — one file per fund umbrella (iShares Plc, iShares III plc, iShares VII plc, etc.), downloaded from <span className="font-mono text-xs">ishares.com</span> → Literature → Tax Information. Rows are matched to your holdings by ISIN and added as excess reportable income entries — GIA only, since ISA/SIPP are exempt.
            </p>
            <label className="inline-flex items-center gap-2 text-sm text-[var(--accent)] cursor-pointer">
              <Upload size={14} /> Upload workbook (.xlsx/.xls)
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={readWorkbookFile} />
            </label>
            {wbBusy && <div className="flex items-center gap-2 text-xs text-[var(--muted)]"><RefreshCw size={13} className="animate-spin" /> Reading workbook…</div>}
            {wb?.error && (
              <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-[var(--loss)]" style={{ background: "color-mix(in srgb, var(--loss) 10%, transparent)" }}><AlertTriangle size={14} className="mt-0.5 shrink-0" />{wb.error}</div>
            )}
          </div>

          {wb && !wb.error && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <div className="flex items-center gap-3 flex-wrap text-sm">
                <span className="font-semibold truncate max-w-[16rem]" title={wb.fileName}>{wb.fileName}</span>
                {wb.sheets.length > 1 && (
                  <select value={activeSheet} onChange={(e) => setActiveSheet(+e.target.value)} className="input text-xs w-auto">
                    {wb.sheets.map((s, i) => <option key={i} value={i}>{s.name} ({s.rows.length} held match{s.rows.length === 1 ? "" : "es"})</option>)}
                  </select>
                )}
                <label className="flex items-center gap-1.5 text-xs cursor-pointer ml-auto">
                  <input type="checkbox" checked={onlyHeld} onChange={(e) => setOnlyHeld(e.target.checked)} className="accent-[var(--accent)]" /> Only show my holdings
                </label>
              </div>

              {sheet && sheet.headerRowIdx < 0 && (
                <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-[var(--loss)]" style={{ background: "color-mix(in srgb, var(--loss) 10%, transparent)" }}>
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />Couldn't find a header row with an ISIN column in this sheet — it may not be a reportable-income report, or uses a layout this importer doesn't recognise yet.
                </div>
              )}

              {sheet && sheet.headerRowIdx >= 0 && rows.length === 0 && (
                <Empty msg={onlyHeld ? "No rows in this sheet match your current holdings' ISINs. Try unchecking \"Only show my holdings\", or check you've got the right umbrella file." : "No ERI rows found in this sheet (all excess income was zero, or no data rows present)."} />
              )}

              {rows.length > 0 && (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-[var(--muted)]">
                        <tr>
                          <th className="px-2 py-1 text-left"><input type="checkbox" checked={selectedCount === rows.length} onChange={(e) => toggleAll(e.target.checked)} className="accent-[var(--accent)]" /></th>
                          {["Fund", "Ticker", "ISIN", "Period end", "Distribution date", "ERI/unit", "Ccy", "Taxed as"].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}
                        </tr>
                      </thead>
                      <tbody className="num">
                        {rows.map((r) => {
                          const ticker = isinToTicker[r.isin];
                          return (
                            <tr key={r.isin + r.periodEnd} className="border-t border-[var(--border)]">
                              <td className="px-2 py-1"><input type="checkbox" checked={!!checked[r.isin]} onChange={(e) => setChecked((c) => ({ ...c, [r.isin]: e.target.checked }))} className="accent-[var(--accent)]" /></td>
                              <td className="px-2 py-1 max-w-[14rem] truncate" title={r.fundName}>{r.fundName}</td>
                              <td className="px-2 py-1 font-medium">{ticker || <span className="text-[var(--loss)]" title="No ticker in your holdings has this ISIN — add it on the Holdings tab first">unmatched</span>}</td>
                              <td className="px-2 py-1 font-mono text-[var(--muted)]">{r.isin}</td>
                              <td className="px-2 py-1">{r.periodEnd}</td>
                              <td className="px-2 py-1">{r.distributionDate}</td>
                              <td className="px-2 py-1">{r.perShare}</td>
                              <td className="px-2 py-1">{r.currency}</td>
                              <td className="px-2 py-1 capitalize">{r.treatment}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-[var(--muted)]">
                    "Taxed as" comes straight from the report's own "Meets definition of a Bond Fund" flag — bond funds are taxed as interest, everything else as dividend. Rows marked <span className="text-[var(--loss)]">unmatched</span> don't have a ticker with that ISIN on your Holdings tab; add the ISIN there first if you want to import them. Non-GBP amounts have their FX rate fetched automatically for the distribution date on import.
                  </p>
                  {note && <div className="text-xs text-[var(--muted)]">{note}</div>}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[var(--muted)]">{selectedCount}/{rows.length} selected.</span>
                    <button onClick={doImportEri} disabled={!selectedCount} className="btn-accent disabled:opacity-50"><FileUp size={15} /> Import {selectedCount} ERI entr{selectedCount === 1 ? "y" : "ies"}</button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {mode === "rsu" && (
        <>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
            <p className="text-sm text-[var(--muted)]">
              Paste (or upload) a Wells Fargo/Shareworks-style RSU export — either a <strong>release history</strong> ("Allocation quantity"/"Quantity to cover tax" columns) or a <strong>vesting schedule</strong> ("Contribution type"/"Available from" columns, including notional-dividend accruals on unvested tranches). The format is auto-detected from the file's columns; neither has a ticker column, so set it below (guessed from the filename if possible).
            </p>
            {rsuFormat && (
              <p className="text-xs text-[var(--muted)]">
                {rsuFormat === "release"
                  ? "Detected: release history. Rows sharing a plan label and grant date are grouped into one grant, each becoming a vest event; shares automatically withheld to cover tax are recorded as a same-date sale so held totals aren't overstated. This export has no per-tranche vest date, only the grant date, so every vest event is dated on the grant date — check dates on the RSU tab afterwards if you know the real ones."
                  : "Detected: vesting schedule. Each Award/Notional-dividend row becomes a vest event dated on its real \"Available from\" date. This export's \"Grant Date\" column means something different for Notional dividend rows (a dividend date, not the grant date), so the true grant date is resolved from each plan's Award row instead. Estimated values are report-date projections, not actual vest-date FMV, so price is left blank."}
              </p>
            )}
            <Field label="Ticker (e.g. WFC)"><input value={rsuTicker} onChange={(e) => setRsuTicker(e.target.value.toUpperCase())} placeholder="WFC" className="input w-32 font-mono text-xs" /></Field>
            <textarea value={rsuRaw} onChange={(e) => setRsuRaw(e.target.value)} rows={7} placeholder={'"Plan Description","Instrument","Grant Date","Allocation quantity","Released quantity","Quantity to cover tax","Net quantity","Archive status"\n"11 Jan 2023 RSU Award","Restricted Stock Units","11 Jan 2023","383","383","161.00000","222.00000","Released"'} className="input num w-full font-mono text-xs" />
            <div className="flex items-center gap-2">
              <button onClick={() => parseRsu()} className="btn-accent"><Wand2 size={15} /> Parse</button>
              <label className="text-sm text-[var(--accent)] cursor-pointer flex items-center gap-1"><Upload size={14} /> Upload CSV<input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => {
                const f = e.target.files?.[0]; if (!f) return;
                const r = new FileReader();
                r.onload = () => { const txt = String(r.result); setRsuRaw(txt); parseRsu(txt, f.name); };
                r.readAsText(f); e.target.value = "";
              }} /></label>
            </div>
          </div>

          {rsuResolved && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <div className="flex items-center gap-4 text-sm flex-wrap">
                <span className="font-semibold">{rsuRows.length} row{rsuRows.length === 1 ? "" : "s"} parsed</span>
                <span className="num">{rsuResolved.grants.length} grant{rsuResolved.grants.length === 1 ? "" : "s"}</span>
                <span className="num">{rsuResolved.events.filter((e) => e.type === "vest").length} vest events</span>
                {rsuFormat === "release" && <span className="num">{rsuResolved.events.filter((e) => e.type === "sale").length} tax-cover sales</span>}
                {rsuFormat === "schedule" && <span className="num">{rsuResolved.events.filter((e) => /^Notional dividend/.test(e.note || "")).length} notional dividend rows</span>}
                {rsuDupCount > 0 && <span className="text-[var(--muted)]">{rsuDupCount} look{rsuDupCount === 1 ? "s" : ""} like duplicate{rsuDupCount === 1 ? "" : "s"} already recorded — flagged "dup", skipped automatically on import.</span>}
              </div>
              {rsuResolved.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-[var(--loss)]" style={{ background: "color-mix(in srgb, var(--loss) 10%, transparent)" }}><AlertTriangle size={14} className="mt-0.5 shrink-0" />{w}</div>
              ))}
              {rsuRows.length > 0 && (
                <div className="overflow-x-auto max-h-72 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="text-[var(--muted)]">
                      <tr>{(rsuFormat === "schedule" ? ["plan", "type", "vest date", "quantity", "est. value", "", ""] : ["plan", "grant date", "allocation", "tax cover", "net", "", ""]).map((h, i) => <th key={i} className="px-2 py-1 text-left">{h}</th>)}</tr>
                    </thead>
                    <tbody className="num">
                      {rsuRows.map((row, i) => {
                        const m = rsuBuilt?.events?.find((e) => e.sourceRow === i);
                        const resolved = rsuResolved.events.find((e) => e.sourceRow === i);
                        const dup = resolved?.dup;
                        return (
                          <tr key={i} className="border-t border-[var(--border)]">
                            <td className="px-2 py-1 max-w-[12rem] truncate" title={row["Plan Description"] || row["Plan"]}>{row["Plan Description"] || row["Plan"] || "—"}</td>
                            {rsuFormat === "schedule" ? (
                              <>
                                <td className="px-2 py-1">{row["Contribution type"] || "—"}</td>
                                <td className="px-2 py-1">{row["Available from"] || "—"}</td>
                                <td className="px-2 py-1">{row["Quantity"] || "—"}</td>
                                <td className="px-2 py-1">{row["Estimated value"] ? `£${row["Estimated value"]}` : "—"}</td>
                              </>
                            ) : (
                              <>
                                <td className="px-2 py-1">{row["Grant Date"] || "—"}</td>
                                <td className="px-2 py-1">{row["Allocation quantity"] || "—"}</td>
                                <td className="px-2 py-1">{row["Quantity to cover tax"] || "—"}</td>
                                <td className="px-2 py-1">{row["Net quantity"] || "—"}</td>
                              </>
                            )}
                            <td className="px-2 py-1">{m == null ? <span className="text-[var(--loss)]">unparsed</span> : dup && <span className="text-[11px] uppercase font-semibold px-1.5 py-0.5 rounded-full text-[var(--muted)] border border-[var(--border)]">dup</span>}</td>
                            <td className="px-2 py-1"><button onClick={() => removeRsuRow(i)} title="Remove this row" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={13} /></button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {note && <div className="text-xs text-[var(--muted)]">{note}</div>}
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--muted)]">Imports onto the RSU tab. Duplicates are skipped automatically even if not removed above.</span>
                <button onClick={doImportRsu} disabled={!rsuTicker.trim() || !rsuResolved.events.length} className="btn-accent disabled:opacity-50"><FileUp size={15} /> Import</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
function mapRow(r, map, normSide, wrapper) {
  const g = (f) => (map[f] ? r[map[f]] : "");
  const ccy = (g("nativeCurrency") || "GBP").toUpperCase().trim();
  const native = parseFloat(String(g("nativeAmount")).replace(/[^0-9.\-]/g, "")) || 0;
  let fx = parseFloat(g("fxRate")) || (ccy === "GBP" ? 1 : 0);
  let gbpA = parseFloat(String(g("gbpAmount")).replace(/[^0-9.\-]/g, "")) || 0;
  if (!gbpA && native && fx) gbpA = +(native * fx).toFixed(2);
  if (!fx && gbpA && native) fx = +(gbpA / native).toFixed(6);
  return {
    id: uid(), date: (g("date") || "").slice(0, 10), ticker: (g("ticker") || "").toUpperCase().trim(),
    side: normSide(g("side")), quantity: Math.abs(parseFloat(g("quantity")) || 0),
    nativeCurrency: ccy, nativeAmount: native, fxRate: fx || 1, gbpAmount: gbpA, wrapper: wrapper || "GIA", note: "imported",
  };
}
function mapDivRow(r, map, normKind, wrapper) {
  const g = (f) => (map[f] ? r[map[f]] : "");
  const ccy = (g("nativeCurrency") || "GBP").toUpperCase().trim();
  const native = parseFloat(String(g("nativeAmount")).replace(/[^0-9.\-]/g, "")) || 0;
  let fx = parseFloat(g("fxRate")) || (ccy === "GBP" ? 1 : 0);
  let gbpA = parseFloat(String(g("gbpAmount")).replace(/[^0-9.\-]/g, "")) || 0;
  if (!gbpA && native && fx) gbpA = +(native * fx).toFixed(2);
  if (!fx && gbpA && native) fx = +(gbpA / native).toFixed(6);
  if (!gbpA && ccy === "GBP") gbpA = native;
  return {
    id: uid(), date: (g("date") || "").slice(0, 10), ticker: (g("ticker") || "").toUpperCase().trim(),
    kind: normKind(g("kind")), amount: gbpA, wrapper: wrapper || "GIA", note: "imported",
  };
}


export default ImportTab;
