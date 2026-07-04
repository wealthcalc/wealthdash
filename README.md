# UK Capital Gains Dashboard

Client-side React (Vite) CGT tracker + wealth dashboard, with a Yahoo Finance
price proxy running as a Vercel serverless function. All personal data stays in
the browser's localStorage; the deployment ships only code.

## Layout
```
.
├── api/
│   ├── quotes.mjs          # Vercel serverless function (Yahoo price proxy)
│   └── fx.mjs              # Vercel serverless function (Yahoo historical FX)
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

## Tests
```
npm test        # node --test: 70 tests across the four core modules
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
