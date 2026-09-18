import { test } from "node:test";
import assert from "node:assert/strict";
import { knownAccounts, ledgerQtyByAccount, accountPositions, accountHasRows, assignAccount, fromImportSource } from "../core/accounts.mjs";
import { reconcilePositions } from "../core/position-reconcile.mjs";

const TXNS = [
  { id: "1", date: "2026-08-21", ticker: "TG30", side: "BUY", quantity: 18000, wrapper: "GIA", account: "IBKR GIA", note: "IBKR import" },
  { id: "2", date: "2026-09-02", ticker: "TG36", side: "BUY", quantity: 10000, wrapper: "GIA", account: "IBKR GIA", note: "IBKR import" },
  { id: "3", date: "2026-01-10", ticker: "BNKR", side: "BUY", quantity: 5187, wrapper: "GIA", account: "Fidelity GIA", note: "Fidelity UK import" },
  { id: "4", date: "2026-03-10", ticker: "TG30", side: "SELL", quantity: 3000, wrapper: "GIA", account: "IBKR GIA" },
  { id: "5", date: "2025-11-15", ticker: "WFC", side: "BUY", quantity: 160, wrapper: "GIA", account: "", note: "RSU vest" },
];

test("known accounts merge the explicit list with labels already in the ledger", () => {
  const list = knownAccounts(
    [{ id: "acc1", label: "IBKR GIA", broker: "Interactive Brokers", wrapper: "GIA" }],
    TXNS,
  );
  const by = Object.fromEntries(list.map((a) => [a.label, a]));
  assert.equal(by["IBKR GIA"].explicit, true);
  assert.equal(by["IBKR GIA"].broker, "Interactive Brokers");
  assert.equal(by["IBKR GIA"].rows, 3);
  assert.equal(by["Fidelity GIA"].explicit, false, "a label only ever typed on rows still counts");
  assert.equal(by["Fidelity GIA"].rows, 1);
  assert.ok(!("" in by), "blank is not an account");
});

test("net quantity per ticker for one account — the ledger side of a broker reconciliation", () => {
  const q = ledgerQtyByAccount(TXNS, "IBKR GIA");
  assert.deepEqual(q, { TG30: 15000, TG36: 10000 }, "sold 3,000 of the 18,000; BNKR is Fidelity's, WFC is untagged");
  assert.deepEqual(ledgerQtyByAccount(TXNS, "nobody"), {});
  assert.deepEqual(ledgerQtyByAccount(TXNS, ""), {});
});

test("the whole point: scoping reconciliation to the account, not the wrapper", () => {
  // The IBKR statement reports TG30 and TG36. Under wrapper scoping BNKR
  // and WFC (same GIA wrapper, different brokers) were 'not in this
  // statement' noise on every import. Under account scoping they simply
  // aren't in the comparison — they're not this account's rows.
  const positions = accountPositions(TXNS, "IBKR GIA", "GIA");
  const { rows, summary } = reconcilePositions({
    broker: [{ ticker: "TG30", qty: 15000 }, { ticker: "TG36", qty: 10000 }],
    positions,
  });
  assert.equal(summary.clean, true);
  assert.equal(summary.notAtBroker, 0, "nothing out of scope — the scope is exactly this account");
  assert.deepEqual(rows.map((r) => r.ticker).sort(), ["TG30", "TG36"]);

  // And a genuine discrepancy inside the account is still caught.
  const bad = reconcilePositions({ broker: [{ ticker: "TG30", qty: 18000 }, { ticker: "TG36", qty: 10000 }], positions });
  assert.equal(bad.summary.missingInLedger, 1, "the broker says 18,000; the ledger's sale to 15,000 may be spurious — or a re-buy is missing");
});

test("an account with no rows yet can't be a scope — the caller falls back", () => {
  assert.equal(accountHasRows(TXNS, "IBKR GIA"), true);
  assert.equal(accountHasRows(TXNS, "New broker"), false);
});

test("one-click migration: tag every row an importer wrote onto its account", () => {
  const { txns, changed } = assignAccount(TXNS.map((t) => ({ ...t, account: "" })), "IBKR GIA", fromImportSource("IBKR"));
  assert.equal(changed, 2, "the two rows whose note begins 'IBKR'");
  assert.equal(txns.find((t) => t.id === "1").account, "IBKR GIA");
  assert.equal(txns.find((t) => t.id === "3").account, "", "Fidelity's row is left alone");
  assert.equal(txns.find((t) => t.id === "5").account, "", "'RSU vest' isn't an import note");
  // Idempotent: running it again changes nothing.
  assert.equal(assignAccount(txns, "IBKR GIA", fromImportSource("IBKR")).changed, 0);
  assert.equal(assignAccount(TXNS, "", fromImportSource("IBKR")).changed, 0, "no label, no change");
});

test("fromImportSource matches the note prefix, not a substring", () => {
  assert.equal(fromImportSource("IBKR")({ note: "IBKR import" }), true);
  assert.equal(fromImportSource("IBKR")({ note: "Fidelity UK import" }), false);
  assert.equal(fromImportSource("Fidelity UK")({ note: "Fidelity UK import" }), true);
  assert.equal(fromImportSource("IBKR")({ note: "" }), false);
  assert.equal(fromImportSource("IBKR")({}), false);
});
