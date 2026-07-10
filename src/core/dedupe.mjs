/* ======================================================================
   IMPORT DEDUPE — pure logic, shared by every CSV/API import path
   (IBKR, generic CSV, dividends CSV, pension contributions, ERI, RSU).

   Broker/provider exports commonly overlap a previous import (a wider
   date-range re-export is the normal case, not an edge case) — without
   this, re-pasting/re-uploading/re-pulling the same data silently doubled
   every affected row. `keyFn` reduces a row to a comparable string;
   anything matching a key already in `existing`, or a repeat within the
   same batch, is dropped rather than appended twice.

   `keyFn` can be a single function OR an array of functions, checked in
   order — a row counts as a duplicate if ANY of them produce a match. This
   is what lets the IBKR import path prefer an exact IBKR tradeID/
   transactionID match (immune to rounding/formatting drift between two
   pulls of the same trade) while still falling back to the original
   content-based key (date/ticker/side/wrapper/quantity/amount) for rows
   that don't carry an IBKR id — e.g. anything imported before this field
   existed, or a manually-entered row. A key function returning null/
   undefined for a given row (e.g. the id-based key on a row with no id)
   is treated as "this function doesn't apply to this row" rather than a
   match against other null-keyed rows, so two unrelated no-id rows never
   collide with each other on that account.
   ====================================================================== */
export function dedupeAgainstExisting(newRows, existing, keyFn) {
  const keyFns = Array.isArray(keyFn) ? keyFn : [keyFn];
  const seenSets = keyFns.map((fn) => new Set(existing.map(fn).filter((k) => k != null)));
  const rows = [];
  let skipped = 0;
  for (const row of newRows) {
    const rowKeys = keyFns.map((fn) => fn(row));
    const isDup = rowKeys.some((k, i) => k != null && seenSets[i].has(k));
    if (isDup) { skipped++; continue; }
    rowKeys.forEach((k, i) => { if (k != null) seenSets[i].add(k); });
    rows.push(row);
  }
  return { rows, skipped };
}
