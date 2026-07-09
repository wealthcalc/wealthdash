import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractElements, decodeXmlEntities, parseFlexStatementResponse, isFlexStatement, extractAccountId, extractStatementInfo,
} from "../../api/_lib/ibkr-flex-xml.mjs";

const SAMPLE_STATEMENT = `<?xml version="1.0"?>
<FlexQueryResponse queryName="Test" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U1234567" fromDate="20250101" toDate="20260101" period="LastYear" whenGenerated="20260709;120000">
<Trades>
<Trade accountId="U1234567" symbol="WFC" description="WELLS FARGO &amp; CO" isin="US9497461015" currency="USD" fxRateToBase="0.7854" assetCategory="STK" tradeID="1001" tradeDate="20250315" quantity="50" tradePrice="45.23" proceeds="-2261.50" ibCommission="-1.00" buySell="BUY" netCash="-2262.50"/>
<Trade accountId="U1234567" symbol="WFC" description="WELLS FARGO &amp; CO" isin="US9497461015" currency="USD" fxRateToBase="0.79" assetCategory="STK" tradeID="1002" tradeDate="20250601" quantity="20" tradePrice="50.00" proceeds="1000.00" ibCommission="-1.00" buySell="SELL" netCash="999.00"/>
</Trades>
<CashTransactions>
<CashTransaction accountId="U1234567" symbol="WFC" isin="US9497461015" currency="USD" fxRateToBase="0.785" type="Dividends" amount="35.00" dateTime="20250601;000000" settleDate="20250601"/>
<CashTransaction accountId="U1234567" symbol="" isin="" currency="GBP" fxRateToBase="1" type="Broker Interest Received" amount="12.34" dateTime="20250701;000000" settleDate="20250701"/>
</CashTransactions>
<CashReport>
<CashReportCurrency accountId="U1234567" currency="USD" endingCash="500.25" endingSettledCash="500.25"/>
<CashReportCurrency accountId="U1234567" currency="GBP" endingCash="120.00" endingSettledCash="120.00"/>
<CashReportCurrency accountId="U1234567" currency="BASE_SUMMARY" endingCash="900.00" endingSettledCash="900.00"/>
</CashReport>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>`;

/* ------------------------------ decodeXmlEntities --------------------------- */

test("decodeXmlEntities: unescapes the standard XML entities", () => {
  assert.equal(decodeXmlEntities("WELLS FARGO &amp; CO"), "WELLS FARGO & CO");
  assert.equal(decodeXmlEntities("&lt;a&gt;&quot;x&quot;&apos;y&apos;"), "<a>\"x\"'y'");
});

/* ------------------------------- extractElements ----------------------------- */

test("extractElements: pulls every Trade row with normalised attribute keys", () => {
  const trades = extractElements(SAMPLE_STATEMENT, "Trade");
  assert.equal(trades.length, 2);
  assert.equal(trades[0].symbol, "WFC");
  assert.equal(trades[0].tradedate, "20250315"); // "tradeDate" -> "tradedate"
  assert.equal(trades[0].buysell, "BUY");
  assert.equal(trades[0].fxratetobase, "0.7854");
});

test("extractElements: decodes XML entities inside attribute values", () => {
  const trades = extractElements(SAMPLE_STATEMENT, "Trade");
  assert.equal(trades[0].description, "WELLS FARGO & CO");
});

test("extractElements: returns [] for a tag that doesn't appear, and for empty input", () => {
  assert.deepEqual(extractElements(SAMPLE_STATEMENT, "NoSuchTag"), []);
  assert.deepEqual(extractElements("", "Trade"), []);
  assert.deepEqual(extractElements(null, "Trade"), []);
});

test("extractElements: pulls CashTransaction and CashReportCurrency rows too", () => {
  const cash = extractElements(SAMPLE_STATEMENT, "CashTransaction");
  assert.equal(cash.length, 2);
  assert.equal(cash[0].type, "Dividends");
  const report = extractElements(SAMPLE_STATEMENT, "CashReportCurrency");
  assert.equal(report.length, 3);
  assert.ok(report.some((r) => r.currency === "BASE_SUMMARY"));
});

/* ------------------------- parseFlexStatementResponse ------------------------ */

test("parseFlexStatementResponse: Success response carries reference code and url", () => {
  const xml = `<FlexStatementResponse timestamp="28 August, 2012 10:37 AM EDT">
<Status>Success</Status>
<ReferenceCode>1234567890</ReferenceCode>
<url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</url>
</FlexStatementResponse>`;
  const r = parseFlexStatementResponse(xml);
  assert.equal(r.status, "Success");
  assert.equal(r.referenceCode, "1234567890");
  assert.equal(r.url, "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement");
});

test("parseFlexStatementResponse: Fail response carries error code and decoded message", () => {
  const xml = `<FlexStatementResponse timestamp="28 August, 2012 10:37 AM EDT">
<Status>Fail</Status>
<ErrorCode>1012</ErrorCode>
<ErrorMessage>Token has expired.</ErrorMessage>
</FlexStatementResponse>`;
  const r = parseFlexStatementResponse(xml);
  assert.equal(r.status, "Fail");
  assert.equal(r.errorCode, "1012");
  assert.equal(r.errorMessage, "Token has expired.");
});

test("parseFlexStatementResponse: unrecognisable input reports Fail rather than throwing", () => {
  const r = parseFlexStatementResponse("not xml at all");
  assert.equal(r.status, "Fail");
  assert.ok(r.errorMessage);
});

/* ------------------------------ isFlexStatement ------------------------------ */

test("isFlexStatement: true for an actual statement, false for the status wrapper", () => {
  assert.equal(isFlexStatement(SAMPLE_STATEMENT), true);
  assert.equal(isFlexStatement("<FlexStatementResponse><Status>Success</Status></FlexStatementResponse>"), false);
  assert.equal(isFlexStatement(""), false);
});

/* ----------------------------- extractAccountId ------------------------------- */

test("extractAccountId: reads accountId off the FlexStatement element", () => {
  assert.equal(extractAccountId(SAMPLE_STATEMENT), "U1234567");
  assert.equal(extractAccountId("<FlexQueryResponse></FlexQueryResponse>"), null);
});

/* --------------------------- extractStatementInfo ----------------------------- */

test("extractStatementInfo: reads accountId, fromDate, toDate and period off FlexStatement", () => {
  const info = extractStatementInfo(SAMPLE_STATEMENT);
  assert.equal(info.accountId, "U1234567");
  assert.equal(info.fromDate, "20250101");
  assert.equal(info.toDate, "20260101");
});

test("extractStatementInfo: a single-day period statement (the real-world bug repro)", () => {
  const xml = `<FlexQueryResponse><FlexStatements><FlexStatement accountId="U9999999" fromDate="20260708" toDate="20260708" period="LastBusinessDay"></FlexStatement></FlexStatements></FlexQueryResponse>`;
  const info = extractStatementInfo(xml);
  assert.equal(info.fromDate, "20260708");
  assert.equal(info.toDate, "20260708");
  assert.equal(info.period, "LastBusinessDay");
});

test("extractStatementInfo: missing FlexStatement tag returns all-null rather than throwing", () => {
  const info = extractStatementInfo("<FlexQueryResponse></FlexQueryResponse>");
  assert.deepEqual(info, { accountId: null, fromDate: null, toDate: null, period: null });
});
