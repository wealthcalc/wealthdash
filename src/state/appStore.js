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
import { PERSIST_KEYS, LARGE_KEYS, saveDurable, saveDailySnapshot, loadDurable, keysWhereDurableIsAhead } from "./durable.js";
import { schedulePush } from "./sync.js";

// First-run theme follows the OS (prefers-color-scheme) instead of a
// hardcoded dark default. Only the DEFAULT changes: anyone who has ever
// toggled the theme has `cgt.dark` in localStorage (the persistence
// subscription writes it on first change) and keeps their choice; anyone
// who hasn't keeps following the OS on every load, because the computed
// default is never written back until they express a preference.
const prefersDark = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)").matches
  : true;

const useAppStore = create((set) => {
  // setState-compatible setter: accepts a value or an updater function.
  const upd = (key) => (v) => set((s) => ({ [key]: typeof v === "function" ? v(s[key]) : v }));
  return {
    dark: ls.get("cgt.dark", prefersDark), setDark: upd("dark"),
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
    // Daily household net-worth history (core/net-worth-series.mjs) — the
    // TRUE-net-worth counterpart to `valuations`, recorded even on days with
    // unpriced holdings (flagged `estimated`), which `valuations` must never
    // be (it feeds the exact-TWR computation). One record per day.
    netWorthSnapshots: ls.get("cgt.networthsnapshots", []), setNetWorthSnapshots: upd("netWorthSnapshots"),
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
    // Private investments (EIS/SEIS/LP funds — e.g. a direct EIS holding, or
    // a venture LP like "Passion Capital IV"/"JamJar Fund II"). Two flat
    // arrays, same "own array, own setter" shape as properties/mortgages:
    // holdings (identity, type, share-issue date, relief %, manual
    // valuation) and events (capital calls, distributions, write-offs —
    // see core/private-investments.mjs for the full model).
    privateHoldings: ls.get("cgt.privateholdings", []), setPrivateHoldings: upd("privateHoldings"),
    privateEvents: ls.get("cgt.privateevents", []), setPrivateEvents: upd("privateEvents"),
    // RSU grants (employer stock, e.g. WFC) — same "own array, own setter"
    // shape as privateHoldings/privateEvents: grants (identity, ticker,
    // grant date) and events (vest tranches + sales — see core/rsu.mjs).
    rsuGrants: ls.get("cgt.rsugrants", []), setRsuGrants: upd("rsuGrants"),
    rsuEvents: ls.get("cgt.rsuevents", []), setRsuEvents: upd("rsuEvents"),
    // Deferred cash comp (vesting cash awards, e.g. a deferred bonus paid in
    // tranches over several years) — same "own array, own setter" shape as
    // rsuGrants/rsuEvents: awards (identity, label, award date) and tranches
    // (scheduled/paid cash payouts — see core/deferred-cash.mjs). Only the
    // UNVESTED tranches feed net worth (vested ones have been paid and are
    // tracked as ordinary cash).
    deferredCashAwards: ls.get("cgt.deferredcashawards", []), setDeferredCashAwards: upd("deferredCashAwards"),
    deferredCashVests: ls.get("cgt.deferredcashvests", []), setDeferredCashVests: upd("deferredCashVests"),
    // IBKR Flex Web Service credentials (Import tab's live pull) — same
    // "client holds it, sent per-request, never stored server-side"
    // pattern as avKey. Still persisted locally like avKey so it doesn't
    // need retyping every session; the security boundary that matters is
    // server-side (api/ibkr-flex.mjs never writes it anywhere), not this.
    ibkrQueryId: ls.get("cgt.ibkrqueryid", ""), setIbkrQueryId: upd("ibkrQueryId"),
    ibkrToken: ls.get("cgt.ibkrtoken", ""), setIbkrToken: upd("ibkrToken"),
    // Credit cards (Wealth tab) — named revolving-debt balances subtracted
    // from net worth, same "own array, own setter" shape as cashAccounts.
    // See core/credit-cards.mjs. [{id, label, issuer, balance, notes}]
    creditCards: ls.get("cgt.creditcards", []), setCreditCards: upd("creditCards"),
    // Phase 3.6: named plan scenarios — [{id, name, savedAt, inputs}].
    // Full planInputs snapshots, so loading one restores the exact plan.
    scenarios: ls.get("cgt.scenarios", []), setScenarios: upd("scenarios"),
    // NOT persisted anywhere — a session-only diagnostic. Names of LARGE_KEYS
    // that have hit localStorage's quota this session, so SyncTab can tell
    // the user their data is still safe (IndexedDB has it) instead of
    // failing completely silently. See the debounced writer below.
    storageOverflow: [], setStorageOverflow: upd("storageOverflow"),
  };
});

// Persist on change — one subscription, writing only the keys that changed
// (replaces the 16 per-key useEffect hooks that serialised on every render).
//
// IndexedDB-primary storage (Phase 3.7): localStorage's ~5MB quota is a real
// ceiling once `txns`/`valuations`/etc. grow across years of use, and every
// keystroke that edits one of them used to synchronously JSON.stringify the
// WHOLE array into localStorage. Two changes fix that without touching the
// synchronous, flicker-free boot path (still `ls.get(...)` at store
// creation, above):
//   1. LARGE_KEYS (durable.js) get a short debounced localStorage write
//      instead of an immediate one, so rapid edits (typing a number
//      character-by-character, a bulk import) coalesce into one write.
//   2. If that write ever throws (QuotaExceededError), we stop retrying it
//      for the rest of the session — IndexedDB's debounced mirror below
//      still gets every change from live state regardless, so nothing is
//      lost, we just stop paying for a doomed localStorage write on every
//      change. `storageOverflow` surfaces which keys this happened to
//      (read by SyncTab) instead of failing silently.
// Settings-shaped keys (dark, planInputs, ...) are small and bounded, so
// they keep the original immediate, synchronous write.
const _largeKeyTimers = {};
const _skipLocalStorage = new Set();
function writeLargeKeyDebounced(key, lsKey, value) {
  clearTimeout(_largeKeyTimers[key]);
  _largeKeyTimers[key] = setTimeout(() => {
    if (_skipLocalStorage.has(key)) return;
    try {
      localStorage.setItem(lsKey, JSON.stringify(value === undefined ? null : value));
    } catch {
      _skipLocalStorage.add(key);
      useAppStore.setState((s) => (s.storageOverflow.includes(key) ? s : { storageOverflow: [...s.storageOverflow, key] }));
    }
  }, 300);
}

let _durableTimer = null;
function flushDurable() {
  clearTimeout(_durableTimer);
  _durableTimer = null;
  const s = useAppStore.getState();
  const byLsKey = {};
  for (const [key, lsKey] of Object.entries(PERSIST_KEYS)) byLsKey[lsKey] = s[key];
  saveDurable(byLsKey);
  saveDailySnapshot(todayISO(), byLsKey);
  // Encrypted sync push (state/sync.js) — no-op unless the user enabled
  // sync; reads state back from localStorage itself, so nothing extra
  // is passed here. Its own debounce coalesces bursts further.
  schedulePush();
}

useAppStore.subscribe((state, prev) => {
  let changed = false;
  for (const [key, lsKey] of Object.entries(PERSIST_KEYS)) {
    if (state[key] === prev[key]) continue;
    changed = true;
    if (LARGE_KEYS.includes(key)) writeLargeKeyDebounced(key, lsKey, state[key]);
    else ls.set(lsKey, state[key]);
  }
  if (!changed) return;
  clearTimeout(_durableTimer);
  _durableTimer = setTimeout(flushDurable, 1500);
});

if (typeof document !== "undefined") {
  // Best-effort durability net: if the tab is closed/backgrounded inside the
  // 1500ms debounce window above, the IndexedDB mirror (and sync push)
  // would otherwise miss the last change. "visibilitychange" to "hidden"
  // fires reliably before teardown (unlike "beforeunload", which async
  // IndexedDB writes can't outlive), so flush immediately when it does.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && _durableTimer) flushDurable();
  });
}

// Boot-time reconciliation (IndexedDB-primary, part 2): localStorage is read
// synchronously above so first paint never waits on IndexedDB, but if a
// PREVIOUS session hit localStorage's quota mid-write, localStorage can be
// left holding a shorter version of a LARGE_KEYS collection than the
// debounced IndexedDB mirror (much larger quota) has. Compare sizes once,
// shortly after boot, and adopt IndexedDB's copy where — and only where —
// it's strictly bigger (keysWhereDurableIsAhead never shrinks a key).
if (typeof window !== "undefined") {
  loadDurable().then((mirror) => {
    if (!mirror) return;
    const state = useAppStore.getState();
    const current = {};
    for (const [key, lsKey] of Object.entries(PERSIST_KEYS)) current[lsKey] = state[key];
    const ahead = keysWhereDurableIsAhead(current, mirror);
    if (!ahead.length) return;
    const patch = {};
    for (const key of ahead) patch[key] = mirror[PERSIST_KEYS[key]];
    useAppStore.setState(patch);
  }).catch(() => { /* IndexedDB unavailable — localStorage boot stands as-is */ });
}

export default useAppStore;
