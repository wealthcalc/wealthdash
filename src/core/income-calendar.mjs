/* ======================================================================
   INCOME CALENDAR (Phase 2, build step 4) — a forward-looking view over
   income already modelled elsewhere in the app: gilt coupons/redemptions
   (core/gilts.mjs — contractually SCHEDULED, not estimated), cash account
   maturities (core/cash.mjs), and a genuinely new piece: a forward
   dividend/interest forecast, built by detecting each series' historical
   cadence (monthly/quarterly/semi-annual/annual) and projecting the next
   occurrences at the recent average amount.

   Deliberately scoped to money actually received (or receivable): pension
   CONTRIBUTIONS are excluded on purpose, even though they're scheduled and
   forecastable the same way dividends are — a contribution is money moving
   from the investor's pocket INTO the pension pot, not income coming back
   out. Including it here would net an outflow against inflows and overstate
   "income." (Pension INCOME — i.e. drawdown once in payment — isn't
   currently modelled in this app at all, so there's nothing to add for that
   side yet either.)

   Every forecast row is explicitly marked "estimated" (dividends can be
   cut, cadence can change) vs "scheduled" (gilt coupons, cash maturities —
   contractual dates). Nothing here invents a payment that hasn't happened
   at least twice historically, and nothing forecasts a holding that's
   since been fully sold. Pure and React-free; runs under node --test.

   Every event also carries a `wrapper` (GIA/ISA/SIPP/LISA/VCT), so the UI
   can show the actual income-tax treatment alongside the amount — GIA
   income is taxable, everything else here is sheltered/tax-free. Dividend/
   interest forecasts use the WRAPPER OF THE MOST RECENT recorded payment in
   that series (a holding can be re-registered onto a different wrapper);
   gilts and cash maturities carry the wrapper straight through from
   gilts.mjs/the cash account record. Unknown wrapper defaults to GIA, same
   "unknown defaults to taxable" convention as core/portfolio.mjs.
   ====================================================================== */

const DAY_MS = 86400000;
const addDaysISO = (dateISO, n) => {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Units of `ticker` held at close of `dateStr`, from a BUY/SELL txn list —
// a pure duplicate of ui/shared.jsx's unitsHeldAt (that copy lives in a
// React-importing module; core stays dependency-free, so this is
// deliberately re-implemented here rather than cross-imported).
function unitsHeldAt(txns, dateStr, ticker) {
  const want = ticker ? String(ticker).toUpperCase() : null;
  let q = 0;
  for (const t of txns) {
    if (t.side !== "BUY" && t.side !== "SELL") continue;
    if (want && String(t.ticker || "").toUpperCase() !== want) continue;
    if (t.date <= dateStr) q += (t.side === "BUY" ? 1 : -1) * t.quantity;
  }
  return q;
}

const endOfMonthISO = (dateISO) => {
  const d = new Date(dateISO + "T00:00:00Z");
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};

// units now ÷ units on the last payment date, clamped to sane bounds. A
// holding that has since been fully sold is handled upstream; this is for
// the partial cases (topped up, trimmed).
function unitScale(txns, ticker, lastPaidISO, today) {
  const then = unitsHeldAt(txns, lastPaidISO, ticker);
  const now = unitsHeldAt(txns, today, ticker);
  if (!(then > 1e-9) || !(now > 1e-9)) return 1;
  const r = now / then;
  return Math.max(0.05, Math.min(20, Math.round(r * 1e4) / 1e4));
}

const latestWrapper = (txns, ticker) => {
  let best = null;
  for (const t of txns) if (t && String(t.ticker || "").toUpperCase() === ticker && (!best || t.date > best.date)) best = t;
  return best ? best.wrapper || null : null;
};

// A declared per-share rate in the quote's currency -> GBP per share, using
// the same FX the price refresh applied (GBP price ÷ raw quote). GBp quotes
// are pence. Returns null when there's no honest way to convert.
export function declaredRateGBP(div, priceGBP, pm) {
  if (!div || !(+div.rate > 0)) return null;
  const ccy = div.currency || (pm && pm.ccy) || null;
  if (ccy === "GBp") return +div.rate / 100;
  if (ccy === "GBP") return +div.rate;
  if (pm && +pm.raw > 0 && +priceGBP > 0 && (pm.ccy === ccy || !ccy)) return +div.rate * (+priceGBP / +pm.raw);
  return null;
}

// Classifies the typical gap (in days) between consecutive dates in one
// series into a payment cadence. Needs at least 2 dates (1 gap); returns
// null if there's nothing to measure. Uses the MEDIAN gap, not the mean,
// so one irregular special-dividend gap doesn't derail an otherwise
// regular quarterly series. Bands are wide enough to absorb weekend/
// bank-holiday drift in real payment dates without misclassifying.
const CADENCE_BANDS = [
  ["monthly", 25, 36],
  ["quarterly", 80, 100],
  ["semi-annual", 170, 196],
  ["annual", 350, 380],
];
export function detectCadence(datesAscending) {
  if (!datesAscending || datesAscending.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < datesAscending.length; i++) {
    gaps.push((+new Date(datesAscending[i]) - +new Date(datesAscending[i - 1])) / DAY_MS);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const medianDays = sorted[Math.floor(sorted.length / 2)];
  const hit = CADENCE_BANDS.find(([, lo, hi]) => medianDays >= lo && medianDays <= hi);
  return { label: hit ? hit[0] : "irregular", medianDays: Math.round(medianDays) };
}

// Forecast occurrence dates: step forward from `lastDate` by `stepDays`
// until the horizon, capped at 24 occurrences as a sanity backstop (a
// monthly series over the max realistic horizon).
export function nextOccurrences(lastDate, stepDays, today, horizonDays = 365) {
  if (!lastDate || !Number.isFinite(stepDays) || stepDays <= 0) return [];
  const horizonISO = addDaysISO(today, horizonDays);
  const out = [];
  let cur = lastDate;
  for (let i = 0; i < 24; i++) {
    cur = addDaysISO(cur, Math.round(stepDays));
    if (cur > horizonISO) break;
    if (cur > today) out.push(cur);
  }
  return out;
}

// The combined, sorted calendar. `giltCashflows` is the `cashflows` array
// already produced by core/gilts.mjs's giltAnalytics() — this module
// doesn't recompute gilt schedules, just folds them in.
export function buildIncomeCalendar({
  incomeEntries = [], txns = [], cashAccounts = [],
  giltCashflows = [], deferredCash = [],
  // RSU vests: [{ date, amount, label }] — future SCHEDULED vests valued
  // by the caller at TODAY'S price (no price forecast), so they are
  // "estimated", unlike deferred-cash tranches whose £ amount is
  // contractual. Sell-to-cover/withholding is NOT modelled — the gross
  // vest value is shown, and the UI says so.
  rsuVests = [],
  // Declared-rate fallback for holdings with thin history (see section 2b):
  // secMeta[ticker].dividend = { rate, currency, exDate, payDate } captured
  // from the quote feed, plus the current GBP price / raw quote pair the
  // price refresh stored, which gives the FX to bring the rate into GBP.
  secMeta = {}, prices = {}, priceMeta = {},
  today, horizonDays = 365,
} = {}) {
  if (!today) throw new Error("buildIncomeCalendar requires `today` (ISO date) — pure functions don't read the clock themselves.");
  const events = [];
  const projectedTickers = new Set();   // tickers section 2 managed to forecast
  const horizonISO = addDaysISO(today, horizonDays);

  // 0. RSU vests — scheduled DATES, estimated VALUE (today's price).
  for (const v of rsuVests) {
    if (v && v.date && v.date > today && v.date <= horizonISO && +v.amount > 0) {
      events.push({ date: v.date, source: "rsu-vest", label: v.label || "RSU vest", amount: +v.amount, certainty: "estimated", wrapper: "GIA" });
    }
  }

  // 1. Gilts — contractually scheduled, not estimated.
  const giltTickers = new Set();
  for (const cf of giltCashflows) {
    if (cf.ticker) giltTickers.add(cf.ticker);
    if (cf.date > today && cf.date <= horizonISO) {
      events.push({
        date: cf.date, source: cf.type === "redemption" ? "gilt-redemption" : "gilt-coupon",
        label: cf.ticker, amount: cf.amount, wrapper: cf.wrapper || "GIA",
        // A conventional gilt's cash is contractual. An INDEX-LINKED one's
        // is not: the date is fixed but the amount depends on RPI, known
        // only ~3 months ahead, so beyond that it's a projection. Counting
        // it as "scheduled" would overstate guaranteed income — which is
        // precisely what the certainty split exists to avoid.
        certainty: cf.indexLinked ? "estimated" : "scheduled",
      });
    }
  }

  // 2. Dividends/interest — per (ticker, kind) cadence forecast. A blank
  // ticker (kind "interest") represents un-attributed interest (e.g. cash
  // interest logged without a specific holding) and is always eligible;
  // a real ticker must still be an open position — a fully sold holding
  // doesn't get projected future dividends.
  const series = new Map();
  for (const e of incomeEntries) {
    if (!e || !e.date || !e.amount) continue;
    const key = `${e.ticker || ""}|${e.kind || "dividend"}`;
    if (!series.has(key)) series.set(key, { ticker: e.ticker || "", kind: e.kind || "dividend", dates: [], amounts: [], wrappers: [] });
    const s = series.get(key);
    s.dates.push(e.date);
    s.amounts.push(+e.amount);
    s.wrappers.push(e.wrapper || "");
  }
  for (const s of series.values()) {
    const order = s.dates.map((_, i) => i).sort((a, b) => (s.dates[a] < s.dates[b] ? -1 : 1));
    const dates = order.map((i) => s.dates[i]);
    const amounts = order.map((i) => s.amounts[i]);
    const wrappers = order.map((i) => s.wrappers[i]);
    if (dates.length < 2) continue;
    // A gilt's coupons arrive from the SCHEDULED gilt cashflows (section 1),
    // computed forward from the current holding. Brokers/banks import those
    // same coupons into the ledger as "interest", which would otherwise get a
    // second, backward-looking projection here — double-counting the gilt in
    // the next-12-months total, and mis-forecasting whenever the holding has
    // changed. Suppress the backward projection for any ticker that already
    // has a forward gilt schedule.
    if (s.ticker && giltTickers.has(s.ticker)) continue;
    if (s.ticker && unitsHeldAt(txns, today, s.ticker) <= 1e-9) continue; // fully sold — no future income
    const cadence = detectCadence(dates);
    // FALLBACK for irregular-but-established payers — the VCT case. VCTs
    // (and some trusts) pay roughly the same pattern each year but on
    // drifting dates that fit no fixed cadence band, so the band
    // classifier calls them "irregular" and, without this, they'd be
    // dropped entirely — under-forecasting annual income by whatever those
    // holdings pay.
    //
    // The RHYTHM (how many payments, roughly when) comes from projecting
    // the trailing 12 months forward a year. But the AMOUNT does NOT copy
    // last year's payments — that would carry a one-off SPECIAL dividend
    // straight into the forecast and overstate it. Instead the year's
    // total is a ROBUST annual payout rate: the MEDIAN of the last up-to-3
    // trailing-year totals, which discards a special-heavy year rather
    // than averaging it in. That median annual figure is then spread
    // evenly across the projected payment dates. Honestly marked
    // "estimated". Only applies with real history (> 300 days span) so a
    // couple of close one-off payments aren't mistaken for a pattern.
    const spanDays = (+new Date(dates[dates.length - 1]) - +new Date(dates[0])) / DAY_MS;
    if (!cadence || cadence.label === "irregular") {
      if (spanDays < 300) continue;
      const fromISO = addDaysISO(today, -365);
      const wrapper = wrappers[wrappers.length - 1] || "GIA";
      // Projected dates: trailing-12m payment dates, each + a year.
      const projDates = [];
      for (let i = 0; i < dates.length; i++) {
        if (dates[i] <= fromISO || dates[i] > today) continue;
        const proj = addDaysISO(dates[i], 365);
        if (proj > today && proj <= horizonISO) projDates.push(proj);
      }
      if (!projDates.length) continue;
      // Robust annual rate: median of up-to-3 trailing-year totals.
      const yearTotals = [];
      for (let y = 1; y <= 3; y++) {
        const hi = addDaysISO(today, -365 * (y - 1)), lo = addDaysISO(today, -365 * y);
        let sum = 0, any = false;
        for (let i = 0; i < dates.length; i++) if (dates[i] > lo && dates[i] <= hi) { sum += +amounts[i] || 0; any = true; }
        if (any) yearTotals.push(sum);
      }
      const sortedYT = yearTotals.sort((a, b) => a - b);
      const annualRate = sortedYT.length ? sortedYT[Math.floor(sortedYT.length / 2)] : 0;
      const scaleIrr = s.ticker ? unitScale(txns, s.ticker, dates[dates.length - 1], today) : 1;
      const per = Math.round((annualRate * scaleIrr / projDates.length) * 100) / 100;
      if (s.ticker) projectedTickers.add(s.ticker);
      for (const d of projDates) {
        events.push({ date: d, source: s.kind === "interest" ? "interest" : "dividend", label: s.ticker || "Interest", amount: per, certainty: "estimated", cadence: "annual (est.)", wrapper });
      }
      continue;
    }
    // UNITS SCALING. The recent average is what the LAST holding size paid.
    // Bought more since, and it understates; sold half, and it overstates
    // — for the whole year ahead. Scale by units held now over units held
    // on the last payment date. Un-attributed interest (blank ticker) has
    // no unit count and passes through unscaled.
    const scale = s.ticker ? unitScale(txns, s.ticker, dates[dates.length - 1], today) : 1;
    const recent = amounts.slice(-3);
    const avgAmount = Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * scale * 100) / 100;
    if (s.ticker) projectedTickers.add(s.ticker);
    // Wrapper attribution: the most recent entry's wrapper — a holding can
    // move accounts (rare, but a re-registration onto ISA/SIPP is real), so
    // the LATEST recorded wrapper is the best guide to where future payments
    // will land, not the earliest. Falls back to GIA (same "unknown wrapper
    // defaults to taxable" convention as core/portfolio.mjs).
    const wrapper = wrappers[wrappers.length - 1] || "GIA";
    for (const d of nextOccurrences(dates[dates.length - 1], cadence.medianDays, today, horizonDays)) {
      events.push({ date: d, source: s.kind === "interest" ? "interest" : "dividend", label: s.ticker || "Interest", amount: avgAmount, certainty: "estimated", cadence: cadence.label, wrapper, scaled: scale !== 1 ? scale : undefined });
    }
  }

  // 2b. DECLARED-RATE fallback. Section 2 refuses to forecast anything it
  // hasn't seen paid twice — correct for a ledger that IS the history, but
  // it means a holding bought last month contributes nothing to the year
  // ahead, however large. Where the quote feed supplied a declared annual
  // dividend rate, project units x rate for any open holding section 2
  // skipped, on a quarterly rhythm anchored to the next known ex-div date
  // (or spread evenly if none). Lower certainty than history, and labelled
  // as such; gilts and pension funds are excluded (gilts have a schedule,
  // fund units have no feed).
  const heldNow = new Map();
  for (const t of txns) {
    if (!t || !t.ticker || (t.side !== "BUY" && t.side !== "SELL") || t.date > today) continue;
    const tk = String(t.ticker).toUpperCase();
    heldNow.set(tk, (heldNow.get(tk) || 0) + (t.side === "BUY" ? +t.quantity || 0 : -(+t.quantity || 0)));
  }
  for (const [tk, units] of heldNow) {
    if (units <= 1e-9 || projectedTickers.has(tk) || giltTickers.has(tk)) continue;
    const m = secMeta[tk];
    if (!m || m.kind === "gilt" || m.kind === "fund" || !m.dividend || !(+m.dividend.rate > 0)) continue;
    const gbpRate = declaredRateGBP(m.dividend, prices[tk], priceMeta[tk]);
    if (!(gbpRate > 0)) continue;
    const annual = units * gbpRate;
    // Cadence: quarterly by default (most ETFs/ITs), anchored on the next
    // ex-div date if the feed gave one and it's in the future.
    const dates = [];
    let anchor = m.dividend.payDate && m.dividend.payDate > today ? m.dividend.payDate
      : m.dividend.exDate && m.dividend.exDate > today ? addDaysISO(m.dividend.exDate, 30) : addDaysISO(today, 45);
    for (let i = 0; i < 4 && anchor <= horizonISO; i++) { dates.push(anchor); anchor = addDaysISO(anchor, 91); }
    if (!dates.length) continue;
    const wrapper = latestWrapper(txns, tk) || "GIA";
    const per = Math.round((annual / 4) * 100) / 100;
    for (const d of dates) {
      events.push({ date: d, source: "dividend", label: tk, amount: per, certainty: "estimated", cadence: "declared rate", wrapper, declared: true });
    }
  }

  // 3. Cash account maturities within the horizon — contractually scheduled.
  for (const a of cashAccounts) {
    if (a.rateType !== "fixed" || !a.maturityDate) continue;
    if (a.maturityDate > today && a.maturityDate <= horizonISO) {
      events.push({ date: a.maturityDate, source: "cash-maturity", label: a.label || a.institution || a.wrapper, amount: +a.balance || 0, certainty: "scheduled", wrapper: a.wrapper || "GIA" });
    }
  }

  // 3b. Cash-account INTEREST. Every named account carries a balance and a
  // rate, and only the maturities were being forecast — the interest itself
  // wasn't, which for a large cash allocation is a visible hole in the
  // year's income. Simple interest, credited monthly, on the balance as
  // entered (no compounding, no rate forecast); a fixed-term account stops
  // accruing at its maturity date. "estimated": rates move and balances
  // get spent.
  for (const a of cashAccounts) {
    const rate = +a.rate, bal = +a.balance;
    if (!(rate > 0) || !(bal > 0)) continue;
    const stop = a.rateType === "fixed" && a.maturityDate ? a.maturityDate : horizonISO;
    const perMonth = Math.round(((bal * rate) / 100 / 12) * 100) / 100;
    let d = endOfMonthISO(today);
    for (let i = 0; i < 13 && d <= horizonISO && d <= stop; i++, d = endOfMonthISO(addDaysISO(d, 1))) {
      if (d <= today) continue;
      events.push({ date: d, source: "interest", label: a.label || a.institution || `${a.wrapper || "GIA"} cash`, amount: perMonth, certainty: "estimated", cadence: "monthly", wrapper: a.wrapper || "GIA", cashAccount: true });
    }
  }

  // 4. Deferred-cash tranche payouts — contractually scheduled cash inflows
  // (core/deferred-cash.mjs already bounds these to future/in-horizon and
  // shapes them; this module doesn't need to know the award record shape).
  // No wrapper: it's employment income taxed via PAYE at payment, not
  // investment income sitting in a GIA/ISA/etc — the UI shows no wrapper
  // tax badge for this source rather than implying one.
  for (const p of deferredCash) {
    if (!p || !p.date) continue;
    if (p.date > today && p.date <= horizonISO) {
      events.push({ date: p.date, source: "deferred-cash", label: p.label || "Deferred cash", amount: +p.amount || 0, certainty: "scheduled", wrapper: null });
    }
  }

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return events;
}

/* How much of the forecast can actually be RELIED ON.

   Every event already carries `certainty`, but only one place in the UI ever
   read it, so a single "£X next 12 months" headline gave contractual gilt
   coupons and a guess at next year's dividends exactly equal billing. They
   are not equal: a gilt coupon and a maturity are fixed by the instrument,
   while a dividend forecast is last year's payment projected forward and can
   be cut at will.

   That distinction is the whole point of an income floor, so it belongs in
   the headline: "£18,400 expected — £6,200 contractual, £12,200 estimated"
   tells you what your plan can lean on. */
export function certaintySplit(events = []) {
  let scheduled = 0, estimated = 0, scheduledCount = 0, estimatedCount = 0;
  for (const e of events) {
    const amt = +e.amount || 0;
    if (e.certainty === "scheduled") { scheduled += amt; scheduledCount += 1; }
    else { estimated += amt; estimatedCount += 1; }
  }
  const total = scheduled + estimated;
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    scheduled: r2(scheduled),
    estimated: r2(estimated),
    total: r2(total),
    scheduledCount,
    estimatedCount,
    // Share of forecast income that is contractual rather than projected.
    scheduledPct: total > 0 ? r2((scheduled / total) * 100) : 0,
  };
}

// Headline totals by source, over whatever horizon buildIncomeCalendar was
// called with — for a "expected income next 12 months" summary strip.
export function summariseBySource(events = []) {
  const out = {};
  for (const e of events) {
    (out[e.source] ||= { count: 0, total: 0 });
    out[e.source].count += 1;
    out[e.source].total += e.amount;
  }
  return out;
}
