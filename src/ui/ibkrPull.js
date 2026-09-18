/* ======================================================================
   IBKR FLEX PULL — the network half of the Import tab's "Pull from IBKR",
   extracted so the Home tab's "IBKR — last imported N days ago" item can
   run it in place instead of sending the user three clicks away to press
   a button.

   Deliberately NOT an auto-import. The pull fetches and shapes; the review
   (dedupe badges, near-duplicate groups, the statement-vs-its-own-positions
   cross-check, the reconciliation panel) stays on the Import tab, because
   that review is the whole reason a bad Flex Query can't quietly triple a
   holding. So: Home pulls, hands the result over, and navigates; the Import
   tab picks it up on mount and shows exactly what it always showed.

   The token never leaves the device except in the POST body to the app's
   own proxy (api/ibkr-flex.mjs), same as before.
   ====================================================================== */
import { shapeFlexPull, shapeCashReport } from "../core/ibkr-flex.mjs";

export async function pullFromIbkr({ token, queryId, wrapper = "GIA", seedByIsin = {} } = {}) {
  if (!String(token || "").trim() || !String(queryId || "").trim()) {
    throw new Error("Enter both your Flex Query ID and token on the Import tab first.");
  }
  // POST body, not query string — a GET query puts the Flex token in
  // Vercel's request logs (api/ibkr-flex.mjs rejects GET for this reason).
  const r = await fetch("/api/ibkr-flex", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: String(token).trim(), queryId: String(queryId).trim() }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `IBKR pull failed (${r.status}).`);
  return { ib: shapeFlexPull(j, { defaultWrapper: wrapper, seedByIsin }), cashReport: shapeCashReport(j) };
}

// One-slot hand-off between the tab that pulled and the tab that reviews.
// Module state rather than persisted state on purpose: a pull result is a
// moment's data, not something to survive a reload.
let _pending = null;
export const stashPull = (result) => { _pending = result ? { ...result, at: Date.now() } : null; };
export const takePendingPull = () => { const p = _pending; _pending = null; return p; };
