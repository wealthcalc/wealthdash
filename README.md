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

## Tests
```
npm test        # node --test: 290 tests across the core modules + the DMO parser
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
