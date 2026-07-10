/* ======================================================================
   DURABLE PERSISTENCE (IndexedDB) — localStorage remains the primary,
   synchronous store the app boots from, but it is fragile: browser
   cleanups, "clear site data", and Safari's 7-day ITP eviction can wipe
   years of transaction history. This module mirrors every persisted key
   into IndexedDB (far less eviction-prone, much larger quota) and, at
   boot, restores localStorage from the mirror when it has been emptied.
   It also keeps a rolling window of daily full-state snapshots as a
   corruption fallback.

   Dependency-free on purpose (no React/JSX imports) so the pure parts run
   under `node --test` (durable.test.mjs). Every IndexedDB call is wrapped:
   if IndexedDB is unavailable (private windows, old browsers), everything
   degrades silently to localStorage-only — exactly the previous behaviour.
   ====================================================================== */

// state key -> localStorage key. Single source of truth (appStore imports
// this) so a new persisted key can never be silently missing from the
// durable mirror.
export const PERSIST_KEYS = {
  dark: "cgt.dark",
  txns: "cgt.txns",
  tab: "cgt.tab",
  income: "cgt.income",
  carried: "cgt.carried",
  cash: "cgt.cash",
  pensionCashflows: "cgt.pensioncf",
  dmoReportDate: "cgt.dmoreportdate",
  valuations: "cgt.valuations",
  netWorthSnapshots: "cgt.networthsnapshots",
  incomeEntries: "cgt.incomeEntries",
  eriEntries: "cgt.eriEntries",
  prices: "cgt.prices",
  avKey: "cgt.avkey",
  avMeta: "cgt.avmeta",
  priceMeta: "cgt.pricemeta",
  secMeta: "cgt.secmeta",
  properties: "cgt.properties",
  mortgages: "cgt.mortgages",
  otherLiabilities: "cgt.otherliabilities",
  cashAccounts: "cgt.cashaccounts",
  allowanceOverrides: "cgt.allowanceoverrides",
  planInputs: "cgt.planinputs",
  privateHoldings: "cgt.privateholdings",
  privateEvents: "cgt.privateevents",
  rsuGrants: "cgt.rsugrants",
  rsuEvents: "cgt.rsuevents",
  ibkrQueryId: "cgt.ibkrqueryid",
  ibkrToken: "cgt.ibkrtoken",
  creditCards: "cgt.creditcards",
};
// Present in any real dataset — used to detect "localStorage was emptied".
const SENTINEL_LS_KEYS = ["cgt.txns", "cgt.valuations", "cgt.pensioncf"];

const DB_NAME = "wealth-dashboard";
const DB_VERSION = 1;
const KV = "kv";            // one record per localStorage key (live mirror)
const SNAPS = "snapshots";  // one record per day (full persisted state)
export const SNAPSHOT_KEEP = 30;

// Which snapshot dates to delete so only the newest `keep` remain.
// Pure — tested in durable.test.mjs.
export function snapshotDatesToPrune(dates, keep = SNAPSHOT_KEEP) {
  return [...dates].sort().slice(0, Math.max(0, dates.length - keep));
}

// Should boot restore from the durable mirror? Only when localStorage holds
// none of the sentinel data keys AND the mirror has something real.
// Pure — tested in durable.test.mjs.
export function shouldRestore(lsKeysPresent, mirrorKeys) {
  const lsHasData = SENTINEL_LS_KEYS.some((k) => lsKeysPresent.includes(k));
  const mirrorHasData = SENTINEL_LS_KEYS.some((k) => mirrorKeys.includes(k));
  return !lsHasData && mirrorHasData;
}

/* --------------------------- IndexedDB plumbing ----------------------- */
function openDb() {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
        if (!db.objectStoreNames.contains(SNAPS)) db.createObjectStore(SNAPS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
const txDone = (tx) => new Promise((resolve) => {
  tx.oncomplete = () => resolve(true);
  tx.onerror = () => resolve(false);
  tx.onabort = () => resolve(false);
});

// Mirror the full persisted state (object keyed by localStorage key, values
// already JSON-serialisable). Fire-and-forget safe.
export async function saveDurable(stateByLsKey) {
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(KV, "readwrite");
    const os = tx.objectStore(KV);
    for (const [k, v] of Object.entries(stateByLsKey)) os.put(v === undefined ? null : v, k);
    os.put(new Date().toISOString(), "__savedAt");
    const ok = await txDone(tx);
    db.close();
    return ok;
  } catch { try { db.close(); } catch { /* noop */ } return false; }
}

export async function loadDurable() {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(KV, "readonly");
    const os = tx.objectStore(KV);
    const out = {};
    await new Promise((resolve) => {
      const req = os.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        if (cur.key !== "__savedAt") out[cur.key] = cur.value;
        cur.continue();
      };
      req.onerror = () => resolve();
    });
    await txDone(tx);
    db.close();
    return Object.keys(out).length ? out : null;
  } catch { try { db.close(); } catch { /* noop */ } return null; }
}

// One full-state snapshot per day, pruned to the newest SNAPSHOT_KEEP.
export async function saveDailySnapshot(dateISO, stateByLsKey) {
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(SNAPS, "readwrite");
    const os = tx.objectStore(SNAPS);
    os.put({ savedAt: new Date().toISOString(), state: stateByLsKey }, dateISO);
    const dates = await new Promise((resolve) => {
      const req = os.getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    for (const d of snapshotDatesToPrune(dates)) os.delete(d);
    const ok = await txDone(tx);
    db.close();
    return ok;
  } catch { try { db.close(); } catch { /* noop */ } return false; }
}

/* ------------------------------ boot path ----------------------------- */
// Called before the app module loads (main.jsx). If localStorage has been
// emptied but the durable mirror has data, write the mirror back so the
// synchronous store boot reads it as if nothing happened.
export async function restoreLocalStorageIfEvicted() {
  try {
    const lsKeys = [];
    for (const k of Object.values(PERSIST_KEYS)) if (localStorage.getItem(k) != null) lsKeys.push(k);
    const mirror = await loadDurable();
    if (!mirror) return { restored: false, reason: lsKeys.length ? "localStorage intact" : "no durable mirror yet" };
    if (!shouldRestore(lsKeys, Object.keys(mirror))) return { restored: false, reason: "localStorage intact" };
    let n = 0;
    for (const [k, v] of Object.entries(mirror)) {
      if (v == null) continue;
      try { localStorage.setItem(k, JSON.stringify(v)); n++; } catch { /* quota */ }
    }
    return { restored: n > 0, keys: n };
  } catch { return { restored: false, reason: "restore failed" }; }
}
