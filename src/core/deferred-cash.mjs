/* ======================================================================
   DEFERRED CASH TRACKER — deferred compensation paid in CASH (not stock)
   that vests over time on a schedule: a bonus awarded now but paid out in
   tranches across future years, common in banking/finance comp. Same
   "holding + events" architecture as core/rsu.mjs (an AWARD is the holding;
   each TRANCHE is a scheduled/paid vest event against it), deliberately kept
   simpler because cash has no ticker and no live price — a tranche's value
   IS its GBP amount, entered directly. Pure and React-free; runs under
   node --test.

   Model:
     AWARD   — one deferred-cash award: identity, a label (e.g. "2025
               bonus — deferred"), the award date, an optional note. No
               total-amount field on the award itself — that's the SUM of
               its tranche amounts, same "sum the events, don't store a
               separate total that can drift" rule as an RSU grant's shares
               or an LP holding's called capital.
     TRANCHE — { awardId, date, amount }: `amount` GBP paid on `date`. A
               future-dated tranche IS the schedule (past and future
               tranches are the same record, split only by date), so there's
               no separate "schedule" array to keep in sync with actuals.

   NET-WORTH TREATMENT (deliberate, and the OPPOSITE of RSUs): only the
   UNVESTED (not-yet-paid) tranches count toward net worth. Once a tranche's
   date passes it is assumed PAID — it lands in a bank account and is already
   tracked under the app's ordinary cash balances, so counting it here too
   would double-count it. (An RSU vest, by contrast, becomes a share you
   still HOLD as a distinct asset until you sell it, so RSUs count the
   vested-unsold side; deferred cash is the mirror image.) `outstanding`
   below — the sum of unvested tranches — is the figure fed into
   householdNetWorth.

   What this deliberately does NOT model:
     - Employment income tax on payout. Deferred cash is taxable employment
       income, but it's collected via PAYE at the point of payment, outside
       this app's scope — the same "we track the cashflow, not the payroll
       tax" honesty policy as the RSU vest-tax gap.
     - Notional interest / growth on the deferred balance. Some plans accrue
       it; this app has no reliable way to know the rate or terms, so a
       tranche is worth exactly its entered nominal amount — the same
       "don't fabricate precision" stance as mortgage balances (no
       amortisation modelled) and named cash accounts (no compounding).
     - Forfeiture risk. Unvested deferred comp is typically contingent on
       continued employment; this counts it at face value as an expected
       entitlement, not risk-adjusted. Stated plainly in the UI.
   ====================================================================== */

const todayFallback = () => new Date().toISOString().slice(0, 10);
const round2 = (x) => Math.round((+x || 0) * 100) / 100;
const sum = (list, f) => list.reduce((s, x) => s + (+f(x) || 0), 0);

/* -------------------------------- tranches -------------------------------- */
export function awardTranches(awardId, tranches = []) {
  return tranches.filter((t) => t && t.awardId === awardId);
}

/* ------------------------------ vesting schedule -------------------------- */
// Every tranche for one award, sorted by date, with a running cumulative
// total and a `vested` flag (date <= today — i.e. already paid out). This IS
// the schedule; past and future tranches are the same record type.
export function vestingSchedule(award, tranches = [], today = todayFallback()) {
  const rows = awardTranches(award.id, tranches).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  let cum = 0;
  return rows.map((t) => {
    cum += +t.amount || 0;
    return { ...t, vested: t.date <= today, cumulativeAmount: round2(cum) };
  });
}

/* ------------------------------ per-award summary ------------------------- */
export function awardSummary(award, tranches = [], today = todayFallback()) {
  const rows = awardTranches(award.id, tranches);
  const totalAmount = sum(rows, (t) => t.amount);
  const vestedAmount = sum(rows.filter((t) => t.date <= today), (t) => t.amount);
  const outstanding = round2(Math.max(0, totalAmount - vestedAmount)); // unvested = the net-worth figure
  const future = rows.filter((t) => t.date > today).sort((a, b) => (a.date < b.date ? -1 : 1));
  const nextVest = future.length ? { date: future[0].date, amount: round2(+future[0].amount || 0) } : null;
  return {
    totalAmount: round2(totalAmount),
    vestedAmount: round2(vestedAmount),
    outstanding,
    trancheCount: rows.length,
    nextVest,
  };
}

/* ------------------------------ portfolio totals -------------------------- */
// `outstanding` (sum of unvested tranches across every award) is what feeds
// household net worth — see the header note on why vested tranches are
// excluded (they've become ordinary cash and are tracked there instead).
export function deferredCashTotals(awards = [], tranches = [], today = todayFallback()) {
  let totalAmount = 0, vestedAmount = 0, outstanding = 0;
  const rows = awards.map((a) => {
    const s = awardSummary(a, tranches, today);
    totalAmount += s.totalAmount; vestedAmount += s.vestedAmount; outstanding += s.outstanding;
    return { award: a, ...s };
  });
  // Soonest next payout first, awards with nothing left to pay sink to the bottom.
  rows.sort((a, b) => ((a.nextVest?.date || "9999") < (b.nextVest?.date || "9999") ? -1 : 1));
  return {
    rows,
    totalAmount: round2(totalAmount),
    vestedAmount: round2(vestedAmount),
    outstanding: round2(outstanding),
  };
}

/* --------------------------- income-calendar feed ------------------------- */
// Future (unvested) tranche payouts within the horizon, shaped for
// buildIncomeCalendar (core/income-calendar.mjs) — each is a contractually
// scheduled cash inflow on a known date. Kept here (not in income-calendar)
// so that module never needs to know the award/tranche record shape.
export function deferredCashCalendar(awards = [], tranches = [], today = todayFallback(), horizonDays = 365) {
  const horizon = new Date(today + "T00:00:00Z");
  horizon.setUTCDate(horizon.getUTCDate() + horizonDays);
  const horizonISO = horizon.toISOString().slice(0, 10);
  const labelOf = (awardId) => awards.find((a) => a.id === awardId)?.label || "Deferred cash";
  const out = [];
  for (const t of tranches) {
    if (!t || !t.date) continue;
    if (t.date > today && t.date <= horizonISO) {
      out.push({ date: t.date, amount: round2(+t.amount || 0), label: labelOf(t.awardId), awardId: t.awardId });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
