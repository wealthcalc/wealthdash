/* ======================================================================
   BACKUP BUILD + RESTORE — generated from PERSIST_KEYS instead of two
   hand-maintained lists. The old shape was version 14: an export object
   assembled field-by-field in CgtDashboard.jsx and a restore made of ~25
   hand-written `if (Array.isArray(d.x)) setX(...)` lines — which meant a
   new persisted key had to be remembered in BOTH places or it silently
   fell out of backups (the durable mirror solved this exact class of bug
   with a single source of truth + an exhaustiveness test; this applies
   the same medicine to backups). backup.test.mjs fails if a new
   PERSIST_KEYS entry is missing from the TYPES table below.

   v17 adds the Budget tab's `budgetCategories`/`budgetRules`/`spendTxns`
   (core/budget.mjs, core/categorise.mjs); older files omit them and
   restore unchanged. Note `spendTxns` holds bank/card statement rows —
   the most personally identifying data in the file — which is exactly why
   backups stay local and sync is end-to-end encrypted.

   v16 adds `deferredCashAwards`/`deferredCashVests` (deferred-cash comp —
   core/deferred-cash.mjs); older files simply omit them and restore
   unchanged. v15 added `fees` (s38 dealing costs) and `account` (broker
   label) inside the txns array, so v14-and-earlier files restore unchanged.

   Deliberate policy, unchanged from v13/v14:
   - EXCLUDED from export: secrets (avKey, ibkrToken — plaintext in a file
     that lands in Downloads outlives every other secret decision), UI
     state (dark, tab) and pure caches (dmoReportDate).
   - RESTORE-ONLY: avKey/ibkrToken are still ACCEPTED from v12-and-earlier
     files so old backups lose nothing.
   - secMeta MERGES over the seed rather than replacing it.
   Imports PERSIST_KEYS from state/durable.js — that module is
   deliberately dependency-free/pure (its own header says so), so this
   stays node-testable.
   ====================================================================== */
import { PERSIST_KEYS } from "../state/durable.js";

export const BACKUP_VERSION = 17;

export const EXPORT_EXCLUDED = ["dark", "tab", "dmoReportDate", "avKey", "ibkrToken"];
export const RESTORE_ONLY = ["avKey", "ibkrToken"];
// Arrays of records that get a uid() refill on restore (pre-id-era rows).
export const ID_ARRAYS = [
  "txns", "incomeEntries", "eriEntries", "pensionCashflows", "properties", "mortgages",
  "otherLiabilities", "cashAccounts", "privateHoldings", "privateEvents", "rsuGrants",
  "rsuEvents", "deferredCashAwards", "deferredCashVests", "creditCards", "scenarios",
  "budgetCategories", "budgetRules", "spendTxns",
];
// Keys merged into current state rather than replacing it.
export const MERGE_KEYS = ["secMeta"];

// Expected JSON type per state key — the restore's validation table. The
// exhaustiveness test asserts every exported key appears here.
const TYPES = {
  txns: "array", incomeEntries: "array", eriEntries: "array", valuations: "array",
  netWorthSnapshots: "array", pensionCashflows: "array", properties: "array",
  mortgages: "array", otherLiabilities: "array", cashAccounts: "array",
  privateHoldings: "array", privateEvents: "array", rsuGrants: "array",
  rsuEvents: "array", deferredCashAwards: "array", deferredCashVests: "array",
  creditCards: "array", scenarios: "array",
  budgetCategories: "array", budgetRules: "array", spendTxns: "array",
  cash: "object", prices: "object", priceMeta: "object", avMeta: "object",
  secMeta: "object", allowanceOverrides: "object", planInputs: "object",
  income: "number", carried: "number",
  ibkrQueryId: "string", avKey: "string", ibkrToken: "string",
};

export const exportedKeys = () => Object.keys(PERSIST_KEYS).filter((k) => !EXPORT_EXCLUDED.includes(k));

const typeOk = (type, v) =>
  type === "array" ? Array.isArray(v)
    : type === "object" ? (v && typeof v === "object" && !Array.isArray(v))
      : typeof v === type;

// state: { stateKey: value } (e.g. the Zustand store's current state).
export function buildBackup(state, { now = new Date().toISOString() } = {}) {
  const out = { __cgtBackup: true, version: BACKUP_VERSION, exportedAt: now };
  for (const k of exportedKeys()) if (state[k] !== undefined && state[k] !== null) out[k] = state[k];
  return out;
}

// data: parsed JSON. Returns { updates, merges, skipped, counts, legacy }
// or { error }. `updates[stateKey]` replaces; `merges[stateKey]` shallow-
// merges over current state. Never throws on foreign shapes — a backup
// file is user input.
export function restorePlan(data, { uid = () => Math.random().toString(36).slice(2) } = {}) {
  const refill = (arr) => arr.map((x) => (x && typeof x === "object" && !x.id ? { ...x, id: uid() } : x));

  if (Array.isArray(data)) {
    // Legacy export: a bare transaction array, nothing else.
    return { legacy: true, updates: { txns: refill(data) }, merges: {}, skipped: [], counts: { txns: data.length } };
  }
  if (!data || typeof data !== "object" || !data.__cgtBackup) {
    return { error: "That file isn't a recognised backup — expected a transaction array or a full backup file exported from this app." };
  }

  const updates = {}, merges = {}, skipped = [], counts = {};
  for (const key of [...exportedKeys(), ...RESTORE_ONLY]) {
    const v = data[key];
    if (v === undefined || v === null) continue;
    const type = TYPES[key];
    if (!type || !typeOk(type, v)) { skipped.push(key); continue; }
    const value = type === "array" && ID_ARRAYS.includes(key) ? refill(v) : v;
    if (MERGE_KEYS.includes(key)) merges[key] = value; else updates[key] = value;
    if (type === "array") counts[key] = v.length;
  }
  return { legacy: false, updates, merges, skipped, counts };
}
