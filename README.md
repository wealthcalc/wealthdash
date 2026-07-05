# UK Capital Gains Dashboard

Client-side React (Vite) CGT tracker + wealth dashboard, with a Yahoo Finance
price proxy running as a Vercel serverless function. All personal data stays in
the browser's localStorage; the deployment ships only code.

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
