/* ======================================================================
   RECURRING COMMITMENTS — the fixed outgoings you know about without
   reading a statement: direct debits (mobile, broadband), quarterly
   service charges, annual building insurance.

   THE DOUBLE-COUNT PROBLEM, which is the whole reason this module is
   careful. A direct debit exists in two places: as a commitment you
   declared here, and as a row in the current-account statement once you
   import it. Counting both makes every budget wrong in the same
   direction — silently, and by exactly the amount you were most confident
   about. Two mechanisms prevent it:

   1. STATEMENT COVERAGE WINS. Each commitment names the account it leaves
      from. For any month where that account has imported statement rows,
      the generated row is SUPPRESSED — the statement is authoritative for
      months it covers, because it holds what actually left the account
      (including the price rise you forgot about). Generated rows fill only
      the gaps: months you haven't imported, and the future.
   2. Generated rows are never persisted. They're derived on read, exactly
      like categorisation (core/categorise.mjs), so they can't drift out of
      sync with the statements or survive a definition being deleted.

   Rows are marked `estimated: true` and carry `recurringId`, so the UI can
   show them as forecasts rather than facts, and the honest thing happens
   in the budget: an estimated £35 is visibly an estimate.

   `endDate` exists because commitments end — a contract you've left should
   stop generating rows rather than quietly inflating next year's budget.

   Pure and node-tested (recurring.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;
const monthOf = (iso) => (iso || "").slice(0, 7);

export const FREQUENCIES = [
  ["monthly", "Monthly", 1],
  ["quarterly", "Quarterly", 3],
  ["biannual", "Every 6 months", 6],
  ["annual", "Annually", 12],
];
const stepOf = (f) => (FREQUENCIES.find(([k]) => k === f) || FREQUENCIES[0])[2];

// Add n months to an ISO date, clamping the day to the target month's
// length so 31 Jan + 1 month is 28/29 Feb rather than rolling into March
// (a direct debit on the 31st doesn't skip February).
export function addMonthsClamped(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const total = (y * 12) + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

// Which months does each account have imported (non-estimated) rows for?
// -> { account: Set<"YYYY-MM"> }. Rows with no account are pooled under ""
// so a statement imported without a label still suppresses commitments
// that were also left unlabelled.
export function statementCoverage(txns = []) {
  const cover = {};
  for (const t of txns) {
    if (!t || t.estimated) continue;
    const acc = t.account || "";
    (cover[acc] ||= new Set()).add(monthOf(t.date));
  }
  return cover;
}

// definitions: [{ id, label, amount, frequency, startDate, endDate,
//                 categoryId, account, alwaysInclude }]
//   alwaysInclude — escape hatch for a commitment that genuinely ISN'T in
//   the statement (paid by someone else, or a different account you don't
//   import). Skips coverage suppression; the UI warns that it's on you to
//   avoid the double count.
// Returns dated rows between fromDate and toDate inclusive.
export function expandRecurring({ definitions = [], fromDate, toDate, coverage = {} } = {}) {
  if (!fromDate || !toDate) throw new Error("expandRecurring requires fromDate and toDate — pure functions don't read the clock.");
  const rows = [];
  const suppressed = [];
  for (const d of definitions) {
    if (!d || !d.startDate || !(+d.amount)) continue;
    const step = stepOf(d.frequency);
    const covered = coverage[d.account || ""] || new Set();
    // Walk forward from startDate rather than back from today, so the
    // schedule stays anchored to the real payment day.
    let date = d.startDate;
    let guard = 0;
    while (date < fromDate && guard++ < 1200) date = addMonthsClamped(date, step);
    for (; date <= toDate && guard++ < 1200; date = addMonthsClamped(date, step)) {
      if (d.endDate && date > d.endDate) break;
      const month = monthOf(date);
      if (!d.alwaysInclude && covered.has(month)) {
        suppressed.push({ recurringId: d.id, label: d.label, date, reason: "statement-covered" });
        continue;
      }
      rows.push({
        id: `rec-${d.id}-${date}`,
        date,
        description: d.label || "Recurring payment",
        amount: r2(+d.amount),
        account: d.account || "",
        categoryId: d.categoryId || null,
        manualCategoryId: d.categoryId || null,
        estimated: true,
        recurringId: d.id,
      });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { rows, suppressed };
}

// What a set of commitments costs per year — the "my fixed outgoings are
// £X/yr before I buy a single coffee" number, useful on its own and as a
// sanity check against the budget's own totals.
export function annualCommitment(definitions = [], { asOf } = {}) {
  let total = 0;
  const byCategory = {};
  for (const d of definitions) {
    if (!d || !(+d.amount)) continue;
    if (asOf && d.endDate && d.endDate < asOf) continue;
    if (asOf && d.startDate && d.startDate > asOf) continue;
    const perYear = (+d.amount) * (12 / stepOf(d.frequency));
    total += perYear;
    const k = d.categoryId || "";
    byCategory[k] = r2((byCategory[k] || 0) + perYear);
  }
  return { total: r2(total), byCategory };
}
