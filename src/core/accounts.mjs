/* ======================================================================
   ACCOUNTS — a broker account as a first-class thing, not a free-text
   label. Pure and node-tested (accounts.test.mjs).

   Transactions have carried an `account` string ("HL ISA", "IBKR") for a
   long time, and nothing used it. Meanwhile the app kept re-deriving the
   idea of an account from other signals: reconciliation scoped by WRAPPER
   (which assumed one broker per wrapper and reported the other broker's
   holdings as discrepancies), imports asked for a wrapper and left the
   account blank, and cash sat in two unrelated lists.

   An explicit list — { id, label, broker, wrapper } — is what all of those
   were missing. The label is still what's written onto each transaction's
   `account` field (so nothing about the ledger's shape changes and old
   rows keep working); the list just makes the set of labels known,
   pickable, and attributable to a broker and wrapper.

   `knownAccounts()` merges the explicit list with any label already used
   in the ledger, so a user who never sets the list up still gets the
   right suggestions and nothing they typed in the past is orphaned.
   ====================================================================== */

const clean = (s) => String(s ?? "").trim();

export function knownAccounts(accounts = [], txns = []) {
  const byLabel = new Map();
  for (const a of accounts || []) {
    if (!a || !clean(a.label)) continue;
    byLabel.set(clean(a.label), { id: a.id || clean(a.label), label: clean(a.label), broker: clean(a.broker), wrapper: clean(a.wrapper).toUpperCase() || null, explicit: true, rows: 0 });
  }
  for (const t of txns || []) {
    const l = clean(t && t.account);
    if (!l) continue;
    if (!byLabel.has(l)) byLabel.set(l, { id: l, label: l, broker: "", wrapper: null, explicit: false, rows: 0 });
    byLabel.get(l).rows += 1;
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// Net quantity per ticker for the rows tagged with one account — the
// ledger side of a reconciliation against THAT broker's statement.
export function ledgerQtyByAccount(txns = [], accountLabel) {
  const want = clean(accountLabel);
  const out = {};
  if (!want) return out;
  for (const t of txns || []) {
    if (!t || clean(t.account) !== want || !t.ticker) continue;
    if (t.side !== "BUY" && t.side !== "SELL") continue;
    const tk = String(t.ticker).toUpperCase();
    out[tk] = (out[tk] || 0) + (t.side === "BUY" ? +t.quantity || 0 : -(+t.quantity || 0));
  }
  for (const k of Object.keys(out)) { out[k] = Math.round(out[k] * 1e4) / 1e4; if (Math.abs(out[k]) < 1e-9) delete out[k]; }
  return out;
}

// Shape the per-account quantities into the `positions` array
// reconcilePositions() expects, so the account becomes the scope instead
// of the wrapper.
export function accountPositions(txns = [], accountLabel, wrapper = "GIA") {
  return Object.entries(ledgerQtyByAccount(txns, accountLabel)).map(([ticker, qty]) => ({ ticker, wrapper, qty }));
}

// Does this account have enough ledger history to be a reconciliation
// scope on its own? On a first-ever import there are no rows yet, so the
// caller falls back to wrapper + remembered coverage.
export const accountHasRows = (txns = [], accountLabel) => Object.keys(ledgerQtyByAccount(txns, accountLabel)).length > 0;

// Re-tag ledger rows onto an account by predicate — the migration helper
// for "every row from the IBKR importer belongs to my IBKR GIA".
export function assignAccount(txns = [], accountLabel, predicate) {
  const label = clean(accountLabel);
  if (!label || typeof predicate !== "function") return { txns, changed: 0 };
  let changed = 0;
  const out = (txns || []).map((t) => {
    if (!t || !predicate(t) || clean(t.account) === label) return t;
    changed += 1;
    return { ...t, account: label };
  });
  return { txns: out, changed };
}

// The rows an import source produced, recognisable by the note it writes
// ("IBKR import", "Fidelity UK import"…) — for the one-click migration.
export const fromImportSource = (source) => (t) => new RegExp(`^${String(source).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(String(t && t.note || ""));
