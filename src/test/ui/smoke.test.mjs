/* ======================================================================
   UI SMOKE TESTS — renderToString under node --test, via the esbuild JSX
   loader (src/test/setup/). Not behavioural tests: each one asserts a tab
   renders WITHOUT THROWING given realistic derived props + the store's
   node-safe defaults, and that a few landmark strings appear. This covers
   the one seam the 500 core tests can't: React wiring (props, store
   selectors, hook order) — exactly where the Phase 2.8 de-drilling and
   every future refactor would break things. renderToString runs no
   effects, so no fetches/workers fire.
   ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";

import { buildWealthModel } from "../../core/portfolio.mjs";
import { DesktopSidebar, SubTabBar, SCREENS, LEAF_LABELS, screenOf } from "../../ui/Sidebar.jsx";
import CommandPalette from "../../ui/CommandPalette.jsx";
import PlanHealthCard from "../../ui/PlanHealthCard.jsx";
import HomeTab from "../../features/HomeTab.jsx";
import HoldingsTab from "../../features/HoldingsTab.jsx";
import WealthTab from "../../features/WealthTab.jsx";
import GiltsTab from "../../features/GiltsTab.jsx";
import RsuTab from "../../features/RsuTab.jsx";
import SyncTab from "../../features/SyncTab.jsx";
import LedgerTab from "../../features/LedgerTab.jsx";
import PropertyTab from "../../features/PropertyTab.jsx";
import PrivateTab from "../../features/PrivateTab.jsx";
import PensionTab from "../../features/PensionTab.jsx";
import AllowancesTab from "../../features/AllowancesTab.jsx";
import ReturnsTab from "../../features/ReturnsTab.jsx";

// Minimal but real derived model — two priced holdings across wrappers.
const TXNS = [
  { id: "1", date: "2024-01-10", side: "BUY", ticker: "VWRL", wrapper: "ISA", quantity: 100, gbpAmount: 9000, nativeCurrency: "GBP" },
  { id: "2", date: "2024-02-10", side: "BUY", ticker: "WFC", wrapper: "GIA", quantity: 50, gbpAmount: 2000, nativeCurrency: "USD" },
];
const PRICES = { VWRL: 105, WFC: 55 };
const model = buildWealthModel({ txns: TXNS, prices: PRICES, secMeta: {}, cash: { GIA: 500 } });

test("sidebar renders all nine screens and every leaf has a label + screen", () => {
  // renderToString HTML-escapes text ("Pension & LISA" -> "&amp;"), so
  // decode the common entities before matching labels.
  const html = renderToString(React.createElement(DesktopSidebar, { tab: "home", setTab: () => {}, onOpenPalette: () => {} }))
    .replaceAll("&amp;", "&").replaceAll("&#x27;", "'");
  assert.equal(SCREENS.length, 9);
  for (const s of SCREENS) {
    assert.ok(html.includes(s.label), s.label);
    for (const leaf of s.leaves) {
      assert.ok(LEAF_LABELS[leaf], `label for ${leaf}`);
      assert.equal(screenOf(leaf).key, s.key);
    }
  }
  assert.ok(html.includes("⌘K"));
});

test("sub-tab bar renders siblings for multi-leaf screens, nothing for single", () => {
  const multi = renderToString(React.createElement(SubTabBar, { tab: "holdings", setTab: () => {} }))
    .replaceAll("&amp;", "&");
  assert.ok(multi.includes("Holdings"));
  assert.ok(multi.includes("Returns"));
  assert.ok(multi.includes("Gilts"));
  const single = renderToString(React.createElement(SubTabBar, { tab: "home", setTab: () => {} }));
  assert.equal(single, "");
});

test("command palette renders items when open, nothing when closed", () => {
  const closed = renderToString(React.createElement(CommandPalette, { open: false, onClose: () => {}, setTab: () => {} }));
  assert.equal(closed, "");
  const open = renderToString(React.createElement(CommandPalette, { open: true, onClose: () => {}, setTab: () => {}, tickers: ["VWRL"] }))
    .replaceAll("&amp;", "&");
  assert.ok(open.includes("Jump to a screen"));
  assert.ok(open.includes("Home")); // unfiltered top items include nav
});

test("HomeTab renders headline, queue and allocation from a real model", () => {
  const html = renderToString(React.createElement(HomeTab, {
    model, returns: null, netWorth: null, setTab: () => {},
    actionData: { isaSubscribed: 0, aeaLeft: 3000, harvestable: 0 },
    incomeCalendar: [], concentration: null,
  }));
  assert.ok(html.includes("Needs a decision"));
  assert.ok(html.includes("Allocation"));
  assert.ok(html.includes("Income · next 90 days"));
  assert.ok(html.includes("Plan health"));
});

test("HomeTab with a null model shows the ledger-error empty state, not a crash", () => {
  const html = renderToString(React.createElement(HomeTab, { model: null, setTab: () => {} }));
  assert.ok(html.includes("Transactions tab"));
});

test("Phase 3.7: HoldingsTab switches to windowed rendering past VIRTUALIZE_THRESHOLD rows without crashing", () => {
  // renderToString runs no effects, so useVirtualRows' scroll-driven
  // narrowing never fires here (jsdom-free harness, by design — see the
  // header comment) — this test exists to catch the windowed-rendering
  // JSX itself (spacer <tr>s, sticky headers, the "Showing X of Y" note)
  // throwing or mis-rendering when the row count crosses the threshold,
  // not to assert the DOM-narrowing behaviour (covered by
  // core/virtual-rows.test.mjs, which is pure and needs no DOM at all).
  //
  // LedgerTab isn't exercised the same way here: it reads `txns` from the
  // Zustand store rather than a prop, and React's useSyncExternalStore
  // freezes its server snapshot to whatever the store held at FIRST read —
  // a useAppStore.setState() call before renderToString is silently
  // invisible to the component (confirmed with a minimal repro against the
  // pre-existing `dark` field, unrelated to this change), so there's no way
  // to inject a >1000-row store state into a renderToString-based test.
  // HoldingsTab takes `positions` as a plain prop, which isn't subject to
  // that limitation, so it's the one exercised directly here; the two tabs
  // share the exact same useVirtualRows/VIRTUALIZE_THRESHOLD code path.
  const flatten = (html) => html.replaceAll("<!-- -->", "");
  const manyPositions = Array.from({ length: 1200 }, (_, i) => ({ ticker: `T${i}`, wrapper: "GIA", qty: 10, bookCost: 100 }));
  const holdingsHtml = flatten(renderToString(React.createElement(HoldingsTab, { positions: manyPositions })));
  assert.ok(holdingsHtml.includes("Showing 1200 of 1200 positions"));
  assert.ok(holdingsHtml.includes("T0") && holdingsHtml.includes("T1199"));
});

test("HoldingsTab renders positions with region/sector tag inputs", () => {
  const html = renderToString(React.createElement(HoldingsTab, { positions: model.positions }));
  assert.ok(html.includes("VWRL"));
  assert.ok(html.includes("Region"));
  assert.ok(html.includes("Sector"));
});

test("WealthTab renders totals and the exposure panel", () => {
  const html = renderToString(React.createElement(WealthTab, {
    model,
    concentration: { total: 12000, rows: [], top1: { ticker: "VWRL", weight: 0.8 }, top5Weight: 1, hhi: 0.68, effectiveN: 1.47, alerts: [] },
  }));
  assert.ok(html.includes("Total wealth"));
  assert.ok(html.includes("Allocation"));
  assert.ok(html.includes("Effective holdings"));
});

test("GiltsTab and RsuTab render their empty states from store defaults", () => {
  const gilts = renderToString(React.createElement(GiltsTab, { data: null }));
  assert.ok(gilts.length > 100);
  const rsu = renderToString(React.createElement(RsuTab));
  assert.ok(rsu.length > 100);
});

test("SyncTab renders the disabled state with both setup paths", () => {
  const html = renderToString(React.createElement(SyncTab)).replaceAll("&amp;", "&");
  assert.ok(html.includes("end-to-end encrypted"));
  assert.ok(html.includes("Create a new sync"));
  assert.ok(html.includes("Connect this device"));
  assert.ok(html.includes("no reset"));
});

test("de-drilled data tabs render from store defaults without props", () => {
  // These tabs now read raw state via store selectors (Phase 2.8) — the
  // exact wiring this suite exists to catch regressions in.
  for (const [name, el] of [
    ["Ledger", React.createElement(LedgerTab)],
    ["Property", React.createElement(PropertyTab)],
    ["Private", React.createElement(PrivateTab)],
    ["Pension", React.createElement(PensionTab, { recomputeProviderCost: () => {} })],
    ["Allowances", React.createElement(AllowancesTab, { eriTxns: [], taxableDisposals: [] })],
    ["Returns", React.createElement(ReturnsTab, { returns: null })],
  ]) {
    const html = renderToString(el);
    assert.ok(html.length > 50, `${name} rendered almost nothing`);
  }
});

test("PlanHealthCard renders the no-plan prompt and a real projection", () => {
  const none = renderToString(React.createElement(PlanHealthCard, { planInputs: null, onOpenPlan: () => {} }));
  assert.ok(none.includes("No retirement plan set up yet"));
});
