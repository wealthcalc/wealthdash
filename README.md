# UK Capital Gains Dashboard

Client-side React (Vite) CGT tracker + wealth dashboard, with a Yahoo Finance
price proxy running as a Vercel serverless function. All personal data stays in
the browser's localStorage; the deployment ships only code.

## Phase 2, step 1: property, mortgages & liabilities — completing the balance sheet

Theme for Phase 2: stop describing only the investment portfolio and start
describing true household net worth (assets − liabilities), toward a
defensible "am I on track?" answer and, eventually, a January where the app
produces the actual numbers for the tax return. This step is the foundation
everything else in that plan sits on.

- **`core/property.mjs`** (new, node-tested, 12 tests) — pure engine for
  property valuation, mortgage/liability netting, and household net worth.
  A property's estimated value is either a manual figure (you looked at
  Rightmove/an agent) or HPI-indexed from the purchase price: `estimated =
  purchase price × (latest regional index ÷ index at purchase month)`,
  falling back to the raw purchase price ("cost", clearly flagged) until an
  index fetch has happened. No amortisation schedule is modelled for
  mortgages — real payoff paths depend on overpayments/rate changes only
  you know, so the app stores the last-entered balance with a staleness
  date, same "don't fabricate precision" principle as gilts/XIRR elsewhere.
  Mortgages orphaned by a deleted property still count in total debt
  (surfaced separately, never silently dropped).
- **Land Registry UK HPI proxy** (`api/hpi.mjs`) — the same "official source
  proxy" pattern as the DMO gilt-price and Yahoo FX functions. Endpoint
  verified by hand, 2026-07 (not assumed): the interactive UK HPI browse
  tool at landregistry.data.gov.uk downloads its own results from a plain
  CSV endpoint, which this calls directly rather than going through the
  SPARQL/linked-data layer. Region slugs (the 9 official English regions +
  the four home nations + UK) spot-checked against the live API individually
  before being hardcoded (london, scotland, wales, yorkshire-and-the-humber,
  east-of-england all returned real data). Local-authority-level indexing
  (441+ areas) exists on the same service but isn't exposed — picking the
  closest region is a reasonable net-worth estimate, not a RICS survey.
- **New Property tab** (Portfolio section of the sidebar) — add properties
  (label, region, purchase price/date, manual-or-HPI valuation toggle,
  one-click "Fetch Land Registry index"), mortgages (lender, balance, rate,
  fixed/tracker/variable, fixed-rate end date, linked to a property),
  and other liabilities (loans, credit cards — anything non-mortgage).
  Sortable tables reuse the same `useSort`/`SortTh` primitive as every other
  data table in the app. Two-step delete (click again to confirm) rather
  than a browser `confirm()` dialog, consistent with the Pension tab.
- **True net worth wired into Home** — the headline figure is now
  `householdNetWorth()`: investments + cash (unchanged) + property equity
  − other liabilities. For existing users with no property/liability data
  entered, this is mathematically identical to the old "total wealth"
  figure (zero property equity, zero other liabilities), so nothing changes
  visually until the feature is used — the breakdown line (investments+cash
  / property equity / liabilities) only appears once there's something to
  break down. Home's needs-attention rail also flags fixed-rate mortgage
  deals expired or ending within 180 days (an expired fix usually reverts
  to a much higher SVR).
- **Backup version 5** — adds `properties`, `mortgages`, `otherLiabilities`;
  older backups (v4 and earlier) restore exactly as before, just without
  this data. New persisted keys registered in `durable.js`'s `PERSIST_KEYS`
  (IndexedDB mirror + daily snapshots), with the existing exhaustiveness
  test (`durable.test.mjs`) updated so a future missed key fails loudly
  again rather than silently skipping the mirror.

**Foreign property + foreign mortgage support (added later, 21 node tests
now)**: a property (and, independently, each mortgage on it) can be
denominated in a currency other than GBP (currently EUR — see
`FOREIGN_CURRENCIES` in `core/property.mjs`, a one-line list to extend).
HPI indexing has no coverage outside the UK, so a foreign property is
always manually valued — `estimatedPropertyValue()` forces this regardless
of `valuationMode`, rather than trusting the UI to enforce it. Conversion
to GBP uses a rate CACHED on the record (`fxRate`/`fxAsOf`), fetched
client-side via the same `/api/fx` Frankfurter→Yahoo→Alpha Vantage chain
the rest of the app uses (`fxToGBP` in `ui/shared.jsx`) and stored back on
the property/mortgage — this keeps `core/property.mjs` pure/network-free,
the same pattern as the HPI `{purchaseIndex, latestIndex}` cache. Critically,
a record with no rate fetched yet is neither treated as 1:1 with GBP (would
misstate net worth) nor silently dropped from the total (would lose real
value/debt) — it contributes £0 to every GBP aggregate and its id is
collected in `needsFx` (mirroring the existing `orphanMortgages` pattern),
surfaced as an explicit warning banner in the Property tab until fetched. A
mortgage's currency and rate are independent of its property's — a EUR
mortgage on a EUR property still needs its own FX fetch.

## Phase 2, step 2: named cash accounts (rates + maturity dates)

- **`core/cash.mjs`** (new, node-tested, 8 tests) — named cash accounts
  (institution, rate, rate type, maturity date) layered ON TOP of the
  existing per-wrapper manual cash figure rather than replacing it: a
  wrapper's true cash total fed into the wealth model is the manual/
  unallocated amount PLUS the sum of its named accounts
  (`effectiveCashByWrapper`), so anyone who never touches this feature sees
  byte-identical behaviour to before. Same "own array, own setter, derive
  the total" shape as pension contribution cost-basis reconciliation.
  Balance-weighted blended rate excludes unrated accounts from both the
  numerator and the weighting denominator (an unknown rate isn't a 0% rate).
- **Wealth tab: new "Cash accounts" panel** — add named accounts per
  wrapper (label, institution, balance, rate, variable/fixed, maturity
  date), a blended-rate headline, and a maturing-soon callout (fixed-term
  accounts maturing or matured within 90 days — the cash-accounts analogue
  of the Property tab's fixed-rate-mortgage warning). The existing per-
  wrapper "Cash" input now shows "+ £X in named accounts" underneath when
  applicable, so the manual figure and the accounts total are both visible
  rather than one silently absorbing the other.
- **Two-step delete promoted to `shared.jsx`** (`TwoStepDelete`) — was
  duplicated as soon as a second tab (Property, then Wealth) needed the
  same "click again to confirm" pattern already used for pension-provider
  removal; now one component.
- **Backup version 6** — adds `cashAccounts`; v5 and earlier restore
  exactly as before.

Still open from the Phase 2 plan at this point (not yet built): an income
calendar, benchmark/volatility analytics, tax-aware rebalancing, an SA108
export pack, and an accessibility pass. (The income calendar is covered in
step 4, below.)

## Phase 2, step 3: property/liabilities in the retirement projection

- **New "Other net worth" input on the Plan tab** — property equity minus
  other (non-mortgage) liabilities, one click from "Sync from portfolio"
  (pulls `netWorth.propertyEquity − netWorth.otherLiabilities` from the
  Property tab). Deliberately kept OUT of `startWealth`/the pension/ISA/GIA/
  LISA pots that the accumulation and Monte Carlo engines actually grow and
  draw down — it's a static addendum to the estate at death only, never
  treated as liquid, drawdown-eligible, or market-growing wealth. That's a
  real modelling simplification (no downsizing/equity-release scenario),
  chosen deliberately over silently mixing an illiquid asset into a
  liquid-drawdown simulation, which would be the wrong kind of wrong.
- Since Plan already has its own detailed buy-to-let model (separate income-
  generating investment property with its own growth/rent/CGT-on-sale
  projection, pre-dating this Phase 2 work), the sync button and the new
  field's hint text both flag the double-counting risk explicitly rather
  than trying to auto-detect or merge the two — a rental property already
  set up under Buy-to-let shouldn't also be pulled in as "other net worth."
- No changes to the projection engine's core drawdown/tax/Monte Carlo math;
  `otherNetWorthStart` only ever appears additively in the final
  `estateReal` figure, so this carries none of the risk of touching the
  already-complex, untested-by-node (UI-embedded) financial model.

## Phase 2, step 4: income calendar + forward dividend forecast

- **`core/income-calendar.mjs`** (new, pure, 15 node tests) — a forward-
  looking view over income already modelled elsewhere, combined into one
  sorted, 12-month calendar on the Income tab:
  - **Gilt coupons/redemptions** — pulled straight from `giltAnalytics()`'s
    existing `cashflows` array (contractual dates, computed in Phase 1's
    gilt-ladder work) — nothing new to compute, just surfaced.
  - **Fixed-term cash account maturities** — from the cash accounts model
    (Phase 2, step 2); variable/easy-access accounts have no maturity date
    and are correctly never forecast.
  - **Dividends and interest** — the genuinely new piece: each (ticker,
    kind) series' payment history is classified into a cadence (monthly/
    quarterly/semi-annual/annual) by its *median* gap between historical
    dates (median, not mean, so one irregular special dividend doesn't
    derail an otherwise regular quarterly series), then the next
    occurrences are projected forward at the average of the last 3
    payments.
- **Every row is explicitly tagged "scheduled" or "estimated"** — gilt
  coupons and cash maturities are contractual dates; dividend/interest
  figures are a forecast that assumes the recent pattern holds. This
  distinction is shown in the UI, not just internal to the engine, since
  conflating "this will happen" with "this is my best guess" would be the
  wrong kind of confidence to hand someone planning around it.
- **Guardrails against inventing income**: a series needs at least 2
  historical payments before anything is forecast (one payment tells you
  nothing about cadence) — in practice this means a **recently-acquired
  holding won't show a forecast** until the user has recorded two dividend
  entries against it, even if the underlying company/fund pays reliably;
  this is a stated, deliberate trade-off (no external ex-dividend/payment-
  calendar data source is wired in) rather than a silent gap. A holding
  that's been fully sold by today gets no forecast dividends, checked via
  units-held-at-today against the full transaction ledger; a cadence that
  doesn't fit any of the four bands (gaps too irregular — e.g. ad-hoc
  special dividends) is left out entirely rather than forced into the
  nearest bucket.
- **Pension contributions are deliberately excluded** — an earlier version
  of this feature forecast them the same way as dividends, which was wrong:
  a contribution is money moving from the investor's pocket INTO the
  pension pot, not income received, so it doesn't belong in an "income"
  calendar. `buildIncomeCalendar` no longer accepts a `pensionCashflows`
  input at all (removed, not just unused, so it can't silently come back).
- **New "Calendar" sub-tab on Income** (`SubTabs`, alongside "Tax by year" /
  "Dividends & interest" / "ERI") — a summary strip (count + total per
  source, plus a 12-month grand total) above a sortable table (reusing
  `useSort`/`sortRows`/`SortTh` from Phase 1) of every event with its date,
  source, holding/account, amount and scheduled/estimated tag.
- Computed once in `CgtDashboard.jsx` from the **full** transaction ledger
  (all wrappers, not just GIA) — a forecast SIPP dividend is just as real a
  forward cashflow as a taxable GIA one; this is a "what's coming in" view,
  not a tax computation, so it deliberately doesn't reuse the GIA-filtered
  `txns` the ERI/CGT parts of the Income tab use.

### Still open from the Phase 2 plan

- Benchmark comparison, volatility/drawdown, fee drag
- Tax-aware rebalancing suggestions
- SA108 export pack; tax-year-end mode
- Accessibility pass + first-run experience

## Phase 2, step 5: benchmark comparison, volatility/drawdown, fee drag

- **`core/benchmark.mjs`** (new, pure, 15 node tests): `growthIndex` chains
  `twrFromValuations()`'s already-computed period factors (Phase 1's
  `returns.mjs`) into a cumulative index from 100; `maxDrawdown` finds the
  true peak-to-trough decline on that index (not just first-vs-last), with
  recovery detection; `volatility` computes annualised volatility from the
  sample stdev of period log-returns, scaled by the portfolio's own actual
  average snapshot frequency (snapshots are recorded whenever all holdings
  are priced, not on a fixed calendar, so this is a stated approximation
  rather than a silently-assumed daily/monthly one); `benchmarkCumulativeReturn`
  compares a fetched index/ETF price series against the portfolio's own TWR
  measurement window; `feeDrag` computes today's asset-weighted ongoing
  charges figure (OCF) cost from user-entered per-holding OCFs.
- **Why period factors, not raw £ values**: a portfolio that just received a
  deposit isn't "up" in the performance sense, and one that just paid out a
  withdrawal isn't "down" — `twrFromValuations` already nets cashflows out of
  each period's factor, so drawdown/volatility computed from those factors
  measure investment performance only, not cash movements in and out.
- **`api/benchmark.mjs`** (new serverless proxy) — Yahoo Finance historical
  daily closes for any symbol (same "accept any Yahoo ticker" policy as the
  existing `api/quotes.mjs`, not a hardcoded allowlist — a personal choice of
  benchmark shouldn't be gatekept), used to fetch a comparison series for
  whatever ETF/index the user picks (a few common trackers are suggested in
  the UI: a global tracker, a FTSE 100 tracker, a FTSE All-Share index, an
  S&P 500 tracker).
- **New "Benchmark & risk" sub-tab on Returns** (`SubTabs`, alongside the
  existing performance view): volatility + max drawdown stats; a benchmark
  ticker picker with a "Fetch" button showing portfolio TWR vs. the
  benchmark's buy-and-hold return over the identical window, plus the
  difference; and a fee-drag table (one row per open holding, an editable
  OCF %/yr input, computed annual £ cost, an asset-weighted portfolio OCF,
  and total annual cost).
- **OCF is manual input, stored in `secMeta[ticker].ocf`** — unlike
  prices/FX/gilts/HPI, there's no free, reliable, machine-readable source of
  fund OCFs this app has verified, so this is deliberately a per-holding
  number the user enters from the fund's KIID/factsheet rather than a
  scraped or guessed figure. `secMeta` was already a persisted, generic
  per-ticker store (ISIN, ERI flag, gilt coupon/maturity, pension provider),
  so this needed no new store key or backup-version bump.
- **Deliberately NOT reconciled with the Plan tab's "Platform + fund fees"**
  — that's a single flat-rate, forward-looking assumption feeding the
  retirement projection's Monte Carlo/deterministic drawdown math (built in
  step 3); this is a measured, per-holding, present-day figure. Mixing the
  two would mean either overriding the user's own planning assumption with
  today's actual holdings (which change) or vice versa — both UI sections
  say so explicitly rather than silently picking one.
- Benchmark comparison is a **buy-and-hold comparison over the portfolio's
  own measurement window**, not a risk-adjusted alpha — the UI says this
  explicitly, since daily benchmark prices against irregular valuation-
  snapshot dates can't honestly support a proper factor-attribution
  calculation.

### Still open from the Phase 2 plan

- Tax-aware rebalancing suggestions
- SA108 export pack; tax-year-end mode
- Accessibility pass + first-run experience

## Phase 2, step 6: tax-aware rebalancing suggestions

- **`core/rebalancing.mjs`** (new, pure — now 20 node tests after the
  two-bucket redesign below) — `allocationDrift` compares today's full,
  all-wrapper allocation against a user-set target %, and works out an
  over/underweight £ drift; `sellSuggestions` turns an overweight into
  specific holdings to trim; `buySuggestions` surfaces existing holdings
  of an underweight bucket that new money could go into (never a new fund
  — this app has no basis to recommend a specific product, so an
  underweight bucket with nothing already held just says so);
  `rebalancePlan` is the one-call orchestrator.
- **Redesigned to exactly two buckets — Bonds/gilts vs Equities — with VCT
  holdings excluded entirely.** The original version targeted the fine-
  grained instrument-kind split (equity/fund/investment_trust/gilt/
  bond_fund/cash) used elsewhere in the app; in practice a rebalance is a
  bonds-vs-equities risk decision, not a "how many different fund
  wrappers" question, so `targets` is now just `{ bonds, equities }` and
  every total/drift is computed over that pool only. VCT shares must be
  held 5 years to keep their income-tax relief and trade on a much
  thinner secondary market than an ISA/GIA fund, so a tool that casually
  suggested trimming one would be actively bad advice — `bucketOf(kind)`
  and an `eligiblePositions()` filter (both in `core/rebalancing.mjs`)
  strip VCT-wrapper positions and anything outside the two buckets (cash-
  classified instruments, unrecognised kinds) out of every function's
  input and denominator, not just out of the target split, so the
  percentages describe "of the money this tool can actually act on."
- **Sell ranking is the actual tax-aware part**: sheltered-wrapper (ISA/
  SIPP/LISA) and CGT-exempt-gilt holdings first (zero tax cost to
  sell, ever), then GIA holdings sitting at a loss or breakeven (banks a
  loss, costs nothing), then GIA gains ranked by SMALLEST gain fraction
  first — because Section 104 pooling means a partial disposal realises
  gain strictly pro-rata to the fraction of the pool sold, so the
  smallest-gain-fraction holdings raise the most cash per pound of CGT
  annual exempt amount (AEA) consumed. The AEA budget is shared across
  both buckets' sells together (a single portfolio-wide allowance, not one
  per asset class) — same modelling choice as the existing Bed & ISA
  planner (`bedAndIsaPlan`, `core/allowances.mjs`).
- **"Rebalance" sub-tab** on the CGT section (alongside Summary /
  Planning / Bed & ISA / Report / What-if): a two-row (Bonds/gilts,
  Equities) editable target-% table showing current vs. target and the £
  drift, an AEA budget control (defaults to this year's computed
  headroom, overridable), a ranked sell candidates table with each row's
  tax impact spelled out in words, and an "underweight — where new money
  could go" table. The info banner states the VCT exclusion (and the £
  amount excluded, if any) explicitly, so it's never a silent gap.
- Unlike every other sub-tab here, this one is explicitly **whole-portfolio**
  (every wrapper), not GIA-only — rebalancing is a whole-portfolio question,
  and the entire point of the sell ranking is that a sheltered-wrapper sale
  costs nothing, which only means something if sheltered wrappers are in
  view at all. A banner in the UI says so, since every sibling tab in this
  section is deliberately GIA-scoped.
- Targets are stored in `localStorage` only (`cgt.rebalance.targets`), not
  in the ledger or the JSON backup — they're a live planning input the user
  might change every session, not portfolio data, so they deliberately
  don't bump the backup version.
- Explicitly **mechanical, not advisory**: the UI states plainly that this
  computes from targets the user set, not a recommendation on what the
  targets should be — consistent with how the rest of the app (Bed & ISA,
  the multi-year disposal optimiser, the Plan tab's projections) presents
  "here's the math for your own assumptions" rather than an opinion on the
  assumptions themselves.

## Phase 2, step 7: SA108 export pack + tax-year-end mode

- **SA108 box numbers were wrong and are now fixed.** The CGT ▸ Report
  tab's CSV/print output previously labelled disposal proceeds/costs/
  gains/losses as "box 24/25/26/27" — verified against the current SA108
  (HMRC 12/25 edition, tax year 2025–26, page CG3) and the still-current
  12/24 edition (2024–25): those numbers belong to the **"Other property,
  assets and gains"** section. "Listed shares and securities" — what this
  app actually reports — is **boxes 31–35**, plus **box 45** (losses
  brought forward and used in-year) and **box 47** (losses available to
  carry forward). Source: [SA108 2026, HMRC 12/25](https://assets.publishing.service.gov.uk/media/69bd8990cfa346b9d47049e4/SA108-2026.pdf),
  cross-checked against the [SA108 2025, HMRC 12/24](https://assets.publishing.service.gov.uk/media/67e160d5d8e313b503358cc8/sa108-2025.pdf)
  edition — the listed-shares box numbers are identical across both, so
  this isn't a one-year fluke. There's no SA108 box for the CGT annual
  exempt amount itself (HMRC's software applies it automatically), so
  that figure is now labelled as a computation aid, not a form box.
- **Box 45/47 now use the actual cross-year loss chain** (`liabilityAllYears`,
  already computed once in `CgtDashboard.jsx` as `allYears`), not a fresh,
  unchained `liabilityForYear` call — losses brought forward can originate
  from any earlier tracked year, not just the single "losses b/f" figure
  the Report tab used to see in isolation. This threads a new `yearlyLiab`
  prop into `CgtSection`/`ReportTab` rather than recomputing the chain
  twice.
- **New "SA108 pack" export** — every tracked tax year's box figures and
  full disposal schedule in a single CSV download (`sa108-pack-<date>.csv`),
  instead of re-selecting one year at a time. This is the literal "a
  January where the app produces the numbers that go on the tax return"
  exit test — the whole filing history in one file.
- **`core/tax-year-end.mjs`** (new, pure, 10 node tests) — a single
  orchestrating function over already-existing allowance engines
  (`core/allowances.mjs`, `core/uk-tax.mjs`): how much of each "use it or
  lose it" allowance is still unused this tax year (ISA/LISA subscription
  headroom, CGT annual exempt amount, dividend allowance, Personal Savings
  Allowance), plus the pension annual allowance carry-forward check that's
  easy to miss — specifically the OLDEST of the three carried-forward
  years, since that year's unused amount permanently drops out of reach
  once the current tax year closes. Returns plain data (id, £ amount,
  which tab to jump to); wording lives in the UI layer, same convention as
  every other core module here.
- **"Tax year-end mode" is a banner on the Home tab**, not a separate mode
  to remember to switch on — it appears automatically once 5 April is
  within 60 days (same threshold the Allowances tab already uses for its
  own "days until 5 April" indicator), listing whatever's still unused
  with a one-click jump to the right tab. Outside that window it computes
  silently and shows nothing, so it doesn't clutter the daily check-in
  view for 10 months of the year.

## Phase 2, step 8: accessibility pass + first-run experience

- **Sortable table headers were keyboard/screen-reader inaccessible** — the
  `SortTh` primitive (used by nearly every table in the app: Income, Wealth,
  Returns, Holdings, CGT, Property) put the click handler directly on a
  `<th>`, which isn't natively focusable or operable. Fixed by moving the
  click target to a real `<button>` inside the cell (keyboard support for
  free — Tab, Enter, Space) and exposing sort state via `aria-sort` on the
  `<th>` itself, the attribute assistive tech actually reads for "this
  column is sorted".
- **Icon-only buttons had no reliable accessible name.** `title` alone isn't
  consistently exposed as an accessible name across browser/AT
  combinations. Fixed at the source: `IconBtn` (the header's backup/restore/
  theme buttons and others) now derives `aria-label` from `title`
  automatically; `TwoStepDelete` (Property/Wealth tabs' delete controls)
  got an explicit `aria-label`; five raw, unlabelled delete buttons
  (Pension fund/contribution rows, the Transactions ledger, Dividends &
  ERI rows) got one each, by hand, since they predate the shared component.
- **`SubTabs` now has real tab semantics** (`role="tablist"`/`"tab"`,
  `aria-selected`) — used by the Income, CGT and Returns sub-tab bars.
- **Sidebar navigation**: the active tab gets `aria-current="page"`; both
  the desktop rail and mobile drawer sit inside a labelled `<nav>` landmark;
  the mobile drawer is now a proper `role="dialog"` with `aria-modal`,
  moves focus to its close button on open, and closes on Escape — previously
  only a backdrop click could dismiss it.
- **Skip-to-content link** + a `<main>` landmark around the tab content, so
  keyboard users don't have to tab through the entire sidebar on every page
  to reach the thing they came for. The header's error banner is now
  `role="alert"` and the status message `role="status"`, so both are
  announced without the user needing to find and re-read them.
- This is a real but **bounded** pass, not an exhaustive audit — it targets
  the shared primitives and structural gaps that affect every tab (highest
  leverage for the effort), not a screen-reader-tested, WCAG-certified
  review of every individual feature file.
- **First-run experience** — a brand-new user with nothing entered
  (no transactions, no cash, no property/liabilities) used to land on the
  Home tab's normal view: a wall of "£0" and "nothing needs you today,"
  with no indication of what to do next. `HomeTab.jsx` now detects that
  exact all-zero state and shows a welcome panel instead — a one-paragraph
  explanation of what the app does, and four direct starting points
  (import a CSV, add a transaction by hand, add property/cash, or try the
  retirement projection, which works from assumptions alone). It steps
  aside permanently the moment any real data exists, computed from props
  `HomeTab` already receives — no new state or backup keys.

### Phase 2 complete

All eight build steps are done. The three-part exit test from the original
plan:
- **True household net worth** (assets − liabilities): step 1 (property/
  mortgages/liabilities) + step 2 (named cash accounts) feed directly into
  the Home tab headline (`householdNetWorth`, `core/property.mjs`).
- **A defensible "on/off track" answer**: the Plan tab's deterministic +
  Monte Carlo retirement projection (step 3) now includes property equity
  and state pension; step 5 adds volatility/drawdown/benchmark context for
  judging the investment side of that answer.
- **A January where the app produces the numbers that go on the tax
  return**: step 7's corrected SA108 box numbers (31–35, 45, 47 — the
  previous 24–27 labelling was wrong) and the multi-year SA108 pack export.

Steps 4 (income calendar) and 6 (tax-aware rebalancing) round out the
"what's coming in" and "what should I do about it" questions that a pure
balance-sheet/tax view doesn't answer on its own.

## Phase 1: engines out of the monolith, UI split, Home tab

Three structural changes, all behaviour-preserving (142 node tests green,
verified by SSR smoke renders, not just compilation):

- **Engines extracted from the JSX monolith** into pure, node-tested core
  modules: `core/uk-tax.mjs` (CGT liability incl. the 2024/25 mid-year rate
  split, loss carry-forward chaining, investment-income tax, the multi-year
  AEA harvesting optimiser), `core/ibkr-import.mjs` (Flex + Activity
  statement parsing), and `core/ishares-eri.mjs` (UK Reportable Income
  workbook parser). The test suites these engines' comments referenced
  (`incometax`, `ibkr`, `optimiser`-adjacent) did not actually exist in the
  repo — they do now (+53 tests, expectations hand-derived from GOV.UK
  rules, not computed by the engine under test).
- **UI split into feature modules** (`src/features/*` + `src/ui/shared.jsx`
  + `src/ui/LivePricesPanel.jsx`), lazy-loaded per tab via `React.lazy`.
  Initial JS drops 370 kB -> ~208 kB (xlsx/papaparse now load only when the
  Import tab does). Persisted app state moved to a Zustand store
  (`src/state/appStore.js`) with the SAME localStorage keys and
  setState-compatible setters — existing data and backups load unchanged;
  components can now subscribe to slices instead of re-rendering the world.
- **New Home tab** (default for new users): total-wealth headline with 1d/30d
  deltas, an SVG invested-value trend chart drawn from the automatic daily
  valuation snapshots (time-scaled x-axis, honest empty state until two
  snapshots exist), per-wrapper cards with unrealised gain and XIRR badges,
  allocation bars, and a needs-attention rail (prices >3 days old, unpriced
  holdings). Read-only by design — no editing on the most-visited screen.
- Also: `.gitignore` restored (node_modules/dist were commit-able before);
  fixed an unguarded `document.createElement` at module scope that crashed
  any non-browser load of the UI bundle (caught by the new smoke render).

## Phase 1 continued: sidebar IA, sortable tables, import dedupe

Closes out the three items left from Phase 1's original scope:

- **Five-section sidebar** (`src/ui/Sidebar.jsx`) replaces the flat, wrapping
  12-button top tab row — with Plan and Allowances added since the original
  build, a single row no longer scaled (it wrapped to 2-3 lines below a wide
  desktop) and gave no structure for finding a tab by what it's for. Grouped
  by purpose: **Overview** (Home, Plan), **Portfolio** (Wealth, Holdings,
  Returns), **Instruments** (Gilts, Pension & LISA), **Tax** (CGT, Allowances,
  Income), **Data** (Transactions, Import CSV). Desktop gets a static, sticky
  column; mobile (`<sm`) gets an overlay drawer opened by a header hamburger
  button, so narrow screens don't lose vertical space to a permanent rail.
- **Sortable table headers** — a shared `useSort`/`sortRows`/`SortTh`
  primitive (`src/ui/shared.jsx`) rolled out across every data table:
  Transactions, Holdings, the Gilts ladder, Returns' per-holding table, and
  Income's Dividends/Interest and ERI tables. Click a header to sort by it,
  click again to flip direction; blank/unpriced/unresolved values (no price,
  no FX) always sort to the end regardless of direction rather than
  collapsing to zero and jumping to the top. Returns' per-holding table keeps
  its open-positions-first grouping — the chosen sort applies within each
  group, not across both, so closed (always-£0) positions can't interleave
  into the open list.
- **CSV import dedupe** — every import path (generic CSV, dividends CSV,
  pension contributions CSV, IBKR Flex/Activity, iShares ERI workbook) now
  checks new rows against what's already in the ledger/income/pension-
  cashflow/ERI lists before appending, via a shared `dedupeAgainstExisting()`
  keyed on the fields that make a row the same transaction (date + ticker +
  side/kind + wrapper + amount, rounded to the penny so re-exported
  formatting differences don't defeat the match). Re-pasting an overlapping
  date range — the normal way these exports get re-run, not an edge case —
  now skips the already-imported rows instead of doubling them, with the
  skipped count shown before you click Import, not discovered after.

## Phase 1 continued: Plan tab, Allowances hub, Bed & ISA

- **Plan tab** — the standalone UK retirement planner is now integrated as a
  lazy-loaded tab (deterministic projection, Monte Carlo, historical replay,
  drawdown sequencing incl. tax-optimised order, triple-lock state pension,
  DB pensions, annuities, BTL, variable spending, Scottish rates). Theme
  follows the app's dark toggle; a "Sync from portfolio" button prefills the
  SIPP/ISA/GIA/LISA pots and salary from the live wealth model. recharts
  ships only in the Plan chunk — the main bundle is unchanged.

  **Redesigned later to plug into the dashboard chrome, not sit inside it as
  a separate app.** Originally the tab kept its own page title ("UK
  Retirement Planner" + a byline), and its own Save/Load buttons exporting a
  standalone `retirement-plan.json` — because its inputs (`p`, ~50 sliders/
  toggles) lived in component-local state backed by a direct
  `localStorage.setItem("uk-retirement-planner:inputs", ...)` call, entirely
  outside the app's Zustand store. That meant plan inputs were invisible to
  the IndexedDB durable mirror, the daily snapshot, and the app-wide JSON
  backup/restore — the same data-loss class fixed for the Allowances tab's
  overrides (see "ISA/LISA overrides" above) — and it's *why* the tab needed
  its own Save/Load in the first place: it had no other way to round-trip.
  Fixed the same way: inputs moved into the store as `planInputs`/
  `setPlanInputs` (`state/appStore.js`, registered in `durable.js`'s
  `PERSIST_KEYS`, folded into `exportJSON`/`importJSON`, backup version
  7→8), with a one-time migration from the old localStorage key (which
  happened to already be JSON-encoded the same way the store expects, so it
  reads straight through). With inputs in the shared store, the tab no
  longer needs its own Save/Load — the app-wide one already covers it — so
  both buttons and the page title/byline were removed; the sidebar's "Plan"
  label already identifies the tab, and repeating it inside was noise.
  The assumptions panel also moved from a 330px-wide left sidebar (competing
  with the app's own sidebar nav for the same edge of the screen) to a
  collapsible strip above the main content, laid out as a wrapping card grid
  rather than one long vertical column — same ~50 controls, same eleven
  grouped sections, just horizontal instead of a second sidebar.
- **Allowances tab** — one screen for the annual limits: ISA £20k (derived
  from ISA/LISA purchases, stated as an upper bound, manual override wins),
  LISA £4k, pension annual allowance with taper + 3-year carry-forward
  table (from the recorded contribution history), CGT AEA headroom from
  this year's realised disposals, dividend allowance and PSA with estimated
  tax at your band, and a 5-April countdown.
- **CGT ▸ Bed & ISA** — new engine (`core/allowances.mjs`, node-tested,
  12 tests) solves the max transfer under both the remaining AEA and the
  remaining ISA allowance, with two objectives (max value sheltered / max
  gain washed), 0.5% stamp on shares & ITs (not funds), spread estimate,
  and one-click generation of the paired GIA-sale + ISA-rebuy ledger
  entries (two-step confirm). The 30-day rule note is in the UI: an ISA
  repurchase is not matched against the GIA disposal — that's the point.

## Round 3: XIRR sanity, one-click price refresh, IndexedDB durability

- **Short-span XIRR shows n/a, not noise.** Annualising a position days old
  produces absurd figures (12 days of gain "annualises" to thousands of
  percent). Every XIRR display (Home wrapper cards, Returns headline +
  tables, Pension provider badges) now routes through one gate: under 90
  days of history, or beyond ±1,000%/yr, it renders "n/a" with the reason
  in the tooltip instead of the number.
- **Refresh prices from Home.** The bulk fetch (DMO gilts with report-date
  skip, Yahoo in bulk, Alpha Vantage fallback, pension funds excluded) is
  extracted to `ui/priceRefresh.js` and shared by the Wealth/Holdings
  panels and a new "Refresh prices" button on Home's needs-attention rail —
  no more navigating away to update a stale price.
- **IndexedDB durability.** localStorage remains the synchronous primary,
  but every persisted key is now mirrored (debounced) into IndexedDB, with
  one full-state snapshot per day (rolling 30). At boot, if localStorage
  has been emptied (browser cleanup, "clear site data", Safari ITP) and
  the mirror has data, it's restored before the app loads — the previous
  single-catastrophe data-loss risk is gone. Degrades silently to the old
  behaviour where IndexedDB is unavailable. Pure logic (key coverage,
  snapshot pruning, restore decision) is node-tested (durable.test.mjs).
- Fixed a latent rules-of-hooks hazard in HomeTab (memo after an early
  return) that could crash on a null→model transition.

## Layout
```
.
├── api/
│   ├── quotes.mjs          # Vercel serverless function (Yahoo price proxy)
│   ├── fx.mjs              # Vercel serverless function (Yahoo historical FX)
│   ├── gilt-prices.mjs     # Vercel serverless function (DMO gilt price proxy)
│   └── _lib/
│       └── dmo-gilt-parser.mjs  # pure RTF parser, shared with the test suite
├── src/
│   ├── CgtDashboard.jsx     # the app (React UI + tax config)
│   ├── core/                # pure, node-tested engines (no React)
│   │   ├── cgt-engine.mjs   #   HMRC matching: same-day → 30-day → S104 + ERI
│   │   ├── portfolio.mjs    #   wealth core: wrapper-aware unified holdings model
│   │   ├── returns.mjs      #   XIRR, TWR, snapshot TWR, income yields
│   │   └── gilts.mjs        #   coupon schedule, accrued, GRY, AIS
│   ├── test/                # node --test suites
│   │   ├── cgt-engine.test.mjs
│   │   ├── portfolio.test.mjs
│   │   ├── returns.test.mjs
│   │   └── gilts.test.mjs
│   ├── main.jsx             # React entry
│   └── index.css            # Tailwind directives
├── index.html               # Vite entry
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── vercel.json
└── .gitignore
```

## Wealth core (build step 1)
The CGT matching engine is now a standalone module (`src/core/cgt-engine.mjs`)
shared by both the CGT view and a new wealth core (`src/core/portfolio.mjs`).
The wealth core promotes `wrapper` (GIA / ISA / SIPP / LISA) from a CGT filter
flag to a first-class dimension: every holding belongs to a (wrapper, ticker)
pool, and the model rolls up across wrappers (total wealth) or within one, with
tax logic gated to where it applies — GIA taxable; ISA/SIPP/LISA sheltered;
individual gilts CGT-exempt (TCGA 1992 s115) but coupons taxable as interest.
It reuses the one matching engine for pooling, so a GIA holding's book cost is
identical to what a future S104 disposal leg would compute.

## Wealth tab (build step 2)
The app now opens on a Wealth overview — a pure view over `buildWealthModel()`:
total wealth (holdings + per-wrapper cash), per-wrapper roll-up with editable
cash balances, allocation by wrapper / asset class / native currency / fund
domicile, and a consolidated all-wrapper holdings table with the existing live
price feed (prices are per ticker, shared with the GIA Holdings tab).
CGT-exempt instruments are chipped; unpriced holdings are flagged and excluded
from market value rather than silently zeroed. Cash is included in the JSON
backup (version 3; v2 backups restore fine, just without cash).

## Returns tab (build step 3)
Money-weighted return (XIRR — Newton with bisection fallback, 365-day count,
validated by NPV-zeroing and analytic cases) at holding / wrapper / total
level; per-holding time-weighted return over the current holding episode,
exact from trade-implied unit prices with distributions treated as reinvested;
trailing-12m vs forward income yields (ERI counts as income for yields but is
never an XIRR cashflow — no cash moves). Portfolio-level TWR is computed
EXACTLY from a valuation-snapshot series the app records automatically each
day all holdings are priced — until two snapshots exist it is reported as
unavailable rather than approximated from stale prices. Snapshots and the
active tab persist; backups are now version 4 (adds `valuations`; older
backups restore fine).

## Gilts tab (build step 4)
Individual gilts as first-class instruments, on DMO/HMRC-verified conventions:
semi-annual coupons on the cycle anchored at maturity (month-end clamped),
actual/actual accrued interest, ex-dividend 7 business days before the coupon
(weekends only — UK bank holidays not modelled) with negative rebate accrual
in the window, dirty = clean + accrued, redemption at par plus final coupon.
Gross redemption yield is solved with the tested XIRR engine and reported in
both effective-annual and street semi-annual conventions. The Accrued Income
Scheme panel derives per-tax-year adjustments (one sign rule covers HMRC's
four cum/ex cases), taxed in the year of the next coupon, with the £5,000
small-holdings exclusion signposted — display-only, not yet folded into the
Income tab. Seeded with three fully-verified gilts (TN28 GB00BMBL1G81, TG31
GB00BMGR2809, T26A GB00BNNGP668); any other conventional gilt can be
registered in-app. Index-linked gilts are unsupported and say so. Trade dates
proxy T+1 settlement — flagged wherever it matters. Convention: gilt quantity
= £ nominal; prices per £1 nominal (clean), which is what the live feed
returns for LSE gilt lines.

## Live gilt prices (DMO proxy)
Neither Alpha Vantage nor Yahoo Finance covers individual UK gilts by ISIN
(verified by hand, not assumed — Alpha Vantage has no bond/ISIN asset class;
Yahoo carries gilt indices and gilt funds but not individual gilt lines).
The DMO itself publishes official daily "Gilt Purchase & Sale Service" prices
for exactly this purpose. `api/gilt-prices.mjs` fetches the DMO's RTF export
(far easier to parse reliably than their binary .xls — no BIFF dependency
needed) and returns `{ [ISIN]: { clean, dirty, redemptionDate } }`, walking
back up to 7 days to skip weekends/bank holidays. The Gilts tab's "Fetch DMO
gilt prices" button matches your registered gilts by ISIN and fills in their
clean price (midpoint of DMO's published purchase/sale quotes). The parser
is pure and tested against a real captured report (`dmo-gilt-fixture.txt`);
two real bugs — a redemption-date regex that didn't tolerate stray spaces,
and a sale-price pair that turned out to be [clean, dirty] in the RTF stream
despite the header text listing them the other way round — were caught by
that test before shipping, not discovered by a user later.

## Bug fix: pension funds were being sent to Yahoo/Alpha Vantage

Real bug: pension/LISA fund tickers (CITIUS, CITIGL, AVWXUK, etc.) were
included in the same live-price pull as everything else, meaning the app
would try to look them up on Yahoo/Alpha Vantage — these aren't exchange-
traded, so at best that's a wasted call, at worst a coincidental ticker
collision silently overwrites a fund's price with an unrelated stock's.

Fixed the same way gilts were handled earlier: `LivePricesPanel` now
detects `secMeta[tk].kind === "fund"` and excludes those tickers from the
Yahoo/AV pull entirely (both the bulk fetch and the per-row button), showing
"No live source — set manually on the Pension & LISA tab" instead of
Yahoo/AV symbol inputs it can never actually use.

## Feature: DMO gilt prices skip a same-day re-fetch

DMO publishes one gilt-price report per business day (~2pm) — a same-day
re-fetch is guaranteed to return identical data, so it's just a wasted
round-trip. The shared `fetchDmoGiltPrices()` helper now takes a
`knownReportDate` (the ISO date of the last report actually fetched,
persisted at app level) and skips the network call entirely when it
already matches today — across all three places gilts get fetched from
(Gilts tab, and both the bulk and per-row fetch in the Wealth/Holdings tabs'
live-prices panel), so the check only needed writing once. A "Force refresh
anyway" link appears when a fetch was skipped, in case you want to
double-check regardless.

## Bug fix: Returns tab's pension XIRR used the wrong dates entirely

Real bug: the Pension & LISA tab's own XIRR was already correct (built on
real contribution dates from `pensionCashflows`), but the Returns tab
computes XIRR generically from `txns` — and a pension fund only ever has
ONE consolidated transaction (a snapshot, not a purchase history). So the
Returns tab's per-fund and per-wrapper XIRR was measuring the time since
that one snapshot/last edit, not since money was actually contributed —
meaningless, and the two tabs visibly disagreed.

Kept `core/returns.mjs` itself general-purpose (it doesn't need to know
what a pension is) and fixed it at the UI layer instead:
- **Per-wrapper (SIPP/LISA) XIRR** is now recomputed from real contribution
  dates when available — same cashflow convention as the Pension tab,
  marked with a ◆ so it's clear which figure it is.
- **Per-fund rows** (CITIUS, CITIGL, etc.) now show "see SIPP" instead of
  their own XIRR/TWR — real per-fund attribution isn't possible, since
  contributions aren't tied to a specific fund in these provider exports.
  Showing "see {wrapper}" is more honest than a number that looks precise
  but isn't.

## Pension & LISA and Holdings tabs: whole-number totals

## Bug fix: pension cost basis wasn't tracking new contributions

Real bug from the previous session: contributions added via the Pension tab
or bulk import went into `pensionCashflows` for XIRR, but the fund
positions' book cost (shown on Wealth/Holdings) was a separate, static
number that never updated — so a new contribution improved XIRR but not the
"invested" figure everywhere else, and the two could visibly disagree.

Root cause: cost and price had been conflated. The original design set a
fund's book cost to `units × price` every time either was edited — a
reasonable placeholder when there was no contribution data at all, but wrong
once contributions exist, since price is a live market input (like every
other holding in the app) and has nothing to do with what was actually paid in.

Fixed by separating the two:
- **Units** editing changes quantity only, cost untouched.
- **Price** editing changes only `prices[ticker]` (market value), same as
  everywhere else in the app — never cost.
- **Cost** is either derived from contributions (once any exist for that
  provider, via `core/pension-import.mjs`'s new `allocateCostByValueWeight` —
  pure, tested, exact-sum-preserving allocation by current-value weight) or
  manually editable (only offered when a provider has no contribution
  history yet, as a sensible fallback).
- Reallocation runs automatically right after adding a contribution
  (individually or via bulk import — one shared `recomputeProviderCost`
  function, not two copies), plus a manual "Recalculate cost" button for
  after editing units/price or deleting a contribution.
- The fund table now shows Cost, Value, and Gain as separate columns
  (previously "Value" was silently just cost).

## LISA: book cost / market value, not just cash

Most LISAs hold stocks & shares, not just cash. Added a book cost / market
value pair (alongside the existing cash figure and the per-fund table) —
reuses the same position machinery as every other holding (a `qty=1`
synthetic position, price = market value) rather than a parallel schema, so
it flows into the Wealth tab exactly like anything else.

## Returns tab: click a wrapper to filter the holdings below

Clicking a row in the per-wrapper table now filters the per-holding table
underneath to just that wrapper (click again, or "Clear filter", to reset).

## Import CSV: wrapper selection made prominent, not hidden

The wrapper selector already worked for ISA/SIPP/LISA/VCT — verified by
reading `mapRow`/`mapDivRow`, which already threaded it through correctly.
The actual problem was visibility: a small dropdown tucked in the top-right
corner, easy to miss entirely. Replaced with the same pill-toggle style used
elsewhere, directly above each mode's content, with a visible sheltered-wrapper note.

## Live prices: how the refresh actually works

No auto-refresh anywhere in the app (verified — no polling, no timers).
Prices only update when you click "Fetch" (bulk, or the per-row ↻) or type a
value directly; each ticker shows an "Updated" timestamp so staleness is
visible rather than assumed.

## Transactions tab: wider fields, thousands separators

Columns widened again (the previous tightening pass overcorrected — narrow
enough to fit didn't leave enough room to read). Quantity, native amount, and
GBP amount now use a `NumberInput` component (same show-formatted/edit-plain
pattern as the existing `CurrencyInput`) — thousands separators while not
focused, plain editable number while typing.

## Transactions tab: wrapper filter instead of a column, contribution privacy fix

- **Transactions tab now has wrapper filter pills** (All / GIA / ISA / SIPP /
  LISA / VCT, each showing a count) instead of a Wrapper column in the
  table — filtering to one wrapper makes the column redundant, and adding a
  transaction while filtered defaults to that wrapper. Trade-off worth
  knowing: reassigning an existing transaction's wrapper is no longer a
  table-cell edit; if you need to move one, say so and I'll add it back in
  some form.
- **Pension contributions can be added individually now**, not just via
  bulk CSV import — a small form on the Pension & LISA tab (provider, date,
  type, amount) for a single payslip/statement. Both paths write the same
  cashflow record and feed XIRR identically.
- **Removed your real transaction history from the test fixtures.** The
  pension-import tests were checking their parsing logic against your
  actual Citi and Aviva CSV files, which meant your real contribution dates
  and amounts were sitting in the shipped repo. Replaced with synthetic
  fixtures that exercise the exact same edge cases (BOM, £/comma-formatted
  amounts, DD/MM/YYYY vs ISO dates, Switch/Phasing/Adjustment row types,
  an unquoted-comma CSV gotcha the synthetic data itself surfaced and got
  fixed) — same test rigour, no personal data. A stray real-data leak was
  also caught and fixed in one of the Import tab's placeholder examples.
- **Checked the L&G price-history API you found** — its `robots.txt`
  explicitly disallows automated access, on top of the general site ToS
  prohibition found earlier. Won't build against it.

## Pension IRR + contribution import

- **`core/pension-import.mjs`** — a new pure, tested module for parsing
  pension contribution/switch history CSVs. Built and verified against two
  genuinely different real exports (Citi/L&G: "Effective Date,Transaction
  Type,Transaction Currency,Amount", `£1,784.57`-style amounts, DD/MM/YYYY
  dates; Aviva: "Date,Symbol,Type,Currency,Amount", plain decimal amounts,
  ISO dates) — different headers, date formats, and amount formatting, all
  handled rather than assumed uniform. "Switch" rows (fund-to-fund
  transfers) carry no net cashflow and are excluded; everything else with a
  genuine nonzero amount is kept, including transaction-type labels the
  parser doesn't recognise (better to keep an unfamiliar-but-real
  contribution than silently drop it over wording).
- **New "Pension contributions" import mode** (Import CSV tab) — paste any
  provider's export, pick a provider (existing or new, via the same
  datalist pattern as the Pension tab), preview, import. Rows become
  cashflow records, not fund transactions — these exports don't break
  contributions down by fund, so nothing is fabricated at that level.
- **XIRR per pension provider** — the Pension & LISA tab now shows a
  money-weighted return badge per provider, reusing the exact same `xirr()`
  function already used for GIA/ISA holdings (not a reimplementation).
  Cashflows are the imported contributions (negative — money out of pocket)
  plus current market value (positive, units × live price where set). A
  contribution history list (expandable, deletable per row) sits under each
  provider's fund table.
- **Real contribution data replaced placeholder cost basis** for both
  existing pension groups: Citi/L&G (£454,378.68 total, 2005-2026) and
  Aviva (£98,573.45 total, 2023-2026), both split across their respective
  funds by current-value weight. Combined effect: SIPP unrealised gain
  moved from £0 (the old cost=value placeholder) to £730,721 — still an
  approximation given switches/contributions aren't tied to individual
  funds in these exports, but a large, real improvement.
- Non-GBP contribution rows with no resolved FX are visibly flagged
  ("needs FX") in the contribution list and excluded from XIRR, rather than
  guessed — same principle as everywhere else in the app.

## Pension providers, and a second UI pass

- **Pension providers**: fund holdings in the Pension & LISA tab now group
  under a `provider` tag (e.g. "L&G (Citi)", "Aviva (Wells Fargo)"), stored
  on `secMeta[ticker].provider`. Each provider group can be renamed inline
  (click its name) or removed entirely — a two-step confirm ("click again to
  remove all holdings") rather than a browser `confirm()` dialog, since those
  don't behave consistently across embedding contexts. The add-fund form's
  provider field is a `<datalist>` — pick an existing provider or type a new
  one, so adding a future employer's scheme, or fully transferring away from
  one, both just work.
- **Live pension prices — checked, not built**: looked into whether the L&G
  fund prices could be fetched the way DMO gilt prices are. Their own site
  terms explicitly prohibit "rate scraping" and using their tools "for any
  purpose other than to purchase a Legal & General product" — so unlike
  gilts (where an official, ToS-clear DMO source exists), there's no
  legitimate automated route here. The only other reference found was a
  Bloomberg ticker, equally not scrapable. Manual entry via the Pension tab's
  snapshot editor remains the practical answer.
- **Citi/L&G cost basis refined from real data**: a contribution/switch
  history (2005-2026, £454,378.68 total contributed) let the two Citi funds'
  cost basis move from a "cost = current value" placeholder (zero gain) to
  the real contribution total, split between the two funds by current-value
  weight. Flagged as an approximation, not a precise history — 61 fund
  switches over 20 years mean the true per-fund split shifted in ways this
  aggregate data can't reconstruct — but a large, real improvement over zero.
- **Fixed a self-inflicted bug**: the earlier `.input` height fix (see
  below) had applied a fixed single-line height to `<textarea>` elements too,
  crushing the Import CSV example boxes down to one line. Textareas now get
  their own rule (`min-height`, no fixed `height`) instead of inheriting the
  input/select one.
- **Found and fixed two broken placeholder newlines** in the Import CSV
  textareas: one used the HTML entity `&#10;` (which isn't decoded in a JSX
  attribute — it rendered as the literal text "&#10;"), another used a
  double-escaped `\\n` in a JS string (rendering as literal backslash-n).
  Both are now real newlines, and the boxes are taller (7 rows) so more of
  the example is visible without scrolling.
- **Income tab's "all wrapper" table** is now a toggle (pill buttons) between
  whichever wrappers actually have income data, rather than one flat table
  with a repeated Wrapper column per year — clearer at a glance.
- **Gilts' "Next coupon" column** no longer wraps to two lines.
- **Transactions table is tighter**: smaller font, narrower fixed-width
  columns, less padding — GBP amount and the delete icon now fit without
  horizontal scrolling on a normal screen.

## UI pass: navigation, editing, and layout fixes

- **Renamed to "Wealth Dashboard"** (app title and page title).
- **New Pension & LISA tab** — SIPP/LISA fund holdings are insurer-administered
  units with no live price feed and no buy/sell trading, so they get a
  snapshot editor (units × price per fund) rather than living in the normal
  transaction ledger. Editing a row replaces its underlying transaction
  outright (cost resets to the new value) since contribution history usually
  isn't available for these. LISA can also just be a single cash total if
  you don't want to itemise by fund.
- **CGT tab is now one tab with sub-tabs** (Summary / Planning / Report /
  What-if) via a small shared `SubTabs` component, instead of four separate
  top-level tabs — they're all views over the same GIA-only computation.
- **Income tab is now sub-tabbed** the same way (Tax by year / Dividends &
  Interest / ERI) instead of three stacked sections on one long page.
- **Transactions are now editable inline** — every field (date, ticker,
  side, wrapper, quantity, currency, native amount, FX, GBP) is a live input
  in the table, not just at add-time; editing native amount or FX recomputes
  GBP the same way the add-row form already did.
- **Fixed inconsistent input heights app-wide**: `.input`'s CSS had padding
  but no explicit `height`/`box-sizing`, so `<select>`, `<input type="date">`
  and `<input type="number">` rendered at different intrinsic heights across
  browsers. One CSS fix corrects every form in the app, not just Transactions.
- **Holdings and Wealth tab quantities** now round to 2dp (was 4dp).
- **Wealth tab**: holding names now show under the ticker (small, muted
  text); cash fields use a new `CurrencyInput` (£-prefixed, thousands
  separators while not focused, plain editable number while typing).
- **Returns' "Since" and Gilts' "Maturity" columns** no longer wrap to two
  lines (`whitespace-nowrap`, smaller font, and the tables now scroll
  horizontally instead of squeezing columns).

## Design pass: which tabs should show what

Two different kinds of tab need two different scopes, and the app hadn't
made that distinction clear:

- **Holdings and Income tabs now show ALL wrappers.** These describe what you
  own and earn, not what's taxable — GIA-only was just confusing. Holdings
  keys on (wrapper, ticker) since the same ticker can exist in multiple
  wrappers (e.g. SMT held in both GIA and ISA). Income adds an all-wrapper
  overview (with a Taxable/Tax-free column per row) above the existing
  taxable-only tax-by-year table, which is unchanged and still GIA-only —
  correctly, since that's what feeds the actual tax calculation.
- **Planning, Report, and What-if stay GIA-only, by design** — these
  specifically compute UK Capital Gains Tax, which doesn't apply to
  ISA/SIPP/LISA/VCT holdings. Each now carries a `CgtScopeBanner` explaining
  this, and the tab labels changed to "CGT planning" / "CGT report" /
  "CGT what-if" so the scope is obvious rather than assumed.
- **Gilt live prices are unified.** The Wealth tab's price panel used to list
  gilts but couldn't fetch them (only the Gilts tab's DMO button worked).
  `fetchDmoGiltPrices()` is now a shared helper — `LivePricesPanel` detects
  gilt tickers via `secMeta[tk].kind === "gilt"` and routes them to the DMO
  proxy while everything else still goes through Yahoo/Alpha Vantage, in both
  the bulk fetch and the per-row fetch button. One action, wherever gilts show up.

## VCT as a first-class wrapper
Venture Capital Trusts carry their own statutory exemption (Income Tax Act
2007 Part 6) — dividends are tax-free and disposals are CGT-exempt (gains
AND losses; VCT losses get no relief either), for both new-subscription and
secondary-market shares, verified against GOV.UK/HMRC and current guidance.
Modelled as a full wrapper (`VCT`, alongside GIA/ISA/SIPP/LISA) rather than
a per-instrument flag, since a VCT holding is categorically exempt regardless
of account. `WRAPPERS` and `WRAPPER_META` now live only in `core/portfolio.mjs`
— the app previously had a second, hand-maintained copy of the wrapper list
that would have silently drifted; it now imports the single source of truth,
and a shared `WrapperChip` component replaced three duplicated inline
conditionals for wrapper tag styling.

## CGT-exemption fix
The CGT summary/report/planning/what-if tabs previously computed a taxable
gain or loss on gilt disposals exactly like any equity — wrong, since
individual UK gilts are CGT-exempt (TCGA 1992 s115). Every view that computes
or reports CGT liability now filters exempt instruments out via
`classifyInstrument()` (core/portfolio.mjs) before the matching engine's
output reaches the tax computation; the CGT tab surfaces a visible count of
excluded gilt disposals, and the printable Report explicitly notes the
exclusion. The legacy Holdings tab is deliberately left untouched — it's a
holdings list, not a tax computation, so gilts still show there (and in the
dedicated Gilts tab). Verified with an SSR render using a synthetic ledger
with an equity gain and a large gilt "gain" in the same tax year, confirming
only the equity figure appears and the gilt is flagged as excluded, not
silently dropped.

## Private investments: EIS/SEIS shares and LP/VC funds

New tracked asset class for money that doesn't fit anywhere else in the
app: a direct EIS/SEIS investment, or a venture LP fund like "Passion
Capital IV" or "JamJar Fund II". None of these are exchange-traded — no
market price exists, and money moves via irregular capital calls and
distributions rather than priced buy/sell trades — so they get their own
tab and data model rather than being squeezed into the transaction-ledger/
wrapper system every other holding uses.

- **`core/private-investments.mjs`** (new, pure, 22 node tests) — two flat
  arrays, same "own array, own setter" shape as properties/mortgages: a
  HOLDING (identity, type EIS/SEIS/LP/other, share-issue date, income-tax
  relief % claimed, manual valuation) and an EVENT ledger against it
  ("call" for money invested — covers a single EIS subscription and an LP
  fund's staged capital calls the same way, so a fund drawn down in
  tranches is just several "call" events — "distribution_capital",
  "distribution_income", or "write_off"). `holdingSummary` gives
  called/distributed/current-value/MOIC/XIRR per holding (XIRR reuses
  `returns.mjs`'s solver: calls as negative flows, distributions positive,
  a terminal flow of today's valuation if still held); `privateTotals`
  pools every holding's cashflows into one blended portfolio MOIC/XIRR.
- **EIS/SEIS reliefs, modelled explicitly (2025/26 rates, stated not
  assumed)**: income tax relief at 30%/50% of the amount invested,
  aggregated by tax year of each holding's earliest capital call ACROSS
  every EIS/SEIS holding against the combined annual cap (EIS £1m, SEIS
  £200k) — the same "combined limit, not per-holding" check as the
  ISA/LISA £20k modelling in `allowances.mjs`; a 3-year CGT-exemption
  clock from the share-issue date (`cgtExemptionStatus`); and, for a
  written-off or underwater holding, the amount eligible for EIS/SEIS loss
  relief AGAINST INCOME rather than only gains (`lossReliefEligible`) — net
  of income tax relief already given and any capital already returned,
  usually far more valuable at the higher/additional rate than ordinary
  CGT loss relief. LP/"other" holdings get none of this (0% relief, no
  clock, no income-side loss relief) — they're just illiquid GIA-style
  investments; CGT on their eventual distributions/exit isn't computed
  here at all (there's no Section-104-style cost-pool concept for a fund's
  irregular capital calls the way there is for priced shares) — the UI
  says so rather than fabricating a number.
- **New "Private" tab** (Portfolio section of the sidebar): headline stats
  (called, distributed, current valuation, blended MOIC/XIRR), one
  expandable card per holding with its own capital-call/distribution
  ledger and CGT-exemption/loss-relief status chips, an add-holding form,
  and an EIS/SEIS relief-by-tax-year table mirroring the Allowances tab's
  style.
- **Counted in net worth**: `householdNetWorth()` (core/property.mjs) gets
  a new `privateValue` parameter — current valuations add straight into
  net worth (no debt-netting concept, unlike property/mortgages) — and
  Home's balance-sheet breakdown line shows a "Private holdings" figure
  once any exist, same additive pattern as the Property tab's rollout.
- **Backup version 9** — adds `privateHoldings`, `privateEvents`; older
  backups restore exactly as before, just without this data. New
  persisted keys registered in `durable.js`'s `PERSIST_KEYS`, with the
  exhaustiveness test updated.

## Ledger field widths + income calendar tax-treatment flag + income-by-wrapper chart
- **Transactions tab list**: Date/Side/FX columns narrowed (they don't need
  the full width of every other editable field); the add-entry form's Date
  field is now wider than its 8 siblings (`grid-cols-[1.3fr_repeat(8,1fr)]`
  instead of an equal 9-way split) — `yyyy-mm-dd` plus the native
  date-picker icon needs more room than a plain text/number field.
- **Income entries now carry a wrapper.** The "Dividends & interest" add
  form was missing a Wrapper field entirely — every entry silently defaulted
  to GIA via `normWrapper`'s null-handling, which meant the existing
  "All investment income by wrapper" table could only ever show ISA/SIPP/
  VCT rows for CSV-imported data, never anything added by hand. Fixed by
  adding a Wrapper selector to the add form (defaults to GIA, same as
  before, so nothing changes for existing data) and a Wrapper column to the
  entries table.
- **Income calendar tax-treatment flag**: every row in the Calendar
  sub-tab now shows a tax-treatment badge — `GIA/taxed`, `ISA/tax-free`,
  `VCT/tax-free`, `SIPP/tax-free`, `LISA/tax-free`, or `Interest/taxed` for
  un-attributed cash interest with no wrapper on record. Gilt redemptions
  and cash maturities show no badge (they're capital coming back, not
  income). `buildIncomeCalendar()` (core/income-calendar.mjs) now threads
  a `wrapper` through every event: straight from `gilts.mjs`'s cashflows
  and the cash account record for gilt/cash rows, and from the MOST RECENT
  matching income entry for dividend/interest forecasts (a holding can be
  re-registered onto a different wrapper, so the latest record is the best
  guide to where future payments will land).
- **New chart: "Income by wrapper, year on year"** on the Income tab's Tax
  by year sub-tab — a stacked bar chart (recharts, already a dependency)
  built straight from the existing `incomeAllWrappers` data, one bar per
  tax year (oldest → newest, left to right), one coloured segment per
  wrapper. Wrapper → colour is a fixed mapping (GIA/ISA/SIPP/LISA/VCT each
  keep the same colour across years, unlike the index-based palette used
  for allocation bars elsewhere) reusing the app's existing `--accent`,
  `--gain`, `--m-same`, `--m-pool`, `--m-bb` CSS variables.

## RSU vesting tracker
- **New `core/rsu.mjs`** — same "holding + events" model as private
  investments: a GRANT is the holding (ticker, grant date, optional note);
  VEST and SALE are events against it. Unlike private investments, an RSU
  ticker plugs straight into the app's EXISTING live-price pipeline — held
  shares are valued at `prices[ticker]` (the same GBP-per-share map every
  other tab already populates via LivePricesPanel/Yahoo/Alpha Vantage), so
  there's no new price-fetch code anywhere in this feature. A future-dated
  vest event IS the schedule (no separate "planned schedule" array to keep
  in sync with "actual" vests) — `vestingSchedule()` just splits a grant's
  vest events into vested/scheduled by date. `grantSummary()`/`rsuTotals()`
  compute held shares, an average vest-date-FMV cost basis, and an
  unrealised gain/loss — informational only, not a tax computation (see
  the module's header comment for exactly why UK income-tax-at-vest and
  CGT-on-sale aren't computed here, same honesty policy as the LP fund CGT
  gap in private-investments.mjs). 11 new node tests.
- **New "RSUs" tab** (Portfolio section of the sidebar): headline stats
  (held/vested/unvested shares, current value, unrealised gain), an
  embedded Live prices panel scoped to just the RSU tickers, an "Upcoming
  vests" table pooling every grant's future tranches soonest-first, and one
  expandable card per grant with its full vesting schedule, any sale
  events, and add-grant/add-event forms — same layout language as the
  Private tab.
- **Counted in net worth**: `householdNetWorth()` (core/property.mjs) gets
  a new `rsuValue` parameter (defaults to 0, same additive pattern as
  `privateValue`) — held RSU value adds straight into net worth, and
  Home's balance-sheet breakdown line shows an "RSU holdings" figure once
  any exist.
- **Backup version 10** — adds `rsuGrants`, `rsuEvents`; older backups
  restore exactly as before. New persisted keys registered in
  `durable.js`'s `PERSIST_KEYS`, with the exhaustiveness test updated.

## Phase 3, step 1: Monte Carlo in a Web Worker + Scenario A/B
- **`core/monte-carlo.mjs`** — the Plan tab's Monte Carlo stress test used
  to live as a same-file `runMonteCarlo()`/`randn()` pair in PlanTab.jsx,
  run SYNCHRONOUSLY on the main thread inside a `setTimeout(...,30)` hack
  purely to let the "running" spinner paint a frame before the computation
  froze everything else. Extracted into a pure, node-tested module with an
  injectable seedable RNG (`mulberry32`) — seeding matters for two things:
  reproducible test assertions, and `runScenarioAB()`'s "common random
  numbers" comparison (two parameter sets run against the IDENTICAL
  sequence of random market draws, so a success-rate/median-wealth delta
  reflects the parameter change, not which random path each side happened
  to draw). 12 new node tests.
- **`workers/monteCarloWorker.js` + `ui/useMonteCarloWorker.js`** — the
  simulation now runs in a real Web Worker, off the main thread, via a
  plain `run(inputs, {onProgress}) -> Promise<result>` hook. One worker is
  created lazily and reused across runs (including both sides of an A/B
  comparison), terminated on unmount; falls back to a synchronous in-place
  call if `Worker` is unavailable. The button now shows a real progress
  percentage from the worker instead of a fake pre-computation delay, and
  the run count went up from 600 to 1,000 since it no longer costs any UI
  responsiveness to do so.
- **Scenario A/B** on the Adequacy tab: a "Compare against" picker (reusing
  the existing scenario presets — Bull market, Bear market, 1970s
  stagflation, Lost decade, Sticky inflation) runs a second Monte Carlo
  alongside the base plan, same seed, and shows a second row of headline
  stats plus success-rate/median-wealth deltas, with both scenarios'
  median and 10th/90th percentile lines overlaid on one fan chart (base in
  green, comparison dashed in blue).

## Phase 3, step 5: IBKR Flex Web Service — live pull
- **`api/ibkr-flex.mjs` + `api/_lib/ibkr-flex-xml.mjs`** — a Vercel proxy for
  IBKR's Flex Web Service (`ndcdyn.interactivebrokers.com`), same reason
  api/quotes.mjs proxies Yahoo: no CORS for browser origins. Runs the
  documented two-step flow (SendRequest → GetStatement, retried with
  backoff since IBKR generates the report asynchronously) and hands back
  plain `{normalisedAttrName: value}` rows for Trades/Cash Transactions/
  Cash Report/Open Positions — no XML/DOM dependency, just two regexes
  (Flex Statement XML is flat, attribute-per-row), same "no heavy
  dependency" approach as `_lib/dmo-gilt-parser.mjs`'s RTF stripping. The
  Flex Query ID and token are supplied by the CLIENT on every call and
  never written to disk/logged server-side — this function exists purely
  to get around the CORS wall, not to hold credentials.
- **`core/ibkr-flex.mjs`** — shapes that raw pull into the EXACT same
  `{trades, income, warnings, format}` structure `parseIBKR()`
  (`core/ibkr-import.mjs`) already produces from a pasted Flex/Activity
  CSV, by reusing that module's own row-mapping functions (now exported as
  `ibTradeFromRow`/`ibCashFromRow`) — a live pull and a pasted CSV go
  through IDENTICAL FX/currency handling, wrapper defaulting, and
  needs-FX flagging, so every downstream consumer (ImportTab's preview
  table, dedupe, the actual import) works on either without caring which
  one produced it. 17 new node tests, including an end-to-end
  XML-string → shaped-trades test.
- **Import tab**: the existing "Interactive Brokers" import mode gained a
  Paste CSV / Pull live (Flex Web Service) toggle. Live mode needs a Flex
  Query ID and a Flex Web Service token (both entered once, stored
  locally in the browser like the existing Alpha Vantage key — never sent
  anywhere except to IBKR via this app's own proxy) and a Flex Query
  configured with the Trades and Cash Transactions sections enabled.
  Ending cash balances from the Cash Report are shown as a reconciliation
  aid, not auto-imported. IBKR has no ISA/SIPP/LISA/VCT concept, so pulled
  rows land in whichever wrapper is selected (defaults to GIA).
- **Backup version 11** — adds `ibkrQueryId`, `ibkrToken`; older backups
  restore exactly as before. New persisted keys registered in
  `durable.js`'s `PERSIST_KEYS`, with the exhaustiveness test updated.
  Note the backup file itself will contain the Flex token if one's set,
  same as it already contains the Alpha Vantage key — treat exported
  backup files with the same care as any file holding an API credential.
- **Honesty note**: this was built strictly to IBKR's documented, decade-
  stable Flex Statement XML schema (attribute names verified against
  IBKR's own field reference), and the parsing pipeline is fully
  node-tested against a synthetic statement — but this sandbox has no way
  to reach IBKR's servers, so the first live pull against a real account
  is the actual end-to-end test. If it comes back with zero trades/income
  despite a successful (200) response, the most likely cause is the Flex
  Query itself not having the Trades/Cash Transactions sections enabled —
  check that first.

## Bug fix: IBKR live pull reported "no rows" against a real account with real data
Diagnosed against an actual Flex Statement export from a real account (not a synthetic fixture) — surfaced two real gaps, both fixed:
- **The generic "no Trade or Cash Transaction rows" message was accurate but unhelpful.** The account's Flex Query was configured with a `period="LastBusinessDay"` date range (one single day) and had the **Interest Accruals** section enabled instead of **Cash Transactions** — so trades were genuinely absent (correct, just not explained) and £8.23 of accrued interest was silently dropped (a real gap: nothing parsed `InterestAccrualsCurrency` rows at all).
- **`core/ibkr-flex.mjs` now maps Interest Accruals into income too** — a different shape from Cash Transactions (`interestAccrued` not `amount`, no per-security symbol, a `fromDate`/`toDate` window not a settle date), so it's its own small mapping rather than a reuse of `ibCashFromRow`. IBKR's synthetic `BASE_SUMMARY` row (the whole account's accrual already converted to base currency) is used only when no real per-currency rows exist, so a multi-currency account never double-counts.
- **Warnings are now specific instead of one generic message**: a single-day statement explains the date-range fix directly ("widen the Flex Query's date range... e.g. 'Last 365 Days'"); Interest Accruals present without Cash Transactions flags that dividends specifically won't come through until that section's added; a genuinely empty statement (no sections enabled at all) gets the original catch-all message. `api/ibkr-flex.mjs` now also returns the statement's `fromDate`/`toDate`/`period` (via a new `extractStatementInfo()`) so the client can reason about *why* a pull came back thin, not just *that* it did.
- 8 new node tests, including a direct repro of the real account's statement shape.

## Import tab: full preview + duplicate flagging, RSU vest-history CSV import
- **Renamed "Import CSV" → "Import"** (sidebar and page prose) — the tab now covers a live API pull too, not just CSV.
- **IBKR source toggle reordered**: "Pull live (Flex Web Service)" first, "Paste CSV" second, matching which one most users will actually use now that the live pull works.
- **IBKR preview is no longer capped at 6 rows.** Every parsed trade and every parsed income row (dividends + interest, previously shown only as a count) is listed in a scrollable table, each with its own delete button — remove a row before importing without having to touch the source paste/pull at all.
- **Duplicate rows are flagged in the preview, not just reported after the fact.** `doImportIb`'s existing `dedupeAgainstExisting(...)` call (content-keyed on date/ticker/side/wrapper/quantity/amount, same as every other import path) already skipped duplicates silently at import time; the preview now runs the same key check up front and marks matching rows "dup", with a summary count and a note that they're skipped automatically either way — answers "how do I know this won't double-import" directly in the UI instead of only in this README.
- **New: RSU vest-release CSV import**, for the Wells Fargo/Shareworks-style "restricted stock units" / "restricted stock awards" export (`src/core/rsu-import.mjs`, `buildRsuImport()`/`mapRsuCsvRow()`/`parseUkDate()`/`guessTickerFromFilename()`, 17 new node tests against synthetic fixtures matching the real column set). Real-world shape, confirmed against two actual exports:
  - Columns: `Plan Description`/`Plan`, `Instrument`, `Grant Date` (UK-style "11 Jan 2023"), `Allocation quantity`, `Released quantity`, `Quantity to cover tax`, `Net quantity`, `Archive status` — no ticker column, no per-tranche vest-date column, only the original grant date.
  - Rows are grouped into one grant per **plan label + grant date pair** (verified needed against real data: one file reuses a plan label across different grant dates, the other reuses a grant date across different plan labels — either field alone under- or over-merges).
  - `Allocation quantity = Quantity to cover tax + Net quantity` on every row (verified arithmetically) — each row becomes a "vest" event for the gross allocation *plus* an automatic same-date "sale" event for the tax-withheld portion, so `core/rsu.mjs`'s held-shares total isn't overstated by shares that were never actually retained.
  - Ticker isn't in the file, so it's guessed from the uploaded filename (`guessTickerFromFilename`, e.g. "WFC" out of "...Wells Fargo WFC (NYS).csv") and always user-editable before import.
  - No vest-date-per-tranche column exists, so each vest/sale event is dated on the grant date, with an explicit warning that this is a limitation of the export — exact dates can be corrected on the RSU tab afterwards if known. Price/FMV is left blank, same "don't fabricate what the file doesn't say" policy as every other importer here.
  - Preview shows every source CSV row (not events) with a per-row delete button — deleting a row removes both the vest and its paired tax-cover sale together, since that's the natural transaction unit; grants/events are rebuilt fresh from the remaining rows on every change, so there's no separate "parsed" vs "edited" state to drift apart.
  - Import resolves against existing `rsuGrants`/`rsuEvents` by content key before assigning real ids, same two-phase dedupe pattern as the IBKR/pension/ERI importers — re-importing the same file is a no-op.

## RSU import: a second real export format (vesting schedule + notional dividends)
A second real Wells Fargo/Shareworks export turned out to be a genuinely different shape from the release-history one above — `core/rsu-import.mjs` now auto-detects which of the two it's looking at (`detectRsuCsvFormat()`) and dispatches accordingly, so `buildRsuImport()`'s call signature is unchanged for existing callers.
- **Columns**: `Grant Year`, `Plan Description`, `Contribution type` (`Award` | `Notional dividend`), `Grant Date`, `Available from`, `Quantity`, `Estimated value`, `Estimated value (unit)` — a forward-looking schedule of still-unvested tranches, plus notional dividend-equivalent shares accruing on them before vest.
- **This format DOES carry a real per-tranche vest date** (`Available from`), used directly rather than falling back to the grant date the way the release-history format has to.
- **The one real wrinkle, confirmed against the actual export**: `Grant Date` means something different depending on the row's `Contribution type`. On an `Award` row it's the tranche's true original grant date. On a `Notional dividend` row it's the *dividend's* record/payment date instead (e.g. a grant's Award row reads "11 Jan 2023" but its sibling Notional dividend rows read "1 Jun 2026"/"1 Mar 2026" — real WFC dividend dates, nowhere near the grant). `buildRsuScheduleImport()` resolves each plan label's true grant date from its own Award row(s) first, and only applies that to its Notional dividend rows — a plan with no Award row in the file at all falls back to its own raw date with a flagged warning, rather than silently taking a dividend date at face value.
- `Estimated value` is a report-generation-time projection, not the actual FMV on the real vest date — carried only as an informational note on each event, never written into `priceNative`/`fxRate` (which feed real cost-basis maths in `core/rsu.mjs`), same "don't fabricate" policy as everywhere else.
- ImportTab's RSU preview/table adapts its columns to whichever format was detected (plan/grant-date/allocation/tax-cover/net for release history vs plan/type/vest-date/quantity/estimated-value for a schedule export), with the same per-row delete and duplicate-badge behaviour either way.
- 15 new node tests against a synthetic fixture mirroring the real file's shape (multi-tranche awards, the Grant-Date wrinkle, the no-Award-row fallback, 4-letter month abbreviations like "Sept").

## IBKR dedupe: exact tradeID/transactionID matching, not just content
Content-based dedupe (date/ticker/side/wrapper/quantity/amount, rounded to the penny) can still produce a false negative if a re-pulled figure rounds a cent differently. IBKR's own exports carry a genuine unique id per row — `tradeID` on every Trade (Flex Statement XML always has it; a Flex Query CSV only if the user's query includes that field), `transactionID` on every CashTransaction — so that id is now captured as a hidden `ibkrId` field (never shown in the ledger UI) and preferred over the content key when present.
- `dedupeAgainstExisting()` moved to a new pure module, `core/dedupe.mjs` (node-tested — it previously lived in `ui/shared.jsx` with no direct test coverage), and now accepts either a single key function OR an **array** of them, checked in order — a row counts as a duplicate if ANY of them match. A key function returning null (e.g. the id-based key on a row with no id) is treated as "doesn't apply", never as a match against another null-keyed row.
- The IBKR import path passes `[ibkrIdKey, txnKey]`/`[ibkrIdKey, incomeKey]` — an exact id match wins when available, falling back to the original content key for rows imported before this field existed, or from a CSV export that never included the id column. Every other import path (generic/dividends/pension/ERI) is unaffected — still a single content-key function, same behaviour as before.
- `core/ibkr-import.mjs`'s `_ibTrade`/`_ibCash` (and the Activity Statement dividend/interest section) now extract `tradeid`/`transactionid` off whatever column/attribute is present, defaulting to `null` (never fabricated) when absent — flows automatically into both the pasted-CSV path and the live Flex pull (`core/ibkr-flex.mjs` reuses the same row-mapping functions).
- 10 new node tests: `core/dedupe.mjs`'s array-of-keys behaviour in isolation, id extraction from a CSV `TradeID`/`TransactionID` column, and a live-pull XML `tradeID` attribute passing through `shapeFlexPull`.

## Income tab: tax-treatment labels, monthly chart, hover totals, ERI clarity, thousands separator
- **Tax-treatment badges reworded**: `GIA/taxed` → `GIA (taxed)`, `ISA/tax-free` → `ISA (tax-free)`, `VCT/tax-free` → `VCT (tax-exempt)` — VCT dividends are exempt under a different statutory basis (ITA 2007 Part 6) than an ISA/SIPP/LISA's tax-free wrapper status, so it gets its own wording rather than reusing "tax-free".
- **New: "By month" forecast chart** on the Calendar sub-tab, just above the events table — stacks the same next-12-months `incomeCalendar` events by *source* (Gilt coupon/redemption, Dividend, Interest, Cash maturity) rather than by wrapper, since that's the more natural split for a forward-looking "what's coming and when" view and matches the summary cards already above it. (An earlier version of this lived on the Tax by year sub-tab as a historical by-wrapper chart; moved here to be forward-looking instead, since the calendar sub-tab already computes the forecast data it needs.)
- **Both stacked charts now show a running total on hover.** Recharts' default `Tooltip` only lists each series' own value; a new `StackedTotalTooltip` component sums whatever's in the hovered bar's payload and appends a bold total row — answers "what did this year/month add up to across every wrapper" without a separate invisible "total" series.
- **"Taxable investment income tax by year (GIA only)" now says so explicitly** — heading reads "(GIA only, includes ERI)" and the caption spells out that excess reportable income (ERI) from offshore reporting funds is folded into "Dividends" as a non-cash distribution, not a separate line. (It already was, via `eriTxns` in `CgtDashboard.jsx`'s `incomeByYear` — this was a documentation gap, not a calculation one.)
- **"Employment / other income" field now uses `CurrencyInput`** (£-prefixed, thousands-separated while not focused, plain editable number while typing) instead of a bare number input — same component already used for cash balances and allowance overrides elsewhere in the app.

## Property tab: an explicit "Foreign" region
A non-GBP property's Region field previously rendered as static "n/a — foreign" text, and the underlying `region` value was left at whatever UK region happened to be selected before switching currency away from GBP — harmless today (display already re-derives "foreign" from currency, not from the stored region), but an inconsistent stored value. `addProperty()` now explicitly stores `region: "foreign"` for a non-GBP property, `regionLabel()` resolves it to "Foreign" (kept out of `HPI_REGIONS` itself so it's never sent to the real Land Registry HPI API), and the form's Region field renders as a real (disabled) select showing "Foreign" for visual consistency with the GBP case, rather than a plain span.

## Wealth tab: credit cards, subtracted from net worth
New "Credit cards" section on the Wealth tab — named revolving-debt balances (card/issuer/balance/notes), same "own array, own setter" persisted-state shape as cash accounts. Deliberately its own small concern rather than folded into Property tab's "Other liabilities": a car loan or personal guarantee reads as property-adjacent debt, a credit card balance is a day-to-day no-collateral thing most people think about alongside cash. `core/credit-cards.mjs`'s `totalCreditCardDebt()` feeds a new `creditCardDebt` field on `householdNetWorth()` (`core/property.mjs`), subtracted from net worth exactly like other liabilities; the Home tab's net-worth breakdown gets a matching "Credit cards −£X" line, and the Plan tab's "other net worth" figure (property equity minus liabilities, kept out of the investable-pots retirement projection) now nets it off too. No APR/interest modelling — a balance is what was last entered, not a forecast, same principle as mortgages having no amortisation schedule.
- **Backup version 12** — adds `creditCards`; older backups restore exactly as before (missing key defaults to `[]`, zero credit card debt). New persisted key registered in `durable.js`'s `PERSIST_KEYS`, with the exhaustiveness test updated.

## Home tab: cash included in the asset-class allocation
The "By asset class" allocation chart (shared by Home and Wealth tabs — both read `model.allocation.assetClass`) only ever covered priced holdings; cash sits outside `positions` entirely, so a meaningful cash buffer was invisible in "how is my wealth split" even though it obviously belongs there. A new `withCashBucket()` helper (`core/portfolio.mjs`) folds `total.cash` in as its own "Cash" bucket (labelled via the existing `KIND_LABEL.cash` mapping) and rescales every other bucket's percentage against the combined total — geography/wrapper/currency allocations are deliberately left untouched (cash has no meaningful domicile or trading-currency dimension the way a priced holding does). A zero cash balance adds no bucket at all, so accounts with no cash on record see no change.

## Phase 3, step 2: Drawdown strategy simulator — extracted engine + MPAA
The Plan tab's deterministic retirement projection (`buildProjection()`) already did most of what "Phase 3, step 2" asked for — a 5-way withdrawal-ordering waterfall across pension/ISA/LISA/GIA (`STRATEGY`), PCLS-vs-UFPLS tax-free-cash handling, and income-tax band-filling via bisection (`grossForNetPension()`) — but it lived as ~640 lines of component-local functions inside `PlanTab.jsx`, untested and unreachable from anywhere else. The one genuinely missing piece was MPAA.
- **Extracted, unchanged, into two new pure core modules**: `core/uk-income-tax.mjs` (`personalAllowance`, `taxRUK`, `taxScot`, `employeeNI`, `annualAllowance`, `grossForNetPension`, `HR_THRESHOLD`) and `core/drawdown.mjs` (`buildProjection`, the `STRATEGY` waterfall, `giaWithdraw`, `spendMult`, `dbRate`, `annuityRate`, `btlYearly`, `effInflation`, `lifeExpectancy`, `HIST`/`replayDecum`). `PlanTab.jsx` now imports these instead of defining them locally — every call site is unchanged, this is a straight move plus tests, not a rewrite. 35 new node tests.
- **MPAA (Money Purchase Annual Allowance)**: previously untriggerable by anything the engine modelled, because accumulation (contributing) and decumulation (drawing) were strictly sequential — contributions only ever ran up to `retireAge`, decumulation only ever started there. A new `postAccessContrib` input (default 0, so every existing plan is unaffected) models a phased/part-time retirement where someone keeps paying into a DC pot while also drawing flexible pension income from another pot — the one realistic scenario where MPAA matters. The engine now flags `mpaaTriggerAge` (the first year any pension income is actually drawn — under UFPLS that's immediate; under PCLS, taking the 25% lump sum alone does NOT trigger it, only a subsequent income withdrawal does) and, from that point on, whether `postAccessContrib` exceeds the flat £10,000 MPAA cap (`mpaaBreachAge`, `mpaaExcessTotal`, running total across every year it recurs — it's an annual limit, not a one-off). `core/allowances.mjs` gains `MPAA_LIMIT`/`mpaaLimitedAA(aa, triggered)` as the reusable "cap the standard/tapered AA down to MPAA once triggered" primitive.
- **UI**: a new "Phased retirement" panel (next to "Tax-free cash") for the `postAccessContrib` input, with an inline status line; and an MPAA card on the Sequencing (Drawdown) tab — shown only when `postAccessContrib > 0` — spelling out the trigger age and, on a breach, the excess and what to do about it (reduce the contribution once drawdown starts, or stick to PCLS-only access). No attempt to compute the actual MPAA tax charge (that depends on marginal rate and scheme rules this app doesn't model) — flagged as a fact to act on, not a fabricated number.

## Phase 3, step 3: SWR, Guyton-Klinger, rolling sequence-risk, gilt ladder coverage
Four new pure, node-tested core modules rounding out the retirement-planning tools: the classic "safe withdrawal rate" question, a dynamic guardrails withdrawal rule, an aggregated view of the existing historical-replay stress test, and a real ladder-vs-need matching feature for the Gilts tab (previously just a cosmetic label on the sum of holdings).
- **`core/swr.mjs`** — `solveSWR()` answers a different question than the Monte Carlo success rate above it: not "does THIS plan's specific £-schedule survive", but "what's the highest flat, inflation-adjusted % of the pot alone (ignoring state pension/DB/BTL/spend profile) that has a 90% chance of lasting N years", found by binary search over withdrawal rate reusing `runMonteCarlo()` directly as the survival oracle rather than a second simulation loop. Surfaced on the Adequacy tab next to the plan's own implied initial withdrawal rate (year-1 pension + bridge draw ÷ wealth at retirement), so the two numbers sit side by side.
- **`core/guyton-klinger.mjs`** — `runGuytonKlinger()` implements the classic three decision rules (capital preservation: cut 10% if the withdrawal rate drifts 20% above where it started; prosperity: raise 10% if it drifts 20% below; inflation rule: skip the inflation raise after a losing year), frozen in the final 15 years, against a fixed-real-withdrawal baseline on the SAME random paths (common random numbers) — reports the success-rate uplift and the average number of cuts/raises a plan would actually experience. Explicitly doesn't model GK's fourth rule (portfolio-management reallocation) since this app has no dynamic asset-allocation engine to represent it.
- **`core/sequence-risk.mjs`** — `rollingStressTest()` aggregates the Plan tab's existing `replayDecum()`/`HIST` historical-replay primitive (previously only viewable one (sequence, offset) pair at a time, 9 fixed combinations via the picker) across EVERY valid offset of all three built-in sequences (30 total historical entry points) — survival rate and worst-case depletion age, both overall and per-sequence. Shown as a summary card row above the existing single-scenario picker on the Historical replay panel; the picker itself is unchanged.
- **`core/gilt-ladder.mjs`** — `buildGiltLadder()` groups `giltAnalytics()`'s already-projected cashflows (coupons + redemptions) by calendar year and checks them against a flat annual income target, reporting per-year coverage/surplus/shortfall plus which year first falls short. Deliberately scoped to gilts already held — there's no browsable universe of every UK gilt in this app to suggest new purchases from (the DMO daily report only covers registered ISINs), so this answers "does my existing ladder cover this need, year by year" rather than "here's what to buy". New "Ladder coverage vs. an income need" section on the Gilts tab, with a typed-in target and a scrollable year-by-year table.
- 39 new node tests across the four modules.

## Phase 3, step 4: read-only mobile layer
The app already had real responsive infrastructure — a desktop sidebar / mobile drawer split (`ui/Sidebar.jsx`), Tailwind breakpoints reflowing every tab's grids to one column, HomeTab.jsx already explicitly documented as "read-only by design". What was missing on a phone-sized viewport was a genuinely glanceable landing screen — the existing setup just reflowed the same dense editing UI into a single column, tab navigation and all.
- **`ui/useIsMobile.js`** — a small `matchMedia` hook at the same 640px breakpoint `Sidebar.jsx`'s `sm:hidden`/`hidden sm:flex` split already uses, so "mobile" means exactly the width the app already swaps to hamburger nav at. One source of truth, no new breakpoint invented.
- **`ui/PlanHealthCard.jsx`** — a compact retirement headline (pot at retirement, money-lasts-to age, year-1 net income, replacement ratio) built by calling `buildProjection()` (`core/drawdown.mjs`) directly on the stored `planInputs` — the exact same deterministic engine the Plan tab runs, condensed to four numbers with no charts and no Monte Carlo (that needs the Web Worker; a phone check-in should be instant). Shows a "no plan set up yet" prompt instead when `planInputs` is null.
- **`CgtDashboard.jsx`**: on a mobile-width viewport, the default view is now this read-only summary — `PlanHealthCard` + the existing `HomeTab` (reusing its exact prop object, `homeTabProps`, so there's only one place that assembles them) — instead of the tab tree. Sidebar, drawer, and Save/Load are hidden in this mode (nothing to navigate to, nothing new to back up from a read-only screen); a single "Open full app" button is the explicit escape hatch into the normal tabbed experience (sidebar/drawer return, every tab reachable exactly as on desktop), with a "← Summary" link back. The toggle is session-only, never persisted — every fresh mobile visit lands back on the summary, which is the point, while a mid-session "I need to add a transaction" moment is one tap away, not a dead end.
- No PWA/installable-app work (manifest, service worker, home-screen icon) — confirmed none existed before and treated as a separate, explicit follow-up rather than silently bundling it into "read-only layer".

## Inheritance tax projection
A new "Inheritance tax" sub-tab on the Plan tab — `core/iht.mjs`, a from-scratch pure engine (nothing IHT-related existed anywhere before this), plus a new sub-tab reusing the drawdown engine's own output rather than a second projection.
- **Nil-rate band (£325k) + residence nil-rate band (£175k, tapered £1 per £2 over a £2m estate)**, transferable between spouses via a single "married — assume full transferable bands" toggle (the real transferable fraction depends on the first spouse's own estate/NRB use, which this app has no way to model without a second full estate). 40% on the taxable excess, 36% if 10%+ of it goes to charity.
- **Business/agricultural property relief**, date-gated at the 6 April 2026 reform: 100% relief on the first £2.5m of combined qualifying value, 50% above (uncapped 100% relief for a projection dated before the cap takes effect).
- **Lifetime gifts (PETs)**: a per-gift log (date/amount/optional "exempt" flag for spousal/charity gifts/note), allocated against the nil-rate band in chronological order (oldest first, matching HMRC's own rule), with the standard 7-year taper relief table (0% relief inside 3 years, stepping to 100%/fully exempt at 7+) applied only to the portion of each gift that exceeds whatever NRB is left for it by the time it's considered.
- **Pensions join the taxable estate for deaths on/after 6 April 2027** (`pensionsInEstate()`), not before — the single biggest recent IHT rule change, and the reason the module always shows two snapshots side by side: "your estate today" (pensions excluded, since today is before that date) and "at your plan's final year" (pensions included, decades from now). The future snapshot reuses `buildProjection()`'s own final timeline row (`pensionReal`, `estateReal`) rather than a second projection engine — gifts you've logged simply age naturally between the two snapshots, since both call the same `projectIHT()` with a different `asOfDate`.
- **Live estate data gap fixed along the way**: the Plan tab never received private-investment or RSU values from `netWorth` at all (only property equity, net of liabilities, via the pre-existing `liveOtherNetWorth`) — a new `liveEstate` prop bundle (`CgtDashboard.jsx`) closes that gap for "today's" IHT snapshot.
- Deliberately doesn't model the £3,000/year annual gift exemption (a conservative simplification — real lifetime gifting shelters more than shown here, never less), trusts, or per-asset BPR/APR eligibility tests — stated once in the module's header rather than scattered across the UI.
- 22 new node tests, including HMRC's exact taper-relief percentages, RNRB taper arithmetic, chronological multi-gift NRB allocation, and the pension-in-estate date boundary.

## Security hardening (backups, IBKR token, API guard, CSP)
Product-review Phase 1, step 1 — three related fixes, no feature changes:

- **Secrets out of backups (backup v13).** `exportJSON` no longer includes
  `avKey` (Alpha Vantage) or `ibkrToken` — a backup file lands in Downloads/
  cloud-sync folders, and a plaintext credential inside it outlives every
  other secret-handling decision the app makes. Both are cheap to re-enter
  on a new machine; `ibkrQueryId` stays (useless without its token). Restore
  still ACCEPTS both fields from v12-and-earlier files, so nothing is lost
  restoring an old backup. The Save button's tooltip now says keys are
  excluded rather than warning they're included.
- **IBKR Flex token moved from GET query to POST body.** The old
  `GET /api/ibkr-flex?token=...` put the credential in the query string,
  which Vercel's request logs record verbatim — the one place this
  "stateless proxy" was accidentally persisting a secret. The endpoint now
  rejects GET outright (405) rather than supporting both, so the leak can't
  quietly come back; `ImportTab.jsx` switched in the same commit.
- **`api/_lib/guard.mjs` (new, node-tested, 14 tests)** — every serverless
  function now runs a shared guard first: (1) same-origin enforcement via
  `Sec-Fetch-Site` (unforgeable from page JS in evergreen browsers), falling
  back to Origin/Referer host matching — these proxies exist solely for this
  app's own client, and were previously an open relay anyone could hotlink;
  (2) a per-IP token-bucket rate limit (default 30/min, burst 15; the
  credential-bearing `ibkr-flex` gets a stricter 6/min). Honest scope stated
  in the header: the bucket Map is per warm lambda instance, not global —
  it caps sustained abuse without new infra, it is not a hard distributed
  quota (that would need KV/Upstash). Header-less clients (curl, uptime
  checks) pass the origin check by design — a scripted caller can fake any
  header, so the rate limit is what actually caps them. All API responses
  now send `Cache-Control: no-store`.
- **CSP + security headers (`vercel.json`).** A strict Content-Security-
  Policy fitted to what the app actually does: `script-src 'self'` (no
  inline scripts anywhere — verified), `style-src` needs `'unsafe-inline'`
  (the theming `<style>` block in `CgtDashboard.jsx` + inline style attrs),
  `img-src data:` (the select-arrow SVG in `shared.jsx`), `connect-src`
  allows only the app's own `/api` plus the two upstreams the CLIENT calls
  directly (alphavantage.co, api.frankfurter.dev), `worker-src 'self'` (the
  Monte Carlo worker is a bundled module), `object-src 'none'`,
  `frame-ancestors 'self'`. Plus `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and a denying
  `Permissions-Policy`. If a future change adds a new client-side fetch
  host, `connect-src` must be extended or the fetch dies silently in
  production — the console will show the CSP violation.

Still deliberately NOT done here (Phase 2 material): encrypting `avKey`/
`ibkrToken` at rest in localStorage (needs a passphrase UX decision), and a
session-only "don't persist my token" option.

## Daily net-worth history (full balance sheet, estimated days flagged)
Product-review Phase 1, step 2. The Home headline has shown TRUE household
net worth since Phase 2, but its history was never recorded — the only
series was `valuations` (securities-only, and only on days every position
was priced), so the trend chart ignored cash/property/liabilities and
gapped whenever one pension fund lacked a quote.

- **`core/net-worth-series.mjs`** (new, node-tested, 12 tests) — a second
  daily series with the OPPOSITE contract to `valuations`, which is exactly
  why it's a separate array rather than an extension: `valuations` must
  only ever be recorded from fully-priced positions (it feeds the exact
  portfolio TWR in `core/returns.mjs`), while a net-worth TREND should
  record something honest every day the app opens. Days with unpriced
  holdings record with `estimated: true` + the count instead of being
  skipped. Each record keeps the component split (invested/cash/property
  equity/private/RSU/liabilities), all-zero first-run states record
  nothing, one record per day, last write wins, identical-record upserts
  return the same array reference (no persist/re-render churn — same
  convention as the valuations effect).
- **Recording** — a shell effect in `CgtDashboard.jsx` right next to the
  valuations one, built from aggregates the shell already computes
  (`wealthModel.total` + `householdNetWorth()`). New persisted key
  `cgt.networthsnapshots` registered in `durable.js` (IndexedDB mirror +
  daily snapshots + the exhaustiveness test). **Backup version 14** adds
  `netWorthSnapshots`; older backups restore as before, the series simply
  restarts from today. No backfill: honest history requires prices the app
  never stored — the series starts when the feature ships, it doesn't
  fabricate a past.
- **Home chart (`TrendChart`, was `NetWorthChart`)** — a "Net worth /
  Invested" toggle (net worth default once it has ≥2 points; invested keeps
  the longer history for existing users and stays the purer market signal),
  "N days estimated" caption when the visible net-worth range includes
  unpriced days, and the headline 1d/30d delta chips now track actual net
  worth (matching the number they sit next to) once the series exists,
  falling back to the old invested-only behaviour before that.
- **Benchmark overlay ("vs VWRL.L")** — `overlaySeries()` rebases an index
  close series (via the existing `/api/benchmark` proxy, cached per
  symbol+span) to the first visible point. Stated honesty contract in the
  module and in the UI caption: this shows index MOVEMENT over the window
  and deliberately ignores later contributions/withdrawals — it is not a
  performance comparison (the Returns tab's TWR-vs-benchmark is the fair
  fight). Symbol is shared with the Returns tab's picker
  (`cgt.benchmark.symbol`); fetch failures degrade to an inline note,
  never block the chart.

## Home redesign: action queue, plan health on desktop, income strip
Product-review Phase 1, step 3. Home's rail led with data plumbing (stale
prices, unpriced holdings) while the financially expensive stuff — an
expired mortgage fix, unused ISA allowance, harvestable gains — was buried
or absent. Redesigned around a rule: "your money needs a decision" and
"the app would like a refresh click" are different classes of message.

- **`core/action-queue.mjs`** (new, node-tested, 10 tests) — a ranked
  queue of money decisions. It owns ONLY thresholds and ranking; every
  figure comes from the already-tested module that owns it (ISA
  subscriptions and AEA headroom from `allowances.mjs`, harvestable gains
  from the CGT-taxable S104 pools at live prices — the tax truth, ERI
  uplifts included, gilts excluded — drift from `rebalancing.mjs`,
  mortgage fixes from `property.mjs`, cash maturities from `cash.mjs`).
  Ranking: expired fix (SVR bleed) > matured fixed-term cash > ending
  soon, scaled by days; ISA/AEA urgency grows as 5 April approaches;
  drift needs real targets (sum to 100) and ≥5pp. Capped at 5 — a queue
  of twelve "actions" is a list nobody reads. Guardrails: no ISA lecture
  for a GIA-only user; when tax-year-end mode's banner is active the
  queue suppresses its own ISA/AEA items rather than saying it twice.
- **Home rail** = the queue, each item deep-linking to its tab (harvest
  and drift also pre-select the right CGT sub-tab via the sub-tab's own
  localStorage key before switching — CgtSection reads it on mount).
  Plumbing collapsed to one status line at the card's foot ("2 prices
  >3d old · 1 unpriced · Refresh"), with the old mortgage/no-trend/
  all-good rail cards deleted (queue, chart empty-state, and queue
  empty-state cover them respectively).
- **New second row**: `PlanHealthCard` (previously mobile-only — the
  deterministic 4-number plan headline now earns its desktop place; the
  mobile summary's separate copy removed so it doesn't render twice),
  a **90-day income strip** (reuses the shell's forward income calendar;
  estimated cadence-forecast amounts marked ≈, cash maturities excluded
  from the total since they're principal, not income, and the queue
  already covers them), and the allocation bars (moved from the rail).
- From the read-only mobile summary, tapping a queue item now opens the
  full app on that tab — `homeTabProps.setTab` is wrapped in the shell.
  Previously such taps changed hidden state behind the summary and looked
  like dead buttons.

## Concentration metrics + hand-tagged region/sector exposure (look-through v0)
Product-review Phase 1, step 4. The app's "geography" allocation is fund
DOMICILE — honest, but nearly useless for diversification (an Irish-
domiciled world ETF reports as Ireland). And nothing measured single-
company risk at all, despite RSU employer stock being a first-class
feature of this app.

- **`core/exposure.mjs`** (new, node-tested, 7 tests) — two jobs. (1)
  `concentration()`: top-holding/top-5 weights, HHI, and "effective
  holdings" (1÷HHI — a 20-line portfolio where one line is 60% behaves
  like ~2.6 holdings, and this number says so), plus single-stock alerts
  at ≥10% of priced value. Individual equities only — a 40% position in a
  world tracker is a choice, a 40% position in one company is a risk.
  RSU-held employer shares are folded in via `extras` and MERGED with any
  ledger position in the same ticker: employer stock split across the RSU
  tab and a GIA holding is still one company risk. (2) `exposureByTag()`:
  market value rolled up by hand-tagged secMeta `region`/`sector` fields,
  untagged value kept visible as its own bucket, never redistributed.
- **Holdings tab** — new Region/Sector tag inputs per ticker (free text
  with datalist suggestions; "Diversified" is the honest sector tag for a
  broad fund). A ticker's tags apply wherever it's held.
- **Wealth tab** — the Allocation card is now "Allocation & exposure":
  concentration stats + single-company warning line, and "By region/sector
  (your tags)" bars that stay hidden until at least one holding is tagged,
  with the untagged share stated in the caption. Native-currency and
  domicile bars unchanged (currency was already there, correctly captioned
  as a listing proxy). Factsheet-driven look-through (real constituent
  data) remains a Phase 2 feature — these bars show the user's own claims,
  clearly labelled as such.
- **Home action queue** — new `concentration` item (id per ticker, links
  to Wealth): "£X — 28% of invested wealth is WFC alone (RSU shares
  included)". Scores with the weight (10% is a note, 25%+ rivals an
  expiring mortgage fix) and is NOT suppressed by tax-year-end mode —
  concentration risk doesn't care what month it is. Wired in the shell
  from `wealthModel.positions` + per-ticker RSU values.

## PWA install, system-preference theme, small-text pass
Product-review Phase 1, step 5 — three small platform/polish items:

- **Installable PWA** — `public/manifest.webmanifest` + generated icons
  (192/512 + maskable + apple-touch-icon; indigo rounded square with the
  Home chart's rising-line glyph) and `theme-color` metas for both colour
  schemes. Deliberately NO service worker, stated in `index.html`: a
  mis-cached SW can pin a finance app to a stale bundle indefinitely,
  modern Chromium installs without one, and with all data in
  localStorage/IndexedDB there's no offline story an SW would add beyond
  asset caching. This closes the "no PWA work — separate, explicit
  follow-up" note from the Phase 3.4 mobile layer.
- **Theme follows the OS on first run** — `cgt.dark`'s DEFAULT is now
  `prefers-color-scheme` instead of hardcoded dark. Only the default
  changed: anyone who ever toggled the theme has `cgt.dark` persisted and
  keeps their choice; anyone who hasn't keeps following the OS on every
  load (the computed default is never written back until they express a
  preference).
- **Small-text floor lifted** — every `text-[10px]` → 11px and every
  `text-[11px]` body-copy/caption → `text-xs` (12px), across all tabs.
  Contrast was measured fine (muted-on-panel 5.8:1 light / 6.2:1 dark,
  AA-passing); the sizes were the real readability problem. SVG chart
  axis labels (`fontSize="11"` inside scaled viewBoxes) left as-is.

## Income floor: guaranteed income vs essential spending (Plan tab)
Product-review Phase 1, step 6 — the last Phase 1 item. The Monte Carlo
tab answers "will the portfolio last?"; nothing answered the flooring
question — "if markets fell apart, what still gets paid?" — even though
every input existed somewhere in the app.

- **`core/income-floor.mjs`** (new, node-tested, 6 tests) — for each
  retirement year, stacks guaranteed income (State Pension + DB pension +
  annuity + gilt-ladder cashflows) against the essential share of target
  spending, all in TODAY'S £. State/DB/annuity come straight from the
  deterministic projection's own timeline rows (`stateReal` etc., already
  deflated), so this module can never disagree with the Decumulation tab;
  gilt cashflows arrive nominal by calendar year (`giltIncomeByYear`) and
  are deflated with the same effective inflation the projection used.
  Honesty decisions in the module header: BTL rent is EXCLUDED (voids/
  arrears make it contingent — exactly what a floor screens out); gilt
  cashflows include maturing principal (in a ladder, redemptions ARE that
  year's spending money) but count only gilts held today, no assumed
  reinvestment — so the ladder visibly runs out. The summary's
  "permanently covered from" age requires every LATER year covered too,
  because a ladder can cover early years then quit (tested).
- **New "Income floor" sub-tab on the Plan tab** — four verdict cards
  (covered-from age, years covered, thinnest year, position at SPA), a
  stacked chart (step-shaped areas — pension/DB/annuity start on cliff
  dates, smoothing would lie) against essential + target spend lines, and
  a Note explaining exclusions and how to raise the floor. Gilt data
  flows from the shell's existing `giltAnalytics` via a new
  `giltCashflows` prop — the gilt ladder finally connects to the Plan.
- **New plan input `essentialPct`** (default 65% of target spend) on the
  Spending profile panel. Existing saved plans get the default via the
  usual `DEFAULTS` fallback; no migration needed.

## Phase 2.8: de-drilling, one theme system, UI smoke tests
Refactor-only step (no feature changes), done FIRST in Phase 2 because
household mode and the IA consolidation will churn exactly this wiring.

- **Prop de-drilling (price/security cluster).** `LivePricesPanel` was the
  worst offender: three tabs each forwarded the same 12 raw-state props to
  it verbatim. It now takes ONLY `tickers` and reads prices/AV key+meta/
  price meta/ledger/security meta/DMO date from the Zustand store via
  per-slice selectors — as do HomeTab, HoldingsTab, WealthTab, GiltsTab
  and RsuTab for all their RAW persisted state. The rule now enforced by
  convention: **props carry DERIVED data** (wealth model, returns,
  netWorth, concentration, gilt analytics — things the shell computes),
  **the store carries RAW persisted state**. RsuTab takes no props at all.
  Selector subscriptions also mean a price tick re-renders the panel, not
  the tab tree. Still to convert in a later pass (same recipe): Pension,
  Import, Income, Property, Private, Ledger, CGT, Allowances, Returns.
- **PlanTab on the app's theme.** PlanTab's private LIGHT/DARK palettes
  (a second theme system maintained by hand) now RESOLVE to the app's own
  CSS variables — paper→`--bg`, surface→`--panel`, ink→`--fg`,
  green→`--gain`, red→`--loss`, blue→`--m-same`, amber→`--m-bb`, soft
  backgrounds via `color-mix` — through the same `T.*` indirection every
  inline style already used, so it's a mapping table, not a 2,000-line
  restyle. Chart-only `gold` (and derived `ink2`) keep their own values.
  A future palette change now propagates to the Plan tab for free.
- **UI smoke tests (`npm run test:ui`, chained into `npm test`).** A node
  module-loader hook (`src/test/setup/`) transforms `.jsx` with esbuild —
  already present as Vite's own dependency, no new install — so
  `renderToString` runs under `node --test`. Seven smoke tests render the
  sidebar, Home (real `buildWealthModel` output AND the null-model error
  state), Holdings, Wealth, Gilts, RSUs and PlanHealthCard, asserting
  landmark strings and, above all, no throw. Not behavioural tests: they
  cover the one seam the 500 core tests can't — React wiring (props,
  store selectors, hook order) — which is where refactors break things.
  `renderToString` runs no effects, so no fetches or workers fire; the
  store's localStorage reads are already try/catch-guarded, so it boots
  clean under node.

## Phase 2.4: nine screens, ⌘K palette, hash deep links
Fifteen sidebar tabs consolidated into 9 screens organised by the question
being asked, with a command palette and URL deep links. The design
constraint that makes this LOW RISK: the app's tab state still holds the
same LEAF keys it always has — this is a presentation-layer regrouping,
so every existing `setTab()` deep link (action queue, first-run panel,
tax-year-end banner) works unchanged, and no tab component moved.

- **Screens** (`SCREENS` in `ui/Sidebar.jsx`): Home · Plan · Net worth
  (Balance sheet / Property & debts) · Portfolio (Holdings / Returns /
  Gilts) · Income · Pensions · Other assets (Private / RSUs) · Tax
  (Capital gains / Allowances) · Data (Transactions / Import), grouped
  Overview / Wealth / Tax & data. A screen with multiple leaves gets a
  `SubTabBar` above the content (same pill language as CGT's internal
  sub-tabs); the sidebar highlights whichever screen CONTAINS the active
  leaf. Notable moves: Rebalance stays inside CGT (its sell logic is
  AEA-aware, that's the point of it) but is now one ⌘K away; Gilts moved
  from "Instruments" into Portfolio; Income is its own screen (it was
  filed under Tax, where its income-calendar half never belonged).
- **⌘K / Ctrl+K command palette** (`ui/CommandPalette.jsx`, dependency-
  free): screens, sub-tabs, previously-buried tools (Bed & ISA,
  Harvesting, Rebalance, SA108 report, Income floor, Monte Carlo, IHT…)
  and open holdings by ticker. Navigation-only by design — no mutating
  actions in a fuzzy-matched list where Enter fires the top hit. Inner-
  tab jumps reuse the localStorage-before-setTab trick the action queue
  established; PlanTab's sub-tab is now persisted (`plan.subtab`, same
  pattern as `cgt.cgtsubtab`) which also means reload returns you to the
  Plan sub-tab you were on.
- **Hash deep links**: `#/<leaf>` (e.g. `#/holdings`), with an optional
  sub-tab segment for the two tabs that have inner tabs (`#/cgt/bedisa`,
  `#/plan/floor`). Setting the hash pushes history, so the browser back
  button walks screen history; a pasted deep link lands on the right
  inner tab. Inner-tab CLICKS don't rewrite the hash — one history entry
  per screen change is the sane granularity.
- Smoke tests updated for the new structure (9 UI tests now): every leaf
  must have a label and a containing screen, the sub-tab bar renders
  siblings only for multi-leaf screens, and the palette renders its item
  list when open.

## Phase 2.1: end-to-end-encrypted sync/backup (Vercel Blob)
Optional multi-device sync, OFF by default — the local-first model is
unchanged until the user opts in. Zero-knowledge by construction: the
server only ever stores the AES-256-GCM ciphertext envelope; the
passphrase-derived key never leaves the device.

- **`core/sync-crypto.mjs`** (new, node-tested, 8 tests — WebCrypto works
  under `node --test`, so the full round-trip is tested with zero new dev
  dependencies): PBKDF2 (600k iterations, SHA-256) → AES-256-GCM with
  fresh salt+IV per push; GCM authentication means a tampered envelope or
  wrong passphrase throws loudly, never silently decrypts to garbage
  state. 128-bit random sync ids; pure last-writer-wins decision
  (`shouldApplyRemote`) with the "own echo isn't newer" case tested.
  Threat-model honesty stated in the header: the device already holds the
  full plaintext in localStorage, so the passphrase is also stored
  locally for usability — what E2E protects is transit and the server.
- **`api/sync.mjs`** — Vercel Blob store (`@vercel/blob`, the one new
  dependency): `sync/<id>/latest.json` + 14 pruned history versions (the
  undo for LWW — a stale-clocked device can overwrite good data, and the
  versions are how you climb out). Guarded like the other functions but
  stricter (12/min); 5MB cap; clear 501 with setup instructions when no
  Blob store is connected. **Deploy note: create a Blob store in the
  Vercel dashboard (Storage → Blob) and connect it to the project.**
- **`state/sync.js`** — reads state straight from localStorage via
  `PERSIST_KEYS` (no store import → no cycle; every change already lands
  in localStorage synchronously). Push: debounced, hooked into the same
  persistence subscription as the durable mirror. Pull: `bootSyncPull()`
  runs in main.jsx BEFORE the app module loads — the exact pattern the
  IndexedDB eviction restore established — so a newer remote copy is
  already in localStorage when the store reads it; no mid-session state
  swap. Every failure degrades to a plain local boot. Sync config
  (id/passphrase/lastSyncedAt) lives OUTSIDE `PERSIST_KEYS` on purpose:
  it must never sync itself, mirror itself, or land in a backup file.
- **New "Backup & sync" leaf under Data** — create (passphrase ×2 +
  generated id + first push), connect-this-device (id + passphrase →
  restore + reload, with an explicit "this replaces everything here"
  warning), sync-now / restore-from-server / recovery-kit download
  (contains the id, deliberately NOT the passphrase) / two-step disable
  (local opt-out; the server copy stays for other devices). The
  no-reset consequence of zero-knowledge is stated in plain words in
  the UI, twice.

## Phase 2.5: transaction fees + account labels, generated backup (v15)
- **Fees (s38 incidental costs)** — optional `fees` field on transactions:
  a BUY's allowable cost is `gbpAmount + fees`, a SELL's net proceeds are
  `gbpAmount − fees` (`feeOf` in cgt-engine.mjs, one definition shared by
  every engine). Because `buildPositions` reuses `matchWithPool`, book
  cost gets fee-inclusive for free; XIRR flows and TWR flows include fees
  on both sides, so returns are NET of dealing costs (the fee shows up as
  the drag it really is). Critical semantics, stated in the engine and
  the Ledger UI: `fees` means charges NOT already inside the amount —
  IBKR imports net commissions into the amount (`netcash` handling in
  ibkr-import.mjs) and leave it unset; UK contract notes, which quote
  consideration and charges separately, use it. Rows without the field
  behave exactly as before — tested to the penny (fees.test.mjs, 6 tests).
- **Account label** — free-text `account` on transactions ("HL ISA",
  "IBKR") so two brokers inside one wrapper stay distinguishable; Ledger
  add-form + inline column with a shared datalist of labels already used.
- **`core/backup.mjs` (v15)** — export and restore now GENERATED from
  `PERSIST_KEYS` instead of two hand-maintained lists (an export object
  in the shell + ~25 `if (Array.isArray(d.x)) setX(...)` lines). Policy
  is data, not code: `EXPORT_EXCLUDED` (secrets/UI state/caches),
  `RESTORE_ONLY` (secrets still accepted from old files), `ID_ARRAYS`
  (uid refill), `MERGE_KEYS` (secMeta merges over the seed), and a TYPES
  table that validates every restored value (mismatches are skipped and
  reported, never applied). backup.test.mjs (6 tests) includes the same
  exhaustiveness guarantee the durable mirror has — a new persisted key
  that isn't explicitly exported or excluded fails the suite — plus a
  full build→restore roundtrip. The shell applies restores via the
  setter naming convention (`stateKey` → `setStateKey`), so a restored
  key can't be missing its hand-written apply line — that's the exact
  bug class this replaces.

## Phase 2.6: Fidelity UK import (built against a real export)
`core/fidelity-import.mjs` (node-tested, 6 tests + an anonymised fixture
mirroring the real file's structure) parses Fidelity's Transaction History
CSV: metadata preamble skipped by finding the header's landmarks, "06 Jul
2026" dates, tickers extracted as the last parenthesised token of the
security name, wrapper from each row's own Product Wrapper column (so no
manual wrapper selection — one file can span ISA + GIA). The Fidelity
quirk that earns its keep: dealing fees and stamp duty arrive as SEPARATE
rows tied to a trade only by account + order date — when that day has
exactly one trade, they fold into its `fees` (the Phase 2.5 field, so CGT
cost and net returns get them automatically); ambiguous days warn instead
of guessing. Trades use ORDER date (the CGT contract date), income uses
COMPLETION date (payment). Cash movements are counted and listed, never
silently dropped. Output shape is identical to parseIBKR(), so the Import
tab's existing preview/dedupe/import path is reused verbatim — Fidelity's
Reference Number rides the same id-dedupe slot as IBKR's tradeID, making
overlapping re-imports safe. Verified against a real July-2026 export
(1 trade with £27.76 of fees attached, 13 income rows) before writing the
fixture. Remaining brokers (HL, AJ Bell, ii, Vanguard) follow this
pattern when real exports are available.

## Phase 2.3: look-through v1 (factsheet exposure tables + mix similarity)
`core/lookthrough.mjs` (node-tested, 6 tests) upgrades exposure from
"one tag per fund" to real factsheet percentage tables:

- **Paste-based ingestion** — a collapsible "Fund exposure tables" panel
  on Holdings: paste the region/sector breakdown from any issuer
  factsheet ("United States 62.1%" per line; tabs/colons/% all accepted;
  labels canonicalised — United States/USA/U.S. → US, Asia Pacific ex
  Japan → Asia ex-Japan, etc; duplicates merge; a sum far from 100%
  warns). Stored on `secMeta[ticker].exposure` with asOf/source.
- **Blending with coverage tiers** — `portfolioExposure()` distributes
  each holding's value across its table's buckets; funds without a table
  fall back to the single hand-tag; neither → untagged, kept visible. A
  <100% table books the remainder to "Cash/other" rather than silently
  rescaling. The Wealth tab's caption states the split: X% of value has
  factsheet-grade exposure, Y% rides a tag, Z% untagged.
- **Mix similarity, honestly named** — Σ min(weight) over region buckets
  between every pair of table-backed funds, shown as chips with ≥80%
  flagged ("two OCFs for one exposure"). Labelled in the UI as a
  REGION-MIX proxy, not constituent overlap — two funds can hold the
  same countries via different stocks; holdings-file-level overlap is
  the future version. (Look-through v0's exposureByTag stays exported;
  the Wealth tab now uses the blended engine.)

## Tests
```
npm test        # node --test: 532 core tests + 10 UI smoke tests (test:ui)
```

## Deploy (recommended: Git → new Vercel project)
1. Create a NEW, empty Git repo (do NOT reuse the pension repo).
2. Commit these files and push.
3. Vercel → Add New → Project → import this repo.
4. Framework preset is detected as Vite (build `vite build`, output `dist`).
   The `/api/quotes` function is auto-detected. Deploy.

This becomes its own project with its own URL, leaving any existing Vercel
project (e.g. the pension dashboard) untouched.

## Deploy (alternative: CLI)
```
npm i -g vercel
vercel          # from this folder; first run links/creates a NEW project
vercel --prod
```

## Live prices
- Yahoo is primary via `/api/quotes` (needs `yahoo-finance2`, already in
  dependencies). LSE symbols use the `.L` suffix.
- Alpha Vantage is the silent fallback — paste the key in-app, or set
  `VITE_ALPHAVANTAGE_KEY` in Vercel's env vars to keep it out of the repo.
- Manual entry is the floor.
- **Fixed: bulk "Refresh prices" sometimes left a few tickers unpriced that
  then succeeded when refreshed individually.** Root cause was `/api/quotes`
  firing every symbol's `yf.quote()` concurrently via `Promise.all` —
  `yahoo-finance2` shares one crumb/cookie session per server process, and
  hammering it with N simultaneous requests intermittently tripped Yahoo's
  own per-session throttling for a handful of the concurrent calls, while a
  single isolated request (exactly what the per-ticker refresh button sends)
  never hit that contention. Fixed server-side by fetching symbols
  sequentially with a small stagger, and client-side (`ui/priceRefresh.js`)
  by retrying any stragglers left after the first batched call one at a
  time — the same thing a manual per-ticker refresh does — before falling
  through to the far more rate-limited Alpha Vantage.
- **Fixed: pension/LISA fund tickers (secMeta kind `"fund"`) permanently
  showing in Home's ">3 days old" stale-price warning.** There is no live
  source for these at all (insurer-administered, not exchange-traded — see
  the exclusion in `LivePricesPanel`/`refreshAllPrices`), so "Refresh
  prices" could never bring their `asOf` current; the warning was nagging
  forever over data that isn't wrong, just never live-quoted. `HomeTab.jsx`'s
  `staleTickers` now excludes kind-`"fund"` tickers from the check entirely,
  matching the exclusion already applied everywhere prices are actually
  fetched.
- **Fixed: Pension tab's manual unit/price inputs silently truncated to 2
  decimal places.** They used a raw `<input defaultValue={round2(...)}>` +
  `onBlur` pattern — `round2` rounds to 2dp, which re-truncated a 4dp fund
  price (e.g. `1.2345`) back down to `1.23` on every remount, a real
  precision loss, not just a display issue. Replaced with the app's
  existing `NumberInput` component (`dp={4}`, controlled, no rounding on the
  underlying value) — same fix incidentally widens the input, which was the
  originally-reported symptom.

## Verified
`npm install` and `npm run build` succeed; Tailwind emits the utility CSS
(including the CSS-variable theming classes). The serverless function loads and
returns clean per-symbol JSON. In local/preview sandboxes the Yahoo fetch is
blocked by network policy; it works once deployed to Vercel.

## Local dev
```
npm install
npm run dev      # app only; /api runs on Vercel (or via `vercel dev`)
```
