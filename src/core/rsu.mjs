/* ======================================================================
   RSU (Restricted Stock Unit) VESTING TRACKER — grants of employer stock
   (e.g. Wells Fargo RSUs, ticker WFC) that vest over time on a schedule,
   plus whatever's later sold. Same "holding + events" architecture as
   core/private-investments.mjs (a GRANT is the holding; VEST and SALE are
   events against it), and deliberately plugs into the SAME `prices` map
   the rest of the app already fetches and keeps in GBP-per-share terms
   (see valuePositions() in portfolio.mjs) — an RSU ticker just needs to be
   priced like any other holding; there's no separate price-fetch path to
   build or maintain here. Pure and React-free; runs under node --test.

   Model:
     GRANT — one award: identity, ticker, grant date, an optional note
             (e.g. "2024 annual grant"). No total-shares field on the
             grant itself — that's the SUM of its vest events, same as an
             LP holding's "called" total is the sum of its call events,
             not a separately-entered number that could drift out of sync.
     EVENT — { grantId, type, date, shares, priceNative, fxRate }:
       "vest" — shares that vested (or will vest — a future-dated vest
                event IS the schedule; there's no separate "schedule"
                array to keep in sync with "actual" vests). `priceNative`
                is the FMV per share at vest in the grant's native currency
                (informational — that's the income-tax cost-basis figure
                for a UK taxpayer, since income tax is charged on vest-date
                FMV, not something this app files); `fxRate` converts it to
                GBP. A vest dated in the future has no reliable FMV yet, so
                priceNative/fxRate are optional there — the schedule view
                just shows share count and date.
       "sale" — shares disposed of, at `priceNative` per share and `fxRate`
                on the sale date. Reduces held/vested shares available.

   What this deliberately does NOT compute:
     - UK CGT on a sale. RSU shares vested into a UK taxpayer's own name
       usually pool with any other same-company shares under the ordinary
       Section-104 rules, cost basis = vest-date FMV — but this module
       doesn't inject synthetic transactions into the CGT ledger (unlike
       ERI, which does, because ERI has one unambiguous mechanical rule).
       Whether RSU shares live in the same s104 pool as separately-bought
       shares of the same company, and exactly which UK employment
       income tax already applied at vest via payroll, are things this
       app has no way to know reliably — the Gain/loss figures below are
       informational (current value vs. vest-date cost), not a tax
       computation, same honesty policy as the LP fund CGT gap.
     - Employment income tax at vest. That's normally collected via UK
       PAYE (or US payroll withholding, for a US-employer grant) before
       the shares even land in a brokerage account — outside this app's
       scope, which only tracks what's actually held/sold from here.
   ====================================================================== */

const todayFallback = () => new Date().toISOString().slice(0, 10);
const round2 = (x) => Math.round((+x || 0) * 100) / 100;
const round4 = (x) => Math.round((+x || 0) * 10000) / 10000;
const sum = (list, f) => list.reduce((s, x) => s + (+f(x) || 0), 0);

/* -------------------------------- events ---------------------------------- */
export function grantEvents(grantId, events = []) {
  return events.filter((e) => e && e.grantId === grantId);
}

/* ------------------------------ vesting schedule --------------------------- */
// Every "vest" event for one grant, sorted by date, with a running
// cumulative-shares total and a `vested` flag (date <= today) — this IS the
// schedule (past and future vests are the same event type, just split by
// date), not a separate projection.
export function vestingSchedule(grant, events = [], today = todayFallback()) {
  const vests = grantEvents(grant.id, events).filter((e) => e.type === "vest").sort((a, b) => (a.date < b.date ? -1 : 1));
  let cum = 0;
  return vests.map((e) => {
    cum += +e.shares || 0;
    return { ...e, vested: e.date <= today, cumulativeShares: round4(cum) };
  });
}

/* ------------------------------ per-grant summary --------------------------- */
// `prices` is the app's existing { ticker: gbpPricePerUnit } map — the same
// one WealthTab/HoldingsTab/etc already populate from live quotes.
export function grantSummary(grant, events = [], prices = {}, today = todayFallback()) {
  const evs = grantEvents(grant.id, events);
  const vests = evs.filter((e) => e.type === "vest");
  const sales = evs.filter((e) => e.type === "sale");
  const vestedVests = vests.filter((e) => e.date <= today);

  const totalShares = sum(vests, (e) => e.shares);
  const vestedShares = sum(vestedVests, (e) => e.shares);
  const unvestedShares = Math.max(0, totalShares - vestedShares);
  const soldShares = sum(sales, (e) => e.shares);
  const heldShares = Math.max(0, vestedShares - soldShares);

  const vestValueGBP = sum(vestedVests, (e) => (+e.shares || 0) * (+e.priceNative || 0) * (+e.fxRate || 0));
  const saleValueGBP = sum(sales, (e) => (+e.shares || 0) * (+e.priceNative || 0) * (+e.fxRate || 0));
  // Cost basis per share = average FMV-at-vest across VESTED shares only —
  // unvested shares aren't owned yet, so they contribute no cost.
  const avgCostPerShare = vestedShares > 1e-9 ? vestValueGBP / vestedShares : 0;

  const price = prices[grant.ticker];
  const priced = Number.isFinite(price);
  const currentValueGBP = priced ? heldShares * price : null;
  const heldCostBasis = heldShares * avgCostPerShare;
  const unrealisedGBP = priced ? currentValueGBP - heldCostBasis : null;
  const realizedGBP = saleValueGBP - soldShares * avgCostPerShare;

  const futureVests = vests.filter((e) => e.date > today).sort((a, b) => (a.date < b.date ? -1 : 1));
  const nextVest = futureVests.length ? { date: futureVests[0].date, shares: round4(+futureVests[0].shares || 0) } : null;

  return {
    totalShares: round4(totalShares), vestedShares: round4(vestedShares), unvestedShares: round4(unvestedShares),
    soldShares: round4(soldShares), heldShares: round4(heldShares),
    vestValueGBP: round2(vestValueGBP), saleValueGBP: round2(saleValueGBP), avgCostPerShare: round4(avgCostPerShare),
    price: priced ? price : null, priced,
    currentValueGBP: priced ? round2(currentValueGBP) : null,
    unrealisedGBP: priced ? round2(unrealisedGBP) : null,
    realizedGBP: round2(realizedGBP),
    nextVest, eventCount: evs.length,
  };
}

/* ------------------------------ portfolio totals --------------------------- */
export function rsuTotals(grants = [], events = [], prices = {}, today = todayFallback()) {
  let totalShares = 0, vestedShares = 0, unvestedShares = 0, soldShares = 0, heldShares = 0;
  let vestValueGBP = 0, currentValueGBP = 0, unrealisedGBP = 0, realizedGBP = 0, unpriced = 0;
  const rows = grants.map((g) => {
    const s = grantSummary(g, events, prices, today);
    totalShares += s.totalShares; vestedShares += s.vestedShares; unvestedShares += s.unvestedShares;
    soldShares += s.soldShares; heldShares += s.heldShares; vestValueGBP += s.vestValueGBP; realizedGBP += s.realizedGBP;
    if (s.priced) { currentValueGBP += s.currentValueGBP; unrealisedGBP += s.unrealisedGBP; }
    else if (s.heldShares > 1e-9) unpriced += 1;
    return { grant: g, ...s };
  });
  rows.sort((a, b) => (a.nextVest?.date || "9999") < (b.nextVest?.date || "9999") ? -1 : 1);
  return {
    rows,
    totalShares: round4(totalShares), vestedShares: round4(vestedShares), unvestedShares: round4(unvestedShares),
    soldShares: round4(soldShares), heldShares: round4(heldShares),
    vestValueGBP: round2(vestValueGBP), currentValueGBP: round2(currentValueGBP),
    unrealisedGBP: round2(unrealisedGBP), realizedGBP: round2(realizedGBP), unpriced,
  };
}
