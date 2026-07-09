/* ======================================================================
   IBKR FLEX STATEMENT XML — minimal reader, no XML/DOM dependency.

   Flex Statement XML is flat and attribute-per-field: every data row is a
   self-closing element under a section wrapper, e.g.
     <Trades><Trade symbol="WFC" tradeDate="20250315" quantity="50" .../></Trades>
   A couple of regexes are enough to pull every row of a given element name
   out as a plain object — same "no heavy dependency" approach this app
   already uses for DMO's RTF gilt-price export (see dmo-gilt-parser.mjs).
   Attribute keys are normalised (lowercased, alnum-only) on the way out so
   downstream code can look them up the same way regardless of the exact
   camelCase IBKR used (tradeDate/TradeDate/etc. all become "tradedate").

   The Flex Web Service's SendRequest/GetStatement calls return a small
   status-wrapper XML (<FlexStatementResponse><Status>...) rather than the
   statement itself — parseFlexStatementResponse() reads that; the actual
   statement always starts <FlexQueryResponse ...>, which isFlexStatement()
   checks for.
   ====================================================================== */

const normKey = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, "");

export function decodeXmlEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Every <tagName ...attrs.../> row for a given element name, as an array
// of { normalisedAttrName: decodedValue }.
export function extractElements(xml, tagName) {
  if (!xml) return [];
  const elRe = new RegExp(`<${tagName}\\b([^>]*)/>`, "g");
  const attrRe = /([A-Za-z0-9_]+)="([^"]*)"/g;
  const out = [];
  let m;
  while ((m = elRe.exec(xml))) {
    const attrs = {};
    let am;
    attrRe.lastIndex = 0;
    while ((am = attrRe.exec(m[1]))) attrs[normKey(am[1])] = decodeXmlEntities(am[2]);
    out.push(attrs);
  }
  return out;
}

// SendRequest/GetStatement's status-wrapper response.
export function parseFlexStatementResponse(xml) {
  const statusM = (xml || "").match(/<Status>([^<]*)<\/Status>/);
  const status = statusM ? statusM[1] : null;
  if (status === "Success") {
    const refM = xml.match(/<ReferenceCode>([^<]*)<\/ReferenceCode>/);
    const urlM = xml.match(/<url>([^<]*)<\/url>/);
    return { status: "Success", referenceCode: refM ? refM[1] : null, url: urlM ? urlM[1] : null };
  }
  const codeM = (xml || "").match(/<ErrorCode>([^<]*)<\/ErrorCode>/);
  const msgM = (xml || "").match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/);
  return { status: "Fail", errorCode: codeM ? codeM[1] : null, errorMessage: msgM ? decodeXmlEntities(msgM[1]) : "Unknown error — unexpected response from IBKR." };
}

// Whether `xml` IS the actual Flex Statement (vs. the SendRequest/
// GetStatement status wrapper) — the statement root is always
// <FlexQueryResponse ...>.
export function isFlexStatement(xml) {
  return /<FlexQueryResponse\b/.test(xml || "");
}

// The accountId attribute off the <FlexStatement ...> element, if present.
export function extractAccountId(xml) {
  const m = (xml || "").match(/<FlexStatement\s[^>]*\baccountId="([^"]*)"/);
  return m ? m[1] : null;
}

// fromDate/toDate/period off the <FlexStatement ...> opening tag — surfaced
// so the client can explain an empty pull ("your query only covers a
// single day") rather than just reporting "no rows found" with no context.
export function extractStatementInfo(xml) {
  const tagM = (xml || "").match(/<FlexStatement\s([^>]*)>/);
  if (!tagM) return { accountId: null, fromDate: null, toDate: null, period: null };
  const attrs = tagM[1];
  const get = (name) => { const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1] : null; };
  return { accountId: get("accountId"), fromDate: get("fromDate"), toDate: get("toDate"), period: get("period") };
}
