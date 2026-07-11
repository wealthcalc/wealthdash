/* ======================================================================
   HMRC CGT engine — the matching core, extracted VERBATIM from
   CgtDashboard.jsx so that both the CGT view and the wealth core compute
   from a single, tested source of truth (no duplicated engine to drift).
   Order: same-day -> 30-day B&B -> S104 pool. All amounts GBP (FX-converted
   upstream). React-free and side-effect-free, so it runs under `node --test`.
   Behaviour is unchanged from the inlined version; see cgt-engine.test.mjs.
   ====================================================================== */

const round4 = (x) => Math.round(x * 1e4) / 1e4;

const MS = 86400000;
const dUTC = (s) => new Date(s + "T00:00:00Z");
const daysBetween = (a, b) => Math.round((b - a) / MS);

// Optional incidental costs (s38 TCGA 1992: broker commission, stamp duty,
// PTM levy) recorded SEPARATELY from the consideration: a BUY's allowable
// cost is gbpAmount + fees, a SELL's net proceeds are gbpAmount − fees.
// `fees` means charges NOT already inside gbpAmount — IBKR imports arrive
// with commissions already netted into the amount (see core/ibkr-import.mjs
// netcash handling) and so leave this field unset; manual entries from UK
// contract notes, which quote consideration and charges separately, use it.
const _fee = (t) => (Number.isFinite(+t.fees) && +t.fees > 0 ? +t.fees : 0);

function matchWithPool(txns) {
  const acqs = txns.filter((t) => t.side === "BUY")
    .map((t) => ({ t, date: dUTC(t.date), remaining: t.quantity, unit: (t.gbpAmount + _fee(t)) / t.quantity }))
    .sort((a, b) => a.date - b.date);
  const disps = txns.filter((t) => t.side === "SELL")
    .map((t) => ({ t, date: dUTC(t.date), remaining: t.quantity, net: t.gbpAmount - _fee(t), legs: [] }))
    .sort((a, b) => a.date - b.date);
  // ERI: excess reportable income, a cost-only uplift to the S104 pool on the fund
  // distribution date. No units; excluded from same-day / 30-day matching.
  const eris = txns.filter((t) => t.side === "ERI").map((t) => ({ date: dUTC(t.date), cost: t.gbpAmount }));

  const alloc = (d, n, cost, method, acqDate) => {
    const proceeds = d.net * (n / d.t.quantity); // net of the disposal's own fees, pro-rata
    d.legs.push({ method, quantity: n, proceeds, cost, gain: proceeds - cost, matchedAcqDate: acqDate });
    d.remaining -= n;
  };
  for (const d of disps) for (const a of acqs) {
    if (d.remaining <= 1e-9) break;
    if (a.remaining <= 0 || +a.date !== +d.date) continue;
    const n = Math.min(d.remaining, a.remaining); alloc(d, n, a.unit * n, "SAME_DAY", a.t.date); a.remaining -= n;
  }
  for (const d of disps) for (const a of acqs) {
    if (d.remaining <= 1e-9) break;
    if (a.remaining <= 0) continue;
    const g = daysBetween(d.date, a.date);
    if (g > 0 && g <= 30) { const n = Math.min(d.remaining, a.remaining); alloc(d, n, a.unit * n, "THIRTY_DAY", a.t.date); a.remaining -= n; }
  }
  const ev = [];
  for (const a of acqs) if (a.remaining > 0) ev.push([a.date, 0, a]);
  for (const e of eris) ev.push([e.date, 0, { eri: true, cost: e.cost }]);
  for (const d of disps) if (d.remaining > 1e-9) ev.push([d.date, 1, d]);
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let pq = 0, pc = 0;
  for (const [, kind, o] of ev) {
    if (kind === 0) { if (o.eri) { if (pq > 1e-9) pc += o.cost; continue; } pq += o.remaining; pc += o.unit * o.remaining; o.remaining = 0; }
    else {
      const n = o.remaining;
      if (n > pq + 1e-6) throw new Error(`Disposal ${o.t.date} ${o.t.ticker} exceeds shares held (needs ${round4(n)}, pool holds ${round4(pq)}).`);
      const cost = pq > 0 ? pc * (n / pq) : 0; alloc(o, n, cost, "SECTION_104", null); pq -= n; pc -= cost;
    }
  }
  const results = disps.map((x) => ({
    date: x.t.date, ticker: x.t.ticker, quantity: x.t.quantity, proceeds: x.net,
    legs: x.legs, cost: x.legs.reduce((s, l) => s + l.cost, 0),
    gain: x.legs.reduce((s, l) => s + l.gain, 0), taxYear: ukTaxYear(x.t.date), id: x.t.id,
  })).sort((a, b) => (a.date < b.date ? -1 : 1));
  return { results, poolQty: pq, poolCost: pc };
}

function matchPortfolio(txns) {
  const by = {}; for (const t of txns) (by[t.ticker] ||= []).push(t);
  const all = []; const pools = {};
  for (const [tk, ts] of Object.entries(by)) {
    const { results, poolQty, poolCost } = matchWithPool(ts);
    all.push(...results); pools[tk] = { qty: poolQty, cost: poolCost };
  }
  all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ticker.localeCompare(b.ticker)));
  return { disposals: all, pools };
}

function ukTaxYear(s) {
  const [y, m, d] = s.split("-").map(Number);
  const start = m > 4 || (m === 4 && d >= 6) ? y : y - 1;
  return `${start}/${String(start + 1).slice(-2)}`;
}

export { round4, MS, dUTC, daysBetween, matchWithPool, matchPortfolio, ukTaxYear, _fee as feeOf };
