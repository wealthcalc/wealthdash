/* ======================================================================
   TARGET ALLOCATION + BUY-SIDE REBALANCING.

   The existing rebalancer (core/rebalancing.mjs) answers one narrow
   question — bonds/gilts versus equities — and answers it by SELLING. That
   is deliberately conservative, but it leaves the more common question
   unanswered: "I have £10,000 to invest this month; where should it go?"

   Buying to rebalance is strictly better than selling wherever it's
   possible:
   - It triggers no disposal, so no CGT event and no bed-and-breakfast rule
     to navigate.
   - It costs one set of dealing charges instead of two.
   - It uses money you were going to invest anyway.

   The allocation method is "fill the biggest gaps first", computed against
   the POST-CONTRIBUTION portfolio. That subtlety matters: a £10k
   contribution into a £1m portfolio changes every weight, so allocating
   against today's weights would systematically overshoot. Targets are
   measured against what the portfolio will be, not what it is.

   Where a contribution can't fix the drift on its own — because a category
   is over target and only selling would bring it down — that is stated
   rather than papered over. The app can suggest what to buy; it will not
   quietly imply a purchase fixes an overweight.
   Pure and node-tested (target-allocation.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/* groups: [{ id, name, target }] where target is a PERCENT (25 = 25%).
   assignments: { ticker: groupId } — which group each holding belongs to.
   positions: valued positions ({ ticker, marketValue, priced }).
   Unassigned priced holdings are collected into an "(unassigned)" group so
   they're visible rather than silently excluded from the denominator. */
export function allocationState({ groups = [], assignments = {}, positions = [] } = {}) {
  const byGroup = new Map(groups.map((g) => [g.id, { ...g, value: 0, holdings: [] }]));
  const UNASSIGNED = "__unassigned";
  let unassignedValue = 0;
  const unassignedHoldings = [];
  let total = 0, unpriced = 0;

  for (const p of positions) {
    if (!p || !p.ticker) continue;
    if (!p.priced || !(p.marketValue > 0)) { unpriced += 1; continue; }
    const v = +p.marketValue;
    total += v;
    const gid = assignments[p.ticker];
    const g = gid && byGroup.get(gid);
    if (g) { g.value += v; g.holdings.push({ ticker: p.ticker, value: r2(v) }); }
    else { unassignedValue += v; unassignedHoldings.push({ ticker: p.ticker, value: r2(v) }); }
  }

  const rows = [...byGroup.values()].map((g) => ({
    id: g.id,
    name: g.name,
    target: +g.target || 0,
    value: r2(g.value),
    weight: total > 0 ? r4((g.value / total) * 100) : 0,
    holdings: g.holdings.sort((a, b) => b.value - a.value),
  }));
  if (unassignedValue > 0) {
    rows.push({
      id: UNASSIGNED, name: "(unassigned)", target: 0,
      value: r2(unassignedValue),
      weight: total > 0 ? r4((unassignedValue / total) * 100) : 0,
      holdings: unassignedHoldings.sort((a, b) => b.value - a.value),
      unassigned: true,
    });
  }

  for (const r of rows) {
    r.drift = r4(r.weight - r.target);
    r.driftValue = r2(r.value - (total * r.target) / 100);
  }
  rows.sort((a, b) => b.driftValue - a.driftValue);

  const targetSum = rows.reduce((s, r) => s + (r.unassigned ? 0 : r.target), 0);
  return {
    rows,
    total: r2(total),
    unpricedCount: unpriced,
    targetSum: r4(targetSum),
    // Targets not summing to 100 is a user error worth naming — otherwise
    // every drift figure is quietly measured against the wrong base.
    targetsValid: Math.abs(targetSum - 100) < 0.01,
    hasUnassigned: unassignedValue > 0,
  };
}

/* Allocate a contribution to close the largest gaps, buying only.

   Returns per-group amounts plus the resulting weights, so the effect is
   visible before committing. `minTicket` avoids proposing £14 purchases
   that dealing costs would swallow. */
export function planContribution({ state, amount = 0, minTicket = 100 } = {}) {
  const contribution = +amount || 0;
  if (!state || !(contribution > 0)) {
    return { buys: [], allocated: 0, unallocated: r2(contribution), after: state?.rows || [], overweight: [] };
  }

  const investable = state.rows.filter((r) => !r.unassigned && r.target > 0);
  const totalAfter = state.total + contribution;

  // The shortfall of each group measured against the portfolio AFTER the
  // money goes in — allocating against today's weights would overshoot,
  // because the contribution itself moves every denominator.
  const gaps = investable.map((r) => ({
    id: r.id, name: r.name, target: r.target, value: r.value,
    need: Math.max(0, (totalAfter * r.target) / 100 - r.value),
  })).filter((g) => g.need > 0);

  const totalNeed = gaps.reduce((s, g) => s + g.need, 0);
  const buys = [];
  let allocated = 0;

  if (totalNeed > 0) {
    // Everything fits: bring each underweight group exactly to target.
    // Otherwise share the contribution in proportion to how far behind each
    // one is, which closes the widest gaps fastest.
    const scale = Math.min(1, contribution / totalNeed);
    for (const g of gaps) {
      const raw = g.need * scale;
      if (raw < minTicket) continue;
      const amountFor = r2(raw);
      buys.push({
        groupId: g.id, name: g.name, amount: amountFor,
        toTarget: r2(g.need),
        // Whether this purchase fully closes the gap or only narrows it.
        closesGap: Math.abs(raw - g.need) < 0.01,
      });
      allocated += amountFor;
    }
  }

  // Resulting weights, so the plan can be judged before it's acted on.
  const buyBy = new Map(buys.map((b) => [b.groupId, b.amount]));
  const after = state.rows.map((r) => {
    const newValue = r.value + (buyBy.get(r.id) || 0);
    return {
      id: r.id, name: r.name, target: r.target,
      value: r2(newValue),
      weight: totalAfter > 0 ? r4((newValue / totalAfter) * 100) : 0,
      drift: totalAfter > 0 ? r4((newValue / totalAfter) * 100 - r.target) : 0,
      unassigned: !!r.unassigned,
    };
  }).sort((a, b) => b.value - a.value);

  // Groups a purchase cannot fix. Naming them is the honest part: buying
  // more of everything else dilutes an overweight only slowly, and the app
  // shouldn't imply otherwise.
  const overweight = after
    .filter((r) => !r.unassigned && r.target > 0 && r.drift > 1)
    .map((r) => ({ id: r.id, name: r.name, drift: r.drift }));

  return {
    buys: buys.sort((a, b) => b.amount - a.amount),
    allocated: r2(allocated),
    unallocated: r2(contribution - allocated),
    after,
    overweight,
    totalAfter: r2(totalAfter),
  };
}
