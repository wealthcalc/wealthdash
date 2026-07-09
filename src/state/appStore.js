/* ======================================================================
   APP STORE (Zustand) — the app's persisted state, moved out of App's
   useState pile so any component can subscribe to just the slice it needs
   (selector-based subscriptions stop the whole-tree re-render cascade as
   features adopt them). Persistence keeps the EXACT same localStorage keys
   as before, so existing user data loads unchanged and older backups
   restore identically.

   Setters accept either a value or an updater function, mirroring React's
   setState signature — so existing call sites (setTxns(fn), etc.) work
   verbatim.
   ====================================================================== */
import { create } from "zustand";
import { store as ls, SAMPLE, SECURITY_SEED, todayISO } from "../ui/shared.jsx";
// state key -> localStorage key lives in durable.js (single source of truth
// shared with the IndexedDB mirror, so new keys can't silently miss it).
import { PERSIST_KEYS, saveDurable, saveDailySnapshot } from "./durable.js";

const useAppStore = create((set) => {
  // setState-compatible setter: accepts a value or an updater function.
  const upd = (key) => (v) => set((s) => ({ [key]: typeof v === "function" ? v(s[key]) : v }));
  return {
    dark: ls.get("cgt.dark", true), setDark: upd("dark"),
    txns: ls.get("cgt.txns", SAMPLE), setTxns: upd("txns"),
    tab: ls.get("cgt.tab", "home"), setTab: upd("tab"),
    income: ls.get("cgt.income", 200000), setIncome: upd("income"),
    carried: ls.get("cgt.carried", 0), setCarried: upd("carried"),
    cash: ls.get("cgt.cash", {}), setCash: upd("cash"), // { wrapper: GBP balance }
    // [{id, date, provider, type, ccy, nativeAmount}]
    pensionCashflows: ls.get("cgt.pensioncf", []), setPensionCashflows: upd("pensionCashflows"),
    // DMO publishes one gilt-price report per business day (~2pm) — this is
    // the report DATE (not fetch time) of the last successful pull, in ISO,
    // so callers can skip the network round-trip when nothing's changed.
    dmoReportDate: ls.get("cgt.dmoreportdate", null), setDmoReportDate: upd("dmoReportDate"),
    valuations: ls.get("cgt.valuations", []), setValuations: upd("valuations"), // [{date, value, byWrapper}]
    incomeEntries: ls.get("cgt.incomeEntries", []), setIncomeEntries: upd("incomeEntries"), // dividends/interest ledger
    eriEntries: ls.get("cgt.eriEntries", []), setEriEntries: upd("eriEntries"), // excess reportable income
    prices: ls.get("cgt.prices", {}), setPrices: upd("prices"),
    avKey: ls.get("cgt.avkey", ""), setAvKey: upd("avKey"),
    avMeta: ls.get("cgt.avmeta", {}), setAvMeta: upd("avMeta"),           // { ticker: {symbol, currency} }
    priceMeta: ls.get("cgt.pricemeta", {}), setPriceMeta: upd("priceMeta"), // { ticker: {asOf, raw, ccy} }
    // { ticker: {isin, name, domicile, eri, ...} } — seed merged under saved edits
    secMeta: { ...SECURITY_SEED, ...ls.get("cgt.secmeta", {}) }, setSecMeta: upd("secMeta"),
    // Phase 2: balance-sheet completion (property/liabilities). Each a flat
    // array of records, same "own array, own setter" shape as pensionCashflows.
    properties: ls.get("cgt.properties", []), setProperties: upd("properties"),
    mortgages: ls.get("cgt.mortgages", []), setMortgages: upd("mortgages"),
    otherLiabilities: ls.get("cgt.otherliabilities", []), setOtherLiabilities: upd("otherLiabilities"),
    // [{id, wrapper, label, institution, balance, rate, rateType, maturityDate, notes}]
    // — additive on top of `cash` (the manual/unallocated figure), see core/cash.mjs.
    cashAccounts: ls.get("cgt.cashaccounts", []), setCashAccounts: upd("cashAccounts"),
    // { [taxYear]: { isaOnly, lisa, pension } } manual overrides for the Allowances
    // tab. Previously lived entirely OUTSIDE this store (component-local state +
    // its own localStorage write), which meant it was invisible to the IndexedDB
    // durable mirror, the daily snapshot, AND the JSON backup/restore — a real
    // data-loss bug (overrides silently missing after a restore, or after a
    // localStorage eviction that everything else survived via the mirror). Falls
    // back to the old mixed-case key once, for anyone with overrides saved there.
    allowanceOverrides: ls.get("cgt.allowanceoverrides", ls.get("cgt.allowanceOverrides", {})),
    setAllowanceOverrides: upd("allowanceOverrides"),
    // UK retirement planner inputs (Plan tab). Previously lived entirely
    // OUTSIDE this store — component-local state backed by its own
    // `localStorage.setItem("uk-retirement-planner:inputs", JSON.stringify(p))`
    // call, invisible to the IndexedDB durable mirror, the daily snapshot, and
    // the JSON backup/restore — the same data-loss class fixed for
    // allowanceOverrides above, and the reason the Plan tab had its own
    // separate Save/Load buttons in the first place (it had no other way to
    // round-trip through a backup). null = not yet customised — PlanTab falls
    // back to its own DEFAULTS. The old key used the same JSON.stringify
    // encoding `ls` uses, so it reads straight through as a one-time migration.
    planInputs: ls.get("cgt.planinputs", ls.get("uk-retirement-planner:inputs", null)),
    setPlanInputs: upd("planInputs"),
  };
});

// Persist on change — one subscription, writing only the keys that changed
// (replaces the 16 per-key useEffect hooks that serialised on every render).
// localStorage stays the synchronous primary; a debounced full-state mirror
// goes to IndexedDB (durable.js) as eviction insurance, plus one snapshot
// per day (rolling 30) as a corruption fallback.
let _durableTimer = null;
useAppStore.subscribe((state, prev) => {
  let changed = false;
  for (const [key, lsKey] of Object.entries(PERSIST_KEYS)) {
    if (state[key] !== prev[key]) { ls.set(lsKey, state[key]); changed = true; }
  }
  if (!changed) return;
  clearTimeout(_durableTimer);
  _durableTimer = setTimeout(() => {
    const s = useAppStore.getState();
    const byLsKey = {};
    for (const [key, lsKey] of Object.entries(PERSIST_KEYS)) byLsKey[lsKey] = s[key];
    saveDurable(byLsKey);
    saveDailySnapshot(todayISO(), byLsKey);
  }, 1500);
});

export default useAppStore;
