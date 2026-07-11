# Wealth Dashboard — Full Product & Architecture Review

*Reviewed against Empower, Kubera, Monarch Money, ProjectionLab, Fidelity Full View. Target user: UK individual investor with ISA/SIPP/GIA, cash, property, gilts, ETFs, shares, dividend income. Codebase: ~19.5k lines, React 18 + Vite + Zustand, 32 node-test suites over pure core modules, Vercel serverless proxies. Review date: July 2026.*

**Scoring key:** Impact 1–10 (user value) · Difficulty 1–10 · Effort in senior-dev-days · Priority P1 (do now) → P4 (someday).

---

## 1. Executive summary

This is the most sophisticated UK-specific tax and retirement engine I have seen outside a professional planning tool. The pure-core architecture (tested, React-free `.mjs` engines for CGT S104 matching, ERI, bed & ISA solving, multi-year disposal optimisation, IHT, MPAA, Guyton-Klinger, SWR, seeded Monte Carlo with common-random-numbers A/B) is beyond what Empower, Monarch, or Kubera offer, and ProjectionLab has nothing like the HMRC-exact CGT computation or SA108 export. The engineering discipline is unusually high: exhaustive persistence-key tests, IndexedDB eviction recovery, Web Worker simulation, lazy-loaded tabs, honest handling of unpriced/unknown data ("an unknown rate isn't a 0% rate").

The product's weaknesses are the inverse of its strengths. It is an *engine with a UI*, not yet a *product*. The five biggest problems:

1. **Single-browser data prison.** Everything lives in one browser's localStorage (IndexedDB mirror mitigates eviction, not device loss). No sync, no multi-device, no encrypted cloud backup. One laptop failure between manual JSON exports loses data. This alone disqualifies it against every competitor.
2. **No look-through diversification.** "Geography" allocation is fund *domicile* — an Ireland-domiciled global ETF reports as "Ireland". No sector, region, currency, or holdings-overlap analysis. Rebalancing knows only two buckets (bonds/equities). For a portfolio of ETFs + shares + gilts, this is the largest analytical gap.
3. **Single-person model.** No partner/spouse. UK retirement and tax planning is fundamentally a couples problem: two ISA allowances, two AEAs, two personal allowances, interspousal transfers at no-gain/no-loss, spousal IHT exemption, two state pensions. Every competitor at least sums two accounts; a UK planner without couples modelling leaves the biggest legal tax lever unmodelled.
4. **History is fragile and partial.** Valuation snapshots record only on days the app is opened *and* every position is priced; the trend chart is securities-only (no cash, property, or net-worth history). Competitors' core artefact — the net worth time series — is here gappy and incomplete by construction.
5. **IA sprawl and a plumbing-centred Home.** Fifteen tabs, price management scattered across four of them, the god-component `CgtDashboard.jsx` drilling ~30 props, and a "needs attention" rail that talks about stale prices rather than money. The daily-check-in screen underuses the analytical firepower two clicks away.

Verdict: the moat (UK tax + planning depth) is real and defensible. The work needed is mostly *product* work — sync, look-through data, couples, and a redesigned Home — not more engine work.

## 2. Biggest weaknesses

| # | Weakness | Evidence | Impact |
|---|----------|----------|--------|
| 1 | No sync / multi-device / durable off-device backup | `state/durable.js` mirrors within the same browser only; backup is a manual JSON download | 10 |
| 2 | No look-through asset analytics (sector/region/currency/overlap) | `portfolio.mjs` `geography: (p) => p.domicile` | 9 |
| 3 | No couples/household modelling in plan or tax | `drawdown.mjs`, `uk-tax.mjs`, `iht.mjs` are single-person | 9 |
| 4 | Net-worth history gappy, securities-only | snapshot effect in `CgtDashboard.jsx` bails if `total.unpriced > 0`; `NetWorthChart` labelled "securities only" | 8 |
| 5 | Secrets (Alpha Vantage key, IBKR Flex token) in plaintext localStorage and inside exported backups; IBKR token in GET query string (Vercel request logs) | `exportJSON`, `api/ibkr-flex.mjs` | 7 |
| 6 | Transactions carry no explicit fees/commissions field; no OCF-aware net returns at position level (fee drag exists only as an estimate view) | `cgt-engine.mjs`, `portfolio.mjs` | 6 |
| 7 | Monte Carlo is single-asset i.i.d. normal, deterministic inflation | `monte-carlo.mjs` | 6 |
| 8 | Price plumbing (setPrices/avKey/avMeta/priceMeta/dmoReportDate) drilled into 6+ tabs instead of living in the store | `CgtDashboard.jsx` props | 5 |
| 9 | Unauthenticated open proxies — anyone can use your Vercel quota | `api/quotes.mjs`, `api/benchmark.mjs` accept arbitrary symbols, no origin/rate check | 5 |
| 10 | 2,160-line `PlanTab.jsx` with its own bespoke styling system (`T.ink` etc.) diverging from the CSS-variable system used everywhere else | `PlanTab.jsx` | 4 |

## 3. Highest-impact improvements (ranked)

| Rec | Impact | Difficulty | Effort | Priority |
|-----|--------|-----------|--------|----------|
| End-to-end-encrypted sync/backup (passphrase-derived key, zero-knowledge blob store; keep local-first) | 10 | 7 | 15–25d | P1 |
| Look-through exposure engine: ingest ETF constituent/exposure data (issuer factsheets or a holdings API), derive true region/sector/currency splits + fund-overlap matrix | 9 | 7 | 15–20d | P1 |
| Household mode: second person across Plan, CGT, allowances, IHT; interspousal transfer suggestions ("bed & spouse") | 9 | 6 | 15d | P2 |
| Daily net-worth series: record partial snapshots (carry last-known prices, flag estimated), include cash/property/liabilities; backfill from ledger | 8 | 4 | 5–8d | P1 |
| Home redesign around money, not plumbing (see §5) | 8 | 3 | 5d | P1 |
| Secrets hygiene: exclude keys/tokens from backups by default, POST body for IBKR token, session-only option | 7 | 2 | 1–2d | P1 |
| Fees on transactions + per-position net-of-cost returns | 6 | 3 | 3–5d | P2 |
| MC upgrade: two-asset (equity/bond) with correlation, stochastic inflation, optional historical bootstrap; Student-t option | 6 | 5 | 8d | P2 |
| Move price/secMeta plumbing into Zustand selectors; kill prop drilling | 5 | 3 | 3d | P2 |
| Proxy hardening: origin allowlist + token bucket + Cache-Control | 5 | 2 | 1d | P1 |

## 4. Missing features (that competitors have or users expect)

| Feature | Impact | Difficulty | Effort | Priority |
|---------|--------|-----------|--------|----------|
| True net-worth history chart (all assets, not securities-only) | 8 | 3 | 3d (after daily series) | P1 |
| Sector / region / currency exposure views | 9 | 7 | with look-through engine | P1 |
| Dividend forecast per holding from declared dividends (not just cadence detection) | 6 | 4 | 5d | P2 |
| Goal tracking beyond retirement (house, education, FI date) | 5 | 4 | 5d | P3 |
| Benchmark overlay on the Home trend chart (engine exists in `benchmark.mjs`; surface it) | 6 | 2 | 2d | P1 |
| Open Banking cash-balance feed (TrueLayer/GoCardless) | 7 | 6 | 10d + ongoing | P3 |
| NI record / state-pension qualifying-years modeller (voluntary Class 3 top-up ROI) | 6 | 3 | 3d | P2 |
| Annuity market-rate fetch (vs the current formula rate) | 4 | 4 | 4d | P3 |
| Scenario save/compare in Plan (named scenarios, not just A/B keys) | 6 | 3 | 4d | P2 |
| CSV column-mapping UI for arbitrary brokers (generic import exists but mapping is implicit) | 6 | 3 | 4d | P2 |

Deliberately *not* missing (already built, competitive or better): bed & ISA solver, CGT harvesting + 30-day-rule warnings, multi-year disposal optimiser, SA108 report pack, tax-year-end mode, MPAA, tapered AA + carry-forward, ERI, gilt ladder vs income need, income calendar, Guyton-Klinger, historical sequence replay, IHT with gifts/taper, RSU vesting, EIS/SEIS tracking, credit cards, foreign-currency property.

---

## 5. Information architecture review

### Current state

Five-section sidebar (Overview / Portfolio / Instruments / Tax / Data), 15 tabs. The grouping logic is sound and documented, but it has grown by accretion:

- **"Wealth" vs "Holdings" vs "Returns"** are three views of the same object (positions) split across three tabs with overlapping price-editing panels. Users must learn which tab edits what.
- **"Instruments" is a weak category** — Gilts and Pension & LISA sit there because they have special mechanics, but users think "my pension" (an account), not "an instrument class".
- **Income lives under Tax** but half its job (income calendar, all-wrapper income) is portfolio reporting, not tax.
- **CGT hides six sub-tabs** (Summary/Planning/Bed & ISA/Rebalance/Report/What-if) — Rebalance especially is portfolio strategy, not tax, and is undiscoverable there.
- Price management appears on Home, Wealth, Holdings, and RSUs.

### Which screens should exist (target: 9 primary)

1. **Home** — daily check-in (redesigned, §6)
2. **Net worth** — balance sheet: all assets/liabilities, history chart, property, cash accounts, credit cards (merges Wealth + Property + cash panels)
3. **Portfolio** — positions, allocation (incl. look-through), returns, benchmark, rebalancing (merges Holdings + Returns + CGT/Rebalance)
4. **Income** — dividends/interest ledger, forward calendar, yield analysis
5. **Retirement** — the Plan tab (keep sub-tabs; it's a planning workspace)
6. **Tax** — CGT + Allowances + tax-year-end + SA108 in one hub with sub-nav (Bed & ISA stays here)
7. **Pensions** — SIPP/LISA providers, contributions, gilts ladder can live under Portfolio or here
8. **Other assets** — Private + RSUs (both are "equity comp / illiquid" niche)
9. **Data** — import, ledger, backup/settings (move Save/Load and API keys here from the header)

Impact 7 · Difficulty 4 · 8–10d · **P2** (do after Home redesign; migrations of user muscle-memory are cheap now, expensive later).

### Navigation structure

Keep the sectioned left rail on desktop (it is the right pattern; Kubera/Monarch use the same). Add: (a) **global search / command palette** (⌘K: jump to holding, tab, action — "harvest", "add transaction") — Impact 6, Diff 4, 4d, P2; (b) **persistent tax-year selector** in the header (currently buried in CGT) — Impact 5, Diff 2, 1d, P2; (c) breadcrumb-free sub-tabs are fine, but give CGT's sub-tabs URLs/deep-links (state is currently in-memory only; browser refresh loses position) — Impact 4, Diff 3, 2d, P3.

### Dashboard hierarchy

Correct hierarchy for a daily-glance product: **Level 1** net worth + Δ; **Level 2** "what needs a decision" (allowances expiring, drift, maturing fixes, harvestable gains); **Level 3** allocation and per-wrapper detail; **Level 4** plumbing (prices, data freshness) — demoted to a single status line. Today levels 2 and 4 are inverted: the needs-attention rail leads with stale prices and reserves no space for financial insight.

### Mobile vs desktop

The read-only mobile summary with an explicit "open full app" escape hatch is a *good* and defensible design (most competitors ship a worse-than-desktop editable mobile UI). Improvements: make the summary a PWA (manifest + service worker + icon) so it installs to the home screen — Impact 6, Diff 2, 2d, P1; add pull-to-refresh prices; show Plan health + next income events on the summary (currently PlanHealthCard + HomeTab). Desktop: the `max-w-5xl` content column wastes space on wide monitors for table-heavy tabs — allow `max-w-7xl` on Holdings/Ledger/CGT — Impact 4, Diff 1, 0.5d, P2.

---

## 6. Wealth dashboard (Home) redesign

### Above the fold (1440×900 desktop)

Row 1 (full width): **Net worth headline** — figure, 1d/30d/1y deltas, sparkline of *full* net worth (not securities-only), breakdown chips (invested / property equity / cash / liabilities). Benchmark toggle overlays VWRL/target on the trend.

Row 2 (three columns):
1. **Action queue** (replaces needs-attention): ranked money decisions — "£X ISA allowance unused, 268 days left", "£Y AEA harvestable at £0 tax (open harvesting)", "Allocation 4.2% overweight equities (open rebalance)", "Fixed mortgage ends in 92 days", "Cash account matures 3 Aug". Each row deep-links to the acting tab. Data-plumbing alerts collapse into one status line at the bottom ("2 prices stale · refresh").
2. **Plan health** — reuse `PlanHealthCard`: on-track %, MC success rate from last run, years-to-target. Currently mobile-only; promote to desktop Home.
3. **Allocation** — asset-class + wrapper bars (keep), add drift-vs-target markers once targets exist on Home.

Row 3: **wrapper strip** (keep as is — it is genuinely good: XIRR chip, unrealised gain, unpriced flags).

Row 4: **Next 90 days of income** — compact horizon strip from `buildIncomeCalendar` (already computed in the shell and only shown in the Income tab; near-free win).

### What should be removed from Home

Stale-price ticker lists (collapse to one line), the "nothing needs you today" placeholder card (empty state can simply be absent), the read-only footnote paragraph (move to tooltip). The tax-year-end banner stays — it's the best widget on the page.

### Scores

| Change | Impact | Difficulty | Effort | Priority |
|--------|--------|-----------|--------|----------|
| Action queue (financial, ranked) | 8 | 3 | 3d (data all exists: `tax-year-end.mjs`, `allowances.mjs`, `rebalancing.mjs`, `property.mjs`, `cash.mjs`) | P1 |
| Full net-worth trend + benchmark overlay | 8 | 4 | 4d (needs daily-series fix, §3) | P1 |
| Plan health card on desktop Home | 6 | 1 | 0.5d | P1 |
| 90-day income strip | 6 | 2 | 1.5d | P1 |
| Demote plumbing alerts | 5 | 1 | 0.5d | P1 |

---

## 7. Portfolio analytics

### Missing metrics

| Metric | Impact | Difficulty | Effort | Priority |
|--------|--------|-----------|--------|----------|
| Sharpe/Sortino vs cash rate (volatility + TWR already exist in `benchmark.mjs`) | 5 | 2 | 1d | P2 |
| Concentration: top-holding %, top-5 %, HHI, single-stock alerts (esp. RSU employer stock — a real risk this user base has) | 7 | 2 | 2d | P1 |
| Currency exposure (trading currency now; underlying currency with look-through later) | 7 | 3 | 2d now | P1 |
| Net-of-fees return per position (needs fees field + OCF registry in `secMeta`) | 6 | 3 | 4d | P2 |
| Yield metrics: trailing 12m yield, yield-on-cost per holding and portfolio | 6 | 2 | 2d | P2 |
| Realised + unrealised total-return attribution per holding (price vs income) | 5 | 3 | 3d | P3 |

### Risk measures

Current: portfolio volatility, max drawdown, benchmark relative return, per-holding TWR/XIRR. Add: rolling 12m volatility chart; drawdown-from-peak indicator on Home; beta vs chosen benchmark (regression over snapshot periods — data already exists); stress deltas ("a 2008 repeat costs you £X today" — reuse `HIST` sequences against current allocation). Impact 6, Diff 4, 5d, P2. Skip VaR — false precision at daily-snapshot granularity; the honest-data culture of this codebase argues against it.

### Diversification analysis

The critical gap (§2.2). Phase it: (1) short term, hand-tag `secMeta` with assetRegion/sector for the user's actual holdings — days of work, immediate value; (2) medium term, iShares/Vanguard factsheet ingestion (the app already parses iShares workbooks for ERI — same pattern) for true look-through; (3) overlap matrix ("VWRL and SWDA are 98% the same book"). Impact 9 overall, P1.

### Asset allocation views

Keep the AllocBar (good, dense). Add: look-through region/sector donuts; a **target-vs-actual** view with named targets per asset class (extends 2-bucket `rebalancing.mjs` to N buckets — Impact 7, Diff 4, 4d, P1); wrapper × asset-class matrix (are bonds in the SIPP and equities in the ISA? — asset-location efficiency, a genuinely differentiating UK feature: Impact 7, Diff 3, 3d, P2).

### Income forecasting

`income-calendar.mjs` (cadence detection + gilt coupons + cash maturities) is a solid base. Add: declared-dividend override (next ex-div/pay dates for major holdings), per-month income bar chart with sheltered/unsheltered split, "income replacement ratio" vs planned retirement spend (ties Income to Plan — nobody else does this well), dividend-growth rate per holding from the ledger's own history. Impact 6, Diff 3–4, 6d total, P2.

---

## 8. Retirement planning improvements

The engine already covers: deterministic waterfall (5 drawdown orderings), PCLS vs UFPLS, band-filling, MPAA, state pension + triple lock, DB, annuity, BTL with Section 24, spending smile, Guyton-Klinger guardrails, SWR solver (90% target), historical replay with offsets, seeded MC in a worker with A/B common-random-numbers, IHT integration. This exceeds ProjectionLab's UK fidelity. Remaining gaps:

| Improvement | Impact | Difficulty | Effort | Priority |
|-------------|--------|-----------|--------|----------|
| **Couples**: two ages, two pots, two SPs, survivor scenario (drop to one SP + inherited pension), joint spending | 9 | 6 | 10d (engine) + 5d (UI) | P2 |
| **MC realism**: equity/bond two-asset with glidepath, correlated stochastic inflation, historical bootstrap mode | 6 | 5 | 8d | P2 |
| **Guaranteed-income floor view**: SP + DB + annuity + gilt-ladder coupons vs essential spend, per year (all inputs exist; connect gilt ladder to Plan) | 7 | 3 | 3d | P1 |
| **Tax-optimal drawdown solver**: search over withdrawal orderings/annual mixes to minimise lifetime tax instead of user-picked strategy; report "strategy X saves £Y vs your current pick" | 8 | 7 | 12d | P2 |
| **Sequence-risk surface**: current replay is 3 hand-picked sequences; add all rolling N-year windows from a long return history (1900s+) with a success heatmap | 6 | 4 | 4d | P3 |
| **State pension**: NI qualifying-years input + Class 3 top-up ROI ("£824 buys £302/yr — payback 2.7y") | 6 | 3 | 3d | P2 |
| **Safe-withdrawal UX**: unify SWR solver + Guyton-Klinger + fixed-real into one comparison table (same seed, same horizon) | 5 | 3 | 3d | P3 |
| **Pension tax-free-cash cap** — already modelled (`drawdown.mjs` caps PCLS at the £268,275 LSA); surface the cap and headroom in the PCLS UI | 4 | 1 | 0.5d | P2 |
| Retirement-smile citation + editable breakpoints | 3 | 1 | 0.5d | P4 |

Tax-optimisation opportunities inside the plan worth surfacing as advice cards: personal-allowance-filling drawdown pre-SP age (drawing £16,760/yr tax-free 57–67 is the single biggest UK drawdown trick — engine can already model it, but nothing *tells* the user); GIA-first vs pension-first IHT trade-off (post-2027 pension-IHT changes — verify current law before building); salary-sacrifice modelling in accumulation (NI saving currently invisible).

---

## 9. Tax module improvements

Existing coverage is excellent (S104/same-day/30-day, ERI, losses chaining, gilts CGT-exempt handling, AEA/dividend/PSA/ISA/AA gauges with carry-forward and taper, bed & ISA solver with 30-day warnings, SA108 pack, what-if, multi-year optimiser, tax-year-end mode). Remaining:

| Improvement | Impact | Difficulty | Effort | Priority |
|-------------|--------|-----------|--------|----------|
| CGT: explicit fees/incidental costs per disposal (s38 allowable costs) — currently gbpAmount must silently include them | 6 | 3 | 3d | P2 |
| Dividend allowance: forward projection ("on current run rate you'll exceed £500 by January — consider ISA shift") not just YTD gauge | 5 | 2 | 2d | P2 |
| ISA utilisation: flexible-ISA tracking (withdrawn amounts replaceable in-year) and April-6 "new allowance available" prompt | 4 | 2 | 2d | P3 |
| Pension AA: contribution *scheduler* — "to use £X carry-forward expiring 5 Apr, contribute by …" with net cost at marginal rate incl. taper cliff | 6 | 3 | 3d | P2 |
| Bed & ISA: batch plan across remaining AEA + ISA headroom jointly (solver exists per-holding; make it a portfolio-level plan with execution checklist) | 6 | 3 | 3d | P2 |
| Bed & spouse / interspousal no-gain-no-loss transfers (needs household mode) | 7 | 3 | 3d after couples | P2 |
| Scottish bands in *drawdown* plan (engine has `taxScot` — confirm Plan exposes region toggle end-to-end) | 4 | 1 | 0.5d | P2 |
| SA106 (foreign income) hints for USD dividends with withholding | 4 | 4 | 4d | P4 |
| CGT real-time reporting service export (HMRC RTT) alongside SA108 | 4 | 3 | 2d | P3 |

Also: `uk-tax.mjs`/`allowances.mjs` hardcode year tables — fine, but add a "law verified as of" banner date and a test that fails when the current tax year is missing from tables (a stale-law footgun as years roll).

---

## 10. Data integrations

| Integration | State | Recommendation | Impact | Diff | Effort | Priority |
|------------|-------|----------------|--------|------|--------|----------|
| IBKR Flex | Built (proxy + XML normaliser + dedupe, same mapping as CSV path) | Move token to POST body; store token encrypted-at-rest (WebCrypto, passphrase) or session-only; add scheduled auto-pull reminder | 6 | 2 | 2d | P1 |
| Fidelity UK | Missing | No API exists; build CSV profile for Fidelity's transaction/valuation exports (same pattern as Citi/Aviva pension profiles). Ask users for fixture files | 6 | 3 | 3d | P2 |
| Generic CSV | Built (Papa parse, dedupe, FX fill) | Add explicit column-mapping UI + saveable broker profiles (HL, AJ Bell, ii, Vanguard UK cover 80% of UK DIY market) | 7 | 3 | 4d | P1 |
| Market data | Yahoo proxy + Alpha Vantage fallback + DMO gilts | Yahoo is unofficial and breaks periodically — add a third fallback, surface per-source health; consider paid EOD feed as premium tier | 6 | 3 | 3d | P2 |
| FX | Frankfurter→Yahoo→AV chain | Good. No change | — | — | — | — |
| Property | Land Registry UK HPI (region-level) | Good honest choice. Optional: postcode-level via HM Land Registry PPD comparables as a "sense check" range, keep manual override primary | 4 | 5 | 5d | P4 |
| Pensions | Citi/L&G + Aviva CSV | Add profiles opportunistically. Pension dashboards (MaPS) API — watch, not build | 3 | — | — | P4 |
| Open Banking (cash) | Missing | TrueLayer sandbox behind a premium flag; cash is the stalest data class in the app | 7 | 6 | 10d | P3 |

## 11. UI/UX review

**Visual.** The CSS-variable token system (light/dark), tabular-nums monospace for figures, and dense card language are strong and consistent — except `PlanTab.jsx`, which uses its own `T.*` palette and inline styles; migrate it to the shared tokens (Impact 5, Diff 3, 3d, P2). Charts: hand-rolled SVG on Home vs Recharts in Plan — visually inconsistent axes/tooltips; standardise on one (Impact 4, Diff 3, 3d, P3). Empty/zero states are thoughtfully handled (first-run panel is genuinely good).

**Accessibility.** Above-average baseline: skip link, aria-current nav, role=alert errors, focus management in the drawer, aria-labelled SVG chart. Gaps: gain/loss communicated by colour alone in many chips — add +/− signs (mostly present) *and* shape/weight cues; contrast is actually fine (muted-on-panel measures 5.8:1 light / 6.2:1 dark, AA-passing) — the real problem is the 10–11px type it's set in (Impact 6, Diff 2, 2d, P1 — see Typography); Recharts tooltips are mouse-only — add keyboard/table alternatives for key charts (Impact 5, Diff 4, 4d, P3); add `prefers-reduced-motion` guard on the refresh spinner (trivial).

**Typography.** System stack is fine and fast. Issues: 10–11px text is heavily used (below comfortable minimum — lift floors to 12px); establish a 4-step scale (12/14/16/20) instead of ad-hoc sizes; headline number deserves 36–40px with tighter tracking. Impact 5, Diff 2, 2d, P2.

**Colour system.** Semantic tokens (gain/loss/match-type) are well designed. Indigo accent is safe but undifferentiated — every fintech is indigo; consider a distinctive brand hue for the premium positioning. Verify the four match-type colours (`--m-same/--m-bb/--m-pool`) survive deuteranopia — amber/green pairs likely don't; add pattern/label redundancy in CGT tables. Impact 4, Diff 2, 2d, P3.

**Dark mode.** Implemented, defaults dark, print stylesheet resets to light (nice touch). Missing: `prefers-color-scheme` detection for first run (`useIsMobile.js` proves the matchMedia pattern exists — apply it to theme), and an "auto" third state. Impact 4, Diff 1, 0.5d, P1. Dark palette itself is good.

## 12. Premium features worth building

**Would pay for (ranked by willingness-to-pay):**

| Feature | Why it converts | Impact | Effort |
|---------|----------------|--------|--------|
| Encrypted sync + versioned cloud backup | Fear of data loss is the #1 objection to local-first; charge for peace of mind (Kubera charges $150/yr largely for this class of trust) | 10 | 15–25d |
| Tax-pack season: one-click SA108 + dividend/interest schedules + ERI summary per tax year, accountant-shareable | Saves a real accountant invoice; January urgency = conversion spike | 8 | 5d (80% exists) |
| Household/couples planning | Unlocks the largest UK tax savings; no consumer competitor does UK couples properly | 9 | 20d |
| Look-through X-ray + overlap | Kubera/Empower's most-cited premium feature | 9 | 15–20d |
| Drawdown tax-optimiser ("this ordering saves £47k lifetime tax") | Quantified value claim sells itself | 8 | 12d |
| Automated feeds (IBKR scheduled pulls, Open Banking cash) | Convenience tier | 7 | 10d+ |

**Competitive advantage (moat):** UK-exact CGT + allowances + IHT + MPAA in one place is the moat — deepen it (couples, optimiser, tax-pack) before broadening. Local-first privacy is a real differentiator vs Empower/Monarch data-harvesting — market it explicitly ("your ledger never leaves your device; sync is end-to-end encrypted"). The honest-data culture (unpriced flagged, unknown ≠ zero) is rare and should become visible product copy, not just code comments.

**Don't build:** budgeting/spend categorisation (Monarch's turf, zero synergy with the moat), crypto depth, US tax.

## 13. Technical architecture review

**Scalability.** Client-side compute is fine for the realistic ceiling (~10k transactions; S104 matching is roughly O(n log n)). Risks: every `txns` write rewrites the full array to localStorage + IndexedDB mirror + JSON.stringify on each change — at 10k txns that's multi-MB serialisation per keystroke-adjacent edit; debounce persistence and consider per-key dirty tracking (Impact 5, Diff 3, 2d, P2). The 5MB localStorage quota is a hard ceiling with prices+valuations+txns — IndexedDB should become *primary* with a small localStorage boot cache, not a mirror (Impact 6, Diff 5, 5d, P3). Recompute graph: `matchPortfolio` + `buildWealthModel` + `computeReturns` all re-run on any txn edit — memoisation is correct but consider moving matching into the existing worker if ledger edits ever feel laggy.

**Security.** (a) Secrets: AV key + IBKR token in plaintext localStorage, included in plaintext backups (the export tooltip admits it) — encrypt with WebCrypto under a user passphrase or exclude from backups by default; (b) IBKR token in GET query → Vercel logs; switch to POST body and add `Cache-Control: no-store`; (c) open proxies: add origin check + rate limiting (Vercel middleware) — you are one Reddit post away from a quota bill; (d) no CSP — add a strict one via `vercel.json` (no third-party scripts needed, so this is cheap); (e) XSS surface is low (React, no dangerouslySetInnerHTML observed). Combined: Impact 7, Diff 2–3, 3d, P1.

**Performance.** Lazy tab loading, worker MC, snapshot-diff persistence — already good. Wins: `xlsx` (SheetJS) is already dynamic-imported on demand — good; virtualise Ledger/Holdings tables past ~1k rows (Impact 4, Diff 3, 2d, P3); the shell recomputes `taxYearEnd`/`incomeCalendar` on every txn change even when the Home tab isn't visible — fine now, defer if profiling says so.

**Data model.** Improvements, in order: (1) add `fees`, `accountId`/provider to transactions (currently wrapper-only — two GIA brokers cannot be distinguished, which breaks per-account reporting and IBKR/manual coexistence) — Impact 7, Diff 4 (migration + backup v13), 5d, P1; (2) make valuation snapshots append-only events with an `estimated` flag rather than last-write-wins-per-day; (3) `secMeta` is becoming a grab-bag (kind, domicile, ERI, provider, ISIN) — formalise a securities master with per-field provenance ("user-entered" vs "seeded" vs "fetched"); (4) schema-version the whole persisted state once (single `version` key) instead of per-backup versioning only; (5) the backup format at v12 with per-field `if (Array.isArray(...))` restore is fragile — generate restore from `PERSIST_KEYS` + type map so a new key can't be forgotten (the durable mirror already solved this pattern; apply it to backups). Impact 6, Diff 3, 3d, P2.

**Testing.** Core engines: excellent. Zero component/UI tests — the god-component wiring in `CgtDashboard.jsx` (30+ props, prop-name coupling) is exactly where regressions will land; add a handful of Testing Library smoke tests per tab and one restore-roundtrip test (export → import → deep-equal). Impact 5, Diff 3, 4d, P2.

---

## 14. Phased roadmap

### Phase 1 — Quick wins (4–6 weeks, ~25 dev-days)

*Theme: stop the bleeding (data, secrets), make Home earn its place.*

1. Secrets hygiene + proxy hardening + CSP (3d) — P1
2. Daily full net-worth series (partial snapshots, estimated flags, cash/property included) + Home trend upgrade with benchmark overlay (7d) — P1
3. Home redesign: action queue, plan-health card on desktop, 90-day income strip, plumbing demoted (5d) — P1
4. Concentration + currency-exposure metrics; hand-tagged region/sector in secMeta as look-through v0 (4d) — P1
5. PWA manifest + auto dark mode + small-text contrast fixes (3d) — P1
6. Guaranteed-income floor view in Plan (3d) — P1

### Phase 2 — Major improvements (3–4 months, ~60 dev-days)

*Theme: from single-browser tool to durable product.*

1. **E2E-encrypted sync/backup** (passphrase key, blob store, conflict = last-writer with version history) (20d)
2. **Household mode** across Plan/CGT/allowances/IHT + bed & spouse (18d)
3. Look-through engine v1: factsheet ingestion, region/sector/currency, overlap matrix (15d)
4. IA consolidation to 9 screens + ⌘K palette + deep-linkable sub-tabs (10d)
5. Transactions: fees + accountId, backup v13, generated restore (5d)
6. Broker CSV profiles (HL, AJ Bell, ii, Vanguard, Fidelity UK) + mapping UI (6d)
7. MC upgrade (two-asset, stochastic inflation, bootstrap) (8d)
8. Store refactor (kill prop drilling), PlanTab token migration, component smoke tests (8d)

### Phase 3 — Advanced wealth platform (6–12 months)

*Theme: the UK planning moat nobody can copy quickly.*

1. Drawdown tax-optimiser with quantified lifetime-tax savings (12d)
2. Tax-pack season product (SA108+ schedules, accountant share links) (8d)
3. Asset-location optimiser (which asset in which wrapper) (8d)
4. Open Banking cash feeds + scheduled IBKR pulls (15d)
5. Sequence-risk heatmap over full historical windows; annuity market rates (8d)
6. Goals beyond retirement; named scenario library (8d)
7. IndexedDB-primary storage; table virtualisation (7d)
8. Premium packaging: free (tracking) / £X-per-year (sync, tax-pack, optimisers, feeds)

---

*Bottom line: the hardest 60% — the UK tax and retirement engines — is built and tested. What separates this from a product people would pay Kubera-level prices for is sync, look-through, couples, and a Home screen that leads with decisions instead of data plumbing. All four are tractable, and none requires weakening the local-first privacy stance that is this app's most marketable trait.*
