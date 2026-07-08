# UK Capital Gains Dashboard

Client-side React (Vite) CGT tracker + wealth dashboard, with a Yahoo Finance
price proxy running as a Vercel serverless function. All personal data stays in
the browser's localStorage; the deployment ships only code.

## Phase 1 (this change set): engines out of the monolith, UI split, Home tab

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

## Tests
```
npm test        # node --test: 76 tests across the four core modules + the DMO parser
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
