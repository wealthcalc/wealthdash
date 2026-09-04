/* ======================================================================
   GILT REGISTRY — validation and diagnostics for getting an individual
   gilt from "I bought it" to "it appears on the Gilts tab". Pure and
   React-free; see gilt-registry.test.mjs.

   Why this module exists. A gilt only reaches giltAnalytics() if TWO
   independent things line up:

     1. secMeta[TICKER].kind === "gilt", with a finite coupon and an ISO
        maturity  (the "registration"), and
     2. the ledger holds BUY/SELL rows under EXACTLY that ticker.

   Neither half is visible when it's the half that's missing, and the
   registration form previously failed silently — an unparseable coupon or
   an empty maturity just did nothing at all, with no message, while a
   BLANK coupon passed validation (`+"" === 0` is finite) and quietly
   registered a 0% gilt whose every projected cashflow was wrong.

   The nastiest failure is the third one, which no error message on the
   form could ever have caught: buying a gilt that is ALREADY in the ledger
   under a different ticker. Broker imports map by ISIN, so the same stock
   can arrive as "TR30", "TG30" or a raw broker symbol; registering the
   other name produces a registration with no rows and a holding with no
   registration, and the tab shows nothing while looking perfectly healthy.
   isinConflicts() is the only thing that spots it, because ISIN is the
   only identifier both halves share.
   ====================================================================== */

const trim = (s) => String(s ?? "").trim();
const upper = (s) => trim(s).toUpperCase();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// GB gilts are all GB00 + 8 alphanumerics; the check digit isn't validated
// (a typo'd ISIN fails the DMO lookup loudly, which is feedback enough).
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

export const isGiltMeta = (m) => !!m && m.kind === "gilt"
  && Number.isFinite(+m.coupon) && typeof m.maturity === "string" && ISO_DATE.test(m.maturity);

/* --------------------------- form validation -------------------------- */
// Returns { ok, errors: { field: message }, value } — never throws, never
// half-accepts. `value` is the secMeta patch to merge, present only when ok.
//
// The coupon is REQUIRED and must be a number: a gilt's whole cashflow
// schedule is derived from it, so silently defaulting to 0 (the old
// behaviour) produced a holding whose GRY, coupon calendar, income forecast
// and ladder coverage were all wrong, with nothing on screen to say so.
export function validateGiltRegistration(form = {}, { secMeta = {}, editing = null } = {}) {
  const errors = {};
  const ticker = upper(form.ticker);
  const couponRaw = trim(form.coupon);
  const maturity = trim(form.maturity);
  const isin = upper(form.isin);
  const indexLinked = !!form.indexLinked;
  const ratioRaw = trim(form.indexRatio);
  const lag = form.indexationLagMonths == null || form.indexationLagMonths === "" ? 3 : +form.indexationLagMonths;

  if (!ticker) errors.ticker = "Enter the ticker your broker and your ledger use — e.g. TG30.";
  else if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) errors.ticker = "Tickers are letters, digits, dots and dashes only.";
  else if (!editing && isGiltMeta(secMeta[ticker])) errors.ticker = `${ticker} is already registered as a gilt — edit it below instead.`;

  if (!couponRaw) errors.coupon = "Required. The coupon drives every projected cashflow, so it can't be left blank.";
  else if (!Number.isFinite(+couponRaw)) errors.coupon = `"${couponRaw}" isn't a number — enter 4.25, not 4¼ or 4.25%.`;
  else if (+couponRaw < 0 || +couponRaw > 20) errors.coupon = "That's outside any coupon the UK has issued — check it's a percentage, not a price.";

  if (!maturity) errors.maturity = "Required. Coupon dates are counted back from the redemption date.";
  else if (!ISO_DATE.test(maturity)) errors.maturity = "Use a full date (YYYY-MM-DD).";

  if (isin && !ISIN_RE.test(isin)) errors.isin = "That doesn't look like an ISIN (12 characters, e.g. GB00BMBL1D50).";
  else if (isin) {
    const clash = Object.entries(secMeta).find(([tk, m]) => tk !== ticker && upper(m?.isin) === isin);
    if (clash) errors.isin = `That ISIN is already on ${clash[0]}. Register the gilt under that ticker, or correct whichever one is wrong — two tickers for one stock split your holding in half.`;
  }

  // Index-linked. The ratio is REQUIRED and load-bearing: prices are quoted
  // in real terms, so without it the holding is valued at its real price —
  // for TG36 that's 37% low. It's a published fact (3-month lag = already
  // known), so there's no reason to accept a guess.
  if (indexLinked) {
    if (lag !== 3) {
      errors.indexLinked = `${lag}-month indexation lag. Only the 3-month ("new style", post-2005) linkers are supported — the 8-month ones use a different formula, so their figures would be wrong.`;
    }
    if (!ratioRaw) errors.indexRatio = "Required for an index-linked gilt. It's published daily by the DMO — use the picker above and it fills itself in.";
    else if (!Number.isFinite(+ratioRaw)) errors.indexRatio = `"${ratioRaw}" isn't a number.`;
    else if (+ratioRaw < 0.5 || +ratioRaw > 5) errors.indexRatio = "An index ratio is RPI now ÷ RPI at issue, so it sits between about 1 and 3. This looks like a price.";
  }

  const ok = Object.keys(errors).length === 0;
  const prev = secMeta[ticker] || {};
  return {
    ok,
    errors,
    value: ok
      ? {
        ticker,
        patch: {
          ...prev,
          kind: "gilt", coupon: +couponRaw, maturity, domicile: "GB", eri: false,
          name: trim(form.name) || ticker,
          isin: isin || upper(prev.isin) || "",
          indexLinked,
          // Cleared rather than left behind when a gilt is corrected from
          // index-linked to conventional — a stale 1.59 would silently
          // inflate a conventional gilt by 59%.
          indexRatio: indexLinked ? +ratioRaw : undefined,
          indexRatioDate: indexLinked ? (trim(form.indexRatioDate) || prev.indexRatioDate || null) : undefined,
          indexationLagMonths: indexLinked ? lag : undefined,
        },
      }
      : null,
  };
}

// Un-registering must not destroy the ISIN/name the user typed — it only
// removes the gilt-specific fields, so the ticker reverts to an ordinary
// security rather than vanishing from every other tab.
export function unregisterGiltMeta(meta = {}) {
  const { kind, coupon, maturity, ...rest } = meta;
  return rest;
}

/* ------------------------ ledger-side diagnostics --------------------- */
// LSE gilt tickers: T/TN/TR/TG + a two-digit year, sometimes with a letter
// suffix for a second line maturing the same year (T26A). Deliberately
// narrow — this only decides whether to OFFER a suggestion, never to act.
const GILT_TICKER_RE = /^T[A-Z]?\d{2}[A-Z]?$/;
const GILT_NAME_RE = /treasury\s*(gilt|stock|loan)|\bgilt\b/i;

const netQty = (rows) => rows.reduce((n, t) => n + (t.side === "BUY" ? +t.quantity || 0 : -(+t.quantity || 0)), 0);

// Everything the Gilts tab needs to explain an empty ladder. Returns:
//   registeredUnheld  — registered, but the ledger has no rows for it
//   unregistered      — ledger tickers that look like gilts but aren't registered
//   isinConflicts     — one ISIN, two tickers (the silent one; see header)
export function giltRegistryDiagnostics({ txns = [], secMeta = {} } = {}) {
  const byTicker = new Map();
  for (const t of txns) {
    if (!t || !t.ticker || !(t.side === "BUY" || t.side === "SELL")) continue;
    const tk = upper(t.ticker);
    if (!byTicker.has(tk)) byTicker.set(tk, []);
    byTicker.get(tk).push(t);
  }

  const registered = Object.entries(secMeta).filter(([, m]) => isGiltMeta(m));

  const registeredUnheld = registered
    .filter(([tk]) => !byTicker.has(tk))
    .map(([tk, m]) => ({ ticker: tk, name: m.name || tk, coupon: +m.coupon, maturity: m.maturity, isin: upper(m.isin) }));

  const unregistered = [];
  for (const [tk, rows] of byTicker) {
    const m = secMeta[tk];
    if (isGiltMeta(m)) continue;
    const looksGilt = GILT_TICKER_RE.test(tk) || GILT_NAME_RE.test(String(m?.name ?? ""));
    if (!looksGilt) continue;
    unregistered.push({
      ticker: tk, name: trim(m?.name) || tk, isin: upper(m?.isin),
      qty: netQty(rows), rows: rows.length,
      firstDate: rows.map((r) => r.date).sort()[0] || null,
      // Matched by ticker shape alone unless the name says so outright.
      reason: GILT_NAME_RE.test(String(m?.name ?? "")) ? "name" : "ticker",
    });
  }
  unregistered.sort((a, b) => b.qty - a.qty || a.ticker.localeCompare(b.ticker));

  // A registered gilt whose ISIN sits on a DIFFERENT ledger ticker: the
  // registration and the holding are the same stock but can never meet.
  const isinConflicts = [];
  for (const [tk, m] of registered) {
    const isin = upper(m.isin);
    if (!isin) continue;
    for (const [other, om] of Object.entries(secMeta)) {
      if (other === tk || upper(om?.isin) !== isin) continue;
      if (!byTicker.has(other)) continue;   // only worth raising if it's actually held
      isinConflicts.push({ isin, registeredAs: tk, heldAs: other, qty: netQty(byTicker.get(other)) });
    }
  }

  return {
    registeredUnheld,
    unregistered,
    isinConflicts,
    registeredCount: registered.length,
    // "Nothing is wrong" is worth being able to assert directly, so the UI
    // can stay silent rather than showing an empty diagnostics box.
    clean: registeredUnheld.length === 0 && unregistered.length === 0 && isinConflicts.length === 0,
  };
}

/* ------------------------- DMO catalogue picker ----------------------- */
// Shapes /api/gilt-prices into a registerable pick-list. Rows without both
// a coupon and a maturity are dropped: they're the ones that would have to
// be guessed at, which is the whole thing this is meant to avoid.
// Index-linked gilts are KEPT but flagged — the app can't model them (the
// schedules here assume fixed cash coupons and par redemption), so the UI
// shows them greyed with the reason rather than silently hiding gilts the
// user can plainly see they own.
// The DMO's name field is the part AFTER the rate ("Treasury Gilt 2030"),
// since the rate is parsed separately — so the display name is recomposed
// from the two, never invented.
const composeName = (coupon, name) =>
  `${coupon}% ${String(name || "Treasury Gilt").replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim()}`;

export function shapeGiltCatalogue(body = {}) {
  const rows = [];
  for (const [isin, d] of Object.entries(body.prices || {})) {
    if (!d || d.coupon == null || !d.maturity) continue;
    const indexLinked = !!d.indexLinked;
    const lag = Number.isFinite(+d.indexationLagMonths) ? +d.indexationLagMonths : (indexLinked ? null : 0);
    const indexRatio = Number.isFinite(+d.indexRatio) && +d.indexRatio > 0 ? +d.indexRatio : null;
    // An index-linked gilt is registerable only with a 3-month lag AND a
    // published ratio: without the ratio it would be valued at its real
    // price, which for a linker like TG36 is ~37% low.
    const unsupportedReason = !indexLinked ? null
      : lag == null ? "The DMO report didn't say what indexation lag this uses, and the 8-month (pre-2005) ones need a different formula — so it can't be taken on trust."
        : lag !== 3 ? `${lag}-month indexation lag — only the post-2005 3-month linkers are modelled here.`
          : indexRatio == null ? "The DMO report didn't carry a readable index ratio for this line, and it can't be valued without one."
            : null;
    rows.push({
      isin,
      name: composeName(d.coupon, d.name),
      coupon: d.coupon,
      maturity: d.maturity,
      indexLinked,
      indexRatio,
      indexationLagMonths: lag,
      rump: !!d.rump,
      // For a linker `clean` is the REAL quote; `cashClean` is what it's
      // actually worth per £100 nominal today.
      clean: Number.isFinite(+d.clean) ? +d.clean : null,
      cashClean: Number.isFinite(+d.clean) ? +d.clean * (indexRatio ?? 1) : null,
      supported: !unsupportedReason,
      unsupportedReason,
    });
  }
  rows.sort((a, b) => (a.maturity < b.maturity ? -1 : a.maturity > b.maturity ? 1 : a.coupon - b.coupon));
  return { date: body.date || null, rows };
}

// Free-text filter over the catalogue: ISIN, name, maturity year, or the
// coupon as typed ("4.25", "0.375"). Empty query returns everything.
export function searchGiltCatalogue(rows = [], query = "") {
  const q = trim(query).toLowerCase();
  if (!q) return rows;
  const terms = q.split(/\s+/);
  return rows.filter((r) => {
    const hay = `${r.isin} ${r.name} ${r.maturity} ${r.coupon}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/* ---------------------------- gilt trade row -------------------------- */
// Builds the ledger BUY/SELL row for a gilt purchase entered in gilt units
// — £ nominal and a CLEAN price per £100 — rather than the app's internal
// units (price per £1 nominal). Every gilt trade a person actually makes is
// quoted that way on the contract note, and the conversion (a factor of
// 100) is exactly the kind of thing that produces a holding 100x too big.
//
// gbpAmount is the CLEAN consideration plus fees. Accrued interest paid is
// deliberately NOT added to cost: it isn't part of the gilt's price, it's
// interest, handled separately by the Accrued Income Scheme (see gilts.mjs)
// — folding it into cost would overstate the holding's value on day one.
export function buildGiltTrade({ ticker, date, side = "BUY", wrapper = "GIA", nominal, clean100, fees = 0 } = {}) {
  const errors = {};
  const tk = upper(ticker);
  if (!tk) errors.ticker = "Pick a registered gilt.";
  if (!ISO_DATE.test(trim(date))) errors.date = "Enter the trade date.";
  if (!(+nominal > 0)) errors.nominal = "Nominal is the £ face value you bought — e.g. 20000, not the cash paid.";
  if (!(+clean100 > 0)) errors.clean100 = "Clean price per £100 nominal, as on the contract note — e.g. 84.12.";
  else if (+clean100 > 250) errors.clean100 = "That's per £100 nominal, so it should be roughly 20–150.";
  if (Object.keys(errors).length) return { ok: false, errors, row: null };

  const consideration = Math.round(((+nominal * +clean100) / 100) * 100) / 100;
  return {
    ok: true,
    errors: {},
    row: {
      date: trim(date),
      ticker: tk,
      side: side === "SELL" ? "SELL" : "BUY",
      wrapper: upper(wrapper) || "GIA",
      quantity: +nominal,
      nativeCurrency: "GBP",
      nativeAmount: consideration,
      fxRate: 1,
      gbpAmount: Math.round((consideration + (+fees || 0)) * 100) / 100,
      fees: +fees || 0,
      account: "",
      note: `Gilt: £${+nominal} nominal @ ${+clean100} clean per £100`,
    },
    consideration,
  };
}
