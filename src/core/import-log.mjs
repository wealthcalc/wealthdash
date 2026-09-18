/* ======================================================================
   IMPORT LOG — every import is a BATCH, and a batch can be undone.

   Before this, an import appended rows to the ledger and forgot it had.
   Undo existed for single deletes in three tabs; an import that went wrong
   (a Flex Query emitting one trade three times, say) had to be unpicked
   row by row, and there was no way even to list what the last import had
   added — the rows carried a note ("IBKR import") and nothing else.

   Now: rows are stamped with a batchId at import time, the log records
   what each batch was (source, account, counts, when), and undoing a batch
   is "remove every row carrying its id" — exact, whole, and reversible in
   the ordinary way if it turns out to have been right after all.

   Pure and node-tested (import-log.test.mjs). The log is persisted state
   (PERSIST_KEYS.importLog); this module only shapes it.
   ====================================================================== */

export const IMPORT_LOG_KEEP = 200;

let _n = 0;
export const newBatchId = (now = Date.now()) => `b${now.toString(36)}${(_n++ % 1296).toString(36).padStart(2, "0")}`;

// Attach a batch id to a set of freshly-built rows (never to rows already
// in the ledger — an import doesn't own what was there before it).
export function stampBatch(rows = [], batchId) {
  if (!batchId) return rows;
  return rows.map((r) => ({ ...r, batchId }));
}

// Build the log entry for a completed import. `latest` items appear first.
export function recordImport(log = [], entry = {}, { now = new Date().toISOString(), keep = IMPORT_LOG_KEEP } = {}) {
  const rec = {
    id: entry.batchId,
    batchId: entry.batchId,
    at: now,
    source: entry.source || "import",
    account: entry.account || "",
    wrapper: entry.wrapper || "",
    txns: +entry.txns || 0,
    income: +entry.income || 0,
    other: +entry.other || 0,           // pension cashflows, ERI rows, RSU events…
    skipped: +entry.skipped || 0,
    note: entry.note || "",
  };
  if (!rec.batchId) throw new Error("recordImport requires a batchId");
  return [rec, ...(log || []).filter((e) => e && e.batchId !== rec.batchId)].slice(0, keep);
}

// The most recent batch that actually added something — the one "undo last
// import" should mean. Empty imports (all rows deduped away) aren't it.
export function latestUndoable(log = []) {
  return (log || []).find((e) => e && (e.txns > 0 || e.income > 0 || e.other > 0)) || null;
}

// Remove a batch from the rows it touched. Returns the surviving rows AND
// the removed ones, so the caller can offer an undo of the undo.
export function removeBatch(rows = [], batchId) {
  const removed = [], kept = [];
  for (const r of rows || []) (r && r.batchId === batchId ? removed : kept).push(r);
  return { kept, removed };
}

export function dropLogEntry(log = [], batchId) {
  return (log || []).filter((e) => e && e.batchId !== batchId);
}

// Days since each source last delivered rows — replaces the device-local
// "cgt.lastImportAt" timestamp, so the Home freshness nudge is driven by
// the same record that undo uses, and survives a browser cleanup or a
// second device via backup/sync.
export function importAges(log = [], today) {
  const seen = new Map();
  for (const e of log || []) {
    if (!e || !e.source || !e.at) continue;
    if (!(e.txns > 0 || e.income > 0 || e.other > 0)) continue;
    const day = String(e.at).slice(0, 10);
    if (!seen.has(e.source) || seen.get(e.source) < day) seen.set(e.source, day);
  }
  const t = new Date(String(today).slice(0, 10) + "T00:00:00Z").getTime();
  return [...seen.entries()].map(([source, day]) => ({
    source, lastAt: day, days: Math.max(0, Math.floor((t - new Date(day + "T00:00:00Z").getTime()) / 86400000)),
  }));
}
