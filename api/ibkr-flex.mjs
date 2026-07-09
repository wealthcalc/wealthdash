// Vercel serverless function: IBKR Flex Web Service proxy.
//
// Why this exists: IBKR's Flex Web Service (ndcdyn.interactivebrokers.com)
// doesn't send CORS headers for arbitrary browser origins, so the two-step
// SendRequest -> GetStatement flow has to run server-side, same reason
// api/quotes.mjs proxies Yahoo. The token and query ID are supplied by the
// CLIENT on every call — same pattern as the Alpha Vantage key elsewhere
// in this app — and are never written to disk, logged, or stored here.
// This function is stateless: it exists purely to get around the browser
// CORS restriction, not to hold IBKR credentials.
//
// GET /api/ibkr-flex?token=...&queryId=...
//   -> { accountId, trades: [...], cashTransactions: [...], cashReport: [...], openPositions: [...] }
//   Every array element is a plain { normalisedAttrName: value } object —
//   shaping into the app's trade/income record format happens client-side,
//   in src/core/ibkr-flex.mjs (reusing the exact same row-mapping rules as
//   the pasted-CSV IBKR import, so the two paths can't silently diverge).
//
// IBKR generates the statement asynchronously: GetStatement returns a
// "not ready yet" Fail response until it's done (usually a few seconds),
// so this retries with a short backoff before giving up.

import { extractElements, parseFlexStatementResponse, isFlexStatement, extractStatementInfo } from "./_lib/ibkr-flex-xml.mjs";

const SEND_URL = (token, queryId) =>
  `https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`;
const GET_URL = (token, refCode) =>
  `https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement?t=${encodeURIComponent(token)}&q=${encodeURIComponent(refCode)}&v=3`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IBKR_HEADERS = { "User-Agent": "WealthDashboard/1.0", Accept: "application/xml" };
const MAX_ATTEMPTS = 5;

export default async function handler(req, res) {
  const token = (req.query?.token ?? "").toString().trim();
  const queryId = (req.query?.queryId ?? "").toString().trim();
  if (!token || !queryId) {
    res.status(400).json({ error: "Pass ?token=... and ?queryId=... (from IBKR's Flex Web Service Configuration page and your Flex Query's ID)." });
    return;
  }

  try {
    // Step 1: SendRequest — kicks off report generation, returns a
    // reference code used to collect it in step 2.
    const sendRes = await fetch(SEND_URL(token, queryId), { headers: IBKR_HEADERS });
    const sendXml = await sendRes.text();
    const sendParsed = parseFlexStatementResponse(sendXml);
    if (sendParsed.status !== "Success" || !sendParsed.referenceCode) {
      res.status(502).json({ error: sendParsed.errorMessage || "IBKR rejected the request — check your token and query ID.", errorCode: sendParsed.errorCode });
      return;
    }

    // Step 2: GetStatement, retried with backoff until the report is ready
    // or we give up.
    let statementXml = null, lastError = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(1200 * attempt);
      const getRes = await fetch(GET_URL(token, sendParsed.referenceCode), { headers: IBKR_HEADERS });
      const getXml = await getRes.text();
      if (isFlexStatement(getXml)) { statementXml = getXml; break; }
      const getParsed = parseFlexStatementResponse(getXml);
      lastError = getParsed.errorMessage || "Statement not ready yet.";
    }
    if (!statementXml) {
      res.status(504).json({ error: `IBKR's report was still generating after several attempts (${lastError || "unknown reason"}) — try again in a moment.` });
      return;
    }

    const info = extractStatementInfo(statementXml);
    res.status(200).json({
      ...info,
      trades: extractElements(statementXml, "Trade"),
      cashTransactions: extractElements(statementXml, "CashTransaction"),
      // Not every Flex Query includes Cash Transactions — Interest Accruals
      // is a common alternative that at least covers interest (not
      // dividends), so it's pulled too and shaped separately client-side.
      interestAccruals: extractElements(statementXml, "InterestAccrualsCurrency"),
      cashReport: extractElements(statementXml, "CashReportCurrency"),
      openPositions: extractElements(statementXml, "OpenPosition"),
    });
  } catch (e) {
    res.status(502).json({ error: (e && e.message) || "IBKR fetch failed." });
  }
}
