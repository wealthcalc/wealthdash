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
import { store as ls, SAMPLE, SECURITY_SEED } from "../ui/shared.jsx";

// state key -> localStorage key (unchanged from the pre-store app)
const PERSIST_KEYS = {
  dark: "cgt.dark",
  txns: "cgt.txns",
  tab: "cgt.tab",
  income: "cgt.income",
  carried: "cgt.carried",
  cash: "cgt.cash",
  pensionCashflows: "cgt.pensioncf",
  dmoReportDate: "cgt.dmoreportdate",
  valuations: "cgt.valuations",
  incomeEntries: "cgt.incomeEntries",
  eriEntries: "cgt.eriEntries",
  prices: "cgt.prices",
  avKey: "cgt.avkey",
  avMeta: "cgt.avmeta",
  priceMeta: "cgt.pricemeta",
  secMeta: "cgt.secmeta",
};

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
  };
});

// Persist on change — one subscription, writing only the keys that changed
// (replaces the 16 per-key useEffect hooks that serialised on every render).
useAppStore.subscribe((state, prev) => {
  for (const [key, lsKey] of Object.entries(PERSIST_KEYS)) {
    if (state[key] !== prev[key]) ls.set(lsKey, state[key]);
  }
});

export default useAppStore;
