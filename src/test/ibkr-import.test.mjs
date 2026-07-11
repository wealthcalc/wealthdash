import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCSVRows, parseIBKR } from "../core/ibkr-import.mjs";

/* --------------------------- CSV tokenizer ---------------------------- */

test("parseCSVRows: quotes, embedded commas, escaped quotes, CRLF", () => {
  const rows = parseCSVRows('a,"b,c","say ""hi""",d\r\n1,2,3,4\n');
  assert.deepEqual(rows[0], ["a", "b,c", 'say "hi"', "d"]);
  assert.deepEqual(rows[1], ["1", "2", "3", "4"]);
});

test("parseCSVRows: drops fully blank lines, keeps a trailing unterminated row", () => {
  const rows = parseCSVRows("a,b\n\n ,\n1,2");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ["1", "2"]);
});

/* ------------------------------ Flex query ---------------------------- */

const FLEX_HEADER = "TradeDate,Symbol,ISIN,Buy/Sell,Quantity,Proceeds,IBCommission,Taxes,CurrencyPrimary,FXRateToBase,AssetClass";

test("flex: GBP BUY nets proceeds + commission + taxes", () => {
  const csv = FLEX_HEADER + "\n20240501,VOD,GB00BH4HKS39,BUY,10,-1000,-5,0,GBP,1,STK";
  const { trades, income, format } = parseIBKR(csv);
  assert.equal(format, "flex");
  assert.equal(income.length, 0);
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.date, "2024-05-01");
  assert.equal(t.ticker, "VOD");
  assert.equal(t.isin, "GB00BH4HKS39");
  assert.equal(t.side, "BUY");
  assert.equal(t.quantity, 10);
  assert.equal(t.gbpAmount, 1005); // |−1000 + −5 + 0|
  assert.equal(t.fxRate, 1);
  assert.equal(t.needsFx, false);
  assert.equal(t.wrapper, "GIA");
});

/* ------------------------------ ibkrId (dedupe) ---------------------------- */

test("flex: TradeID column, when present, is carried through as the hidden ibkrId field", () => {
  const header = FLEX_HEADER + ",TradeID";
  const csv = header + "\n20240501,VOD,GB00BH4HKS39,BUY,10,-1000,-5,0,GBP,1,STK,55512345";
  const { trades } = parseIBKR(csv);
  assert.equal(trades[0].ibkrId, "55512345");
});

test("flex: no TradeID column -> ibkrId is null, not fabricated", () => {
  const csv = FLEX_HEADER + "\n20240501,VOD,GB00BH4HKS39,BUY,10,-1000,-5,0,GBP,1,STK";
  const { trades } = parseIBKR(csv);
  assert.equal(trades[0].ibkrId, null);
});

test("flex: cash transaction TransactionID is carried through as ibkrId too", () => {
  const header = "Type,Amount,SettleDate,CurrencyPrimary,TransactionID";
  const csv = header + "\nDividends,42.10,20240601,GBP,99988877";
  const { income } = parseIBKR(csv);
  assert.equal(income[0].ibkrId, "99988877");
});

test("flex: negative quantity implies SELL when Buy/Sell is blank", () => {
  const csv = FLEX_HEADER + "\n2024-05-02,VOD,GB00BH4HKS39,,-10,2000,-5,0,GBP,1,STK";
  const { trades } = parseIBKR(csv);
  assert.equal(trades[0].side, "SELL");
  assert.equal(trades[0].quantity, 10);
  assert.equal(trades[0].gbpAmount, 1995);
});

test("flex: USD trade converts via FXRateToBase when base is GBP", () => {
  const csv = FLEX_HEADER + "\n2024/05/03,WFC,US9497461015,BUY,20,-3000,-2,0,USD,0.8,STK";
  const { trades } = parseIBKR(csv);
  assert.equal(trades[0].nativeCurrency, "USD");
  assert.equal(trades[0].nativeAmount, 3002);
  assert.equal(trades[0].fxRate, 0.8);
  assert.equal(trades[0].gbpAmount, Math.round(3002 * 0.8 * 100) / 100);
  assert.equal(trades[0].needsFx, false);
});

test("flex: USD trade without an FX rate is flagged needsFx, gbpAmount null", () => {
  const header = "TradeDate,Symbol,Buy/Sell,Quantity,Proceeds,IBCommission,CurrencyPrimary";
  const csv = header + "\n20240503,WFC,BUY,20,-3000,-2,USD";
  const { trades, warnings } = parseIBKR(csv);
  assert.equal(trades[0].needsFx, true);
  assert.equal(trades[0].gbpAmount, null);
  assert.ok(warnings.some((w) => w.includes("FX")));
});

test("flex: unsupported asset classes are skipped with a warning", () => {
  const csv = FLEX_HEADER +
    "\n20240501,SPX,US0000000000,BUY,1,-500,-1,0,USD,0.8,OPT" +
    "\n20240501,VOD,GB00BH4HKS39,BUY,10,-1000,-5,0,GBP,1,ETF";
  const { trades, warnings } = parseIBKR(csv);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].ticker, "VOD");
  assert.ok(warnings.some((w) => w.includes('asset class "opt"')));
});

test("flex: NetCash column is preferred over proceeds+commission", () => {
  const header = "TradeDate,Symbol,Buy/Sell,Quantity,Proceeds,IBCommission,Taxes,NetCash,CurrencyPrimary,FXRateToBase";
  const csv = header + "\n20240501,VOD,BUY,10,-1000,-5,0,-1005.50,GBP,1";
  const { trades } = parseIBKR(csv);
  assert.equal(trades[0].gbpAmount, 1005.5);
});

test("flex: comma-formatted amounts parse", () => {
  const csv = FLEX_HEADER + '\n20240501,VOD,GB00BH4HKS39,BUY,100,"-12,345.60",-5,0,GBP,1,STK';
  const { trades } = parseIBKR(csv);
  assert.equal(trades[0].gbpAmount, 12350.6);
});

test("flex cash statement: dividends and interest split; withholding dropped", () => {
  const header = "Type,Symbol,ISIN,Amount,SettleDate,CurrencyPrimary,FXRateToBase";
  const csv = header +
    "\nDividends,VOD,GB00BH4HKS39,25.50,20240610,GBP,1" +
    "\nWithholding Tax,WFC,US9497461015,-3.20,20240610,USD,0.8" +
    "\nBroker Interest Received,,,1.25,20240630,GBP,1" +
    "\nPayment In Lieu Of Dividends,WFC,US9497461015,10,20240615,USD,0.8";
  const { trades, income } = parseIBKR(csv);
  assert.equal(trades.length, 0);
  assert.equal(income.length, 3); // withholding row dropped
  assert.equal(income[0].kind, "dividend");
  assert.equal(income[0].amount, 25.5);
  assert.equal(income[1].kind, "interest");
  assert.equal(income[2].kind, "dividend"); // payment in lieu
  assert.equal(income[2].amount, 8);        // 10 USD @0.8
});

/* -------------------------- Activity statement ------------------------ */

const ACTIVITY = [
  "Statement,Header,Field Name,Field Value",
  "Statement,Data,Title,Activity Statement",
  "Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee",
  'Trades,Data,Order,Stocks,GBP,VOD,"2024-05-01, 09:30:00",10,100,-1000,-5',
  'Trades,Data,SubTotal,Stocks,GBP,VOD,,10,,-1000,-5',
  "Dividends,Header,Currency,Date,Description,Amount",
  "Dividends,Data,GBP,2024-06-10,VOD(GB00BH4HKS39) Cash Dividend GBP 0.10 per Share,25.50",
  "Dividends,Data,USD,2024-06-11,MSFT(US5949181045) Cash Dividend USD 0.75 per Share,7.50",
  "Dividends,Data,Total,,,33.00",
  "Interest,Header,Currency,Date,Description,Amount",
  "Interest,Data,GBP,2024-06-30,GBP Credit Interest,1.25",
].join("\n");

test("activity: sections are detected; orders kept, subtotals dropped", () => {
  const { trades, income, format } = parseIBKR(ACTIVITY);
  assert.equal(format, "activity");
  assert.equal(trades.length, 1); // SubTotal row excluded
  assert.equal(trades[0].date, "2024-05-01");
  assert.equal(trades[0].gbpAmount, 1005);
});

test("activity: dividend ticker + ISIN pulled from the description", () => {
  const { income } = parseIBKR(ACTIVITY);
  const div = income.find((i) => i.ticker === "VOD");
  assert.equal(div.isin, "GB00BH4HKS39");
  assert.equal(div.kind, "dividend");
  assert.equal(div.amount, 25.5);
});

test("activity: non-GBP dividend needs FX; Total rows are skipped", () => {
  const { income } = parseIBKR(ACTIVITY);
  const usd = income.find((i) => i.ticker === "MSFT");
  assert.equal(usd.needsFx, true);
  assert.equal(usd.amount, null);
  assert.equal(income.filter((i) => i.kind === "dividend").length, 2); // no Total row
});

test("activity: interest section maps to kind interest", () => {
  const { income } = parseIBKR(ACTIVITY);
  const int = income.find((i) => i.kind === "interest");
  assert.equal(int.amount, 1.25);
  assert.equal(int.date, "2024-06-30");
});

/* ------------------------------- misc --------------------------------- */

test("empty input returns a warning, not a crash", () => {
  const r = parseIBKR("");
  assert.deepEqual(r.trades, []);
  assert.deepEqual(r.income, []);
  assert.ok(r.warnings[0].includes("Empty"));
});

test("defaultWrapper is threaded onto every imported row", () => {
  const csv = FLEX_HEADER + "\n20240501,VOD,GB00BH4HKS39,BUY,10,-1000,-5,0,GBP,1,STK";
  const { trades } = parseIBKR(csv, { defaultWrapper: "ISA" });
  assert.equal(trades[0].wrapper, "ISA");
});

test("date formats: yyyymmdd, yyyy-mm-dd and yyyy/mm/dd all normalise", () => {
  const csv = FLEX_HEADER +
    "\n20240501,AAA,,BUY,1,-100,0,0,GBP,1,STK" +
    "\n2024-05-02,BBB,,BUY,1,-100,0,0,GBP,1,STK" +
    "\n2024/05/03,CCC,,BUY,1,-100,0,0,GBP,1,STK";
  const { trades } = parseIBKR(csv);
  assert.deepEqual(trades.map((t) => t.date), ["2024-05-01", "2024-05-02", "2024-05-03"]);
});
