/* ======================================================================
   UNDO FOR DELETES — the app's answer to "one misclick silently changed
   my CGT position".

   Why a toast rather than a confirm dialog: a confirm makes EVERY delete
   slower to punish the rare mistake, and people learn to dismiss it
   without reading, which restores the original risk while adding
   friction. An undo makes the common case instant and the rare case
   recoverable — the correct trade for destructive-but-reversible actions.
   (TwoStepDelete remains where it guards something genuinely
   irreversible in bulk, like clearing a whole ledger.)

   Restoration puts the row back at its ORIGINAL INDEX, not on the end.
   Several tables here are order-sensitive to the user's eye even when the
   engine sorts internally — a restored row appearing in a different place
   reads as "that didn't work" and invites a second, worse correction.

   The queue is deliberately single-slot: a second delete commits the
   first. Stacking undos would mean holding an unbounded amount of deleted
   state and asking the user to reason about a history they can't see.
   ====================================================================== */
import React, { useEffect, useState } from "react";
import { Undo2, X } from "lucide-react";

const DEFAULT_MS = 8000;

let _current = null;          // { id, message, onUndo, expiresAt }
let _timer = null;
const _subs = new Set();
const _emit = () => { for (const fn of _subs) fn(); };

function clear() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _current = null;
  _emit();
}

// Show an undo offer. Any pending offer is committed (dropped) first.
export function showUndo({ message, onUndo, ms = DEFAULT_MS }) {
  if (_timer) clearTimeout(_timer);
  _current = { id: Math.random().toString(36).slice(2), message, onUndo };
  _timer = setTimeout(clear, ms);
  _emit();
}

// The one call sites use. `list` is passed in (rather than read inside a
// state updater) so this stays free of side effects in the updater —
// React StrictMode invokes updaters twice, and capturing the removed row
// in there would double-fire the toast.
export function removeWithUndo({ list = [], setList, id, label = "item", match }) {
  const pred = match || ((x) => x.id === id);
  const idx = list.findIndex(pred);
  if (idx < 0) return false;
  const item = list[idx];
  setList((prev) => prev.filter((x) => !pred(x)));
  showUndo({
    message: `Deleted ${label}`,
    onUndo: () => setList((prev) => {
      // Re-inserting at the captured index is right unless the list has
      // since shrunk past it (another delete), where clamping is the only
      // sane option.
      const next = [...prev];
      next.splice(Math.min(idx, next.length), 0, item);
      return next;
    }),
  });
  return true;
}

export function UndoToast() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    _subs.add(fn);
    return () => { _subs.delete(fn); };
  }, []);
  const cur = _current;
  if (!cur) return null;
  return (
    <div role="status" aria-live="polite"
      style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 20, zIndex: 60 }}>
      <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-lg px-3 py-2 text-sm">
        <span className="text-[var(--fg)]">{cur.message}</span>
        <button
          onClick={() => { const u = cur.onUndo; clear(); u && u(); }}
          className="inline-flex items-center gap-1.5 text-[var(--accent)] font-semibold hover:underline">
          <Undo2 size={14} aria-hidden="true" /> Undo
        </button>
        <button onClick={clear} aria-label="Dismiss" className="text-[var(--muted)] hover:text-[var(--fg)]">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
