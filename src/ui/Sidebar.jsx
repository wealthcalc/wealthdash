/* Phase 2.4 IA: 15 flat tabs consolidated into 9 SCREENS, organised by the
   question being asked ("what am I worth" / "how am I invested" / "what do
   I owe HMRC"), not by feature accretion. Crucially this is a PRESENTATION
   regrouping only: the app's tab state still holds the same LEAF keys it
   always has ("wealth", "cgt", "import", …), so every setTab() deep-link —
   action queue items, first-run panel, tax-year-end banner — keeps working
   unchanged. A screen with multiple leaves gets a sub-tab bar in the
   content area (rendered by the shell); the sidebar highlights whichever
   screen CONTAINS the active leaf. Deep links: #/<leaf>(/<subtab>) — see
   CgtDashboard's hash sync. */
import React, { useEffect, useRef } from "react";
import {
  Wallet, PoundSterling, PieChart, PiggyBank, TrendingUp, Gauge,
  TableProperties, Receipt, X, Building2, Database, Search,
} from "lucide-react";

// screen key -> { label, icon, leaves: [leaf tab keys] }. Leaf order = sub-tab order.
export const SCREENS = [
  { key: "home", label: "Home", icon: TrendingUp, leaves: ["home"] },
  { key: "plan", label: "Plan", icon: Gauge, leaves: ["plan"] },
  { key: "networth", label: "Net worth", icon: PieChart, leaves: ["wealth", "property"] },
  { key: "portfolio", label: "Portfolio", icon: Wallet, leaves: ["holdings", "returns", "gilts"] },
  { key: "income", label: "Income", icon: PoundSterling, leaves: ["income"] },
  { key: "pension", label: "Pensions", icon: PiggyBank, leaves: ["pension"] },
  { key: "other", label: "Other assets", icon: Building2, leaves: ["private", "rsu", "deferredcash"] },
  { key: "tax", label: "Tax", icon: TableProperties, leaves: ["cgt", "allowances"] },
  { key: "data", label: "Data", icon: Database, leaves: ["ledger", "import", "sync"] },
];

// Leaf labels as shown in the sub-tab bar and the command palette.
export const LEAF_LABELS = {
  home: "Home", plan: "Plan",
  wealth: "Balance sheet", property: "Property & debts",
  holdings: "Holdings", returns: "Returns", gilts: "Gilts",
  income: "Income", pension: "Pension & LISA",
  private: "Private investments", rsu: "RSUs", deferredcash: "Deferred cash",
  cgt: "Capital gains", allowances: "Allowances",
  ledger: "Transactions", import: "Import", sync: "Backup & sync",
};

export const screenOf = (leaf) => SCREENS.find((s) => s.leaves.includes(leaf)) || SCREENS[0];

// Light grouping — three clusters keep the scan short without pretending
// nine items need a taxonomy.
const SECTIONS = [
  { title: "Overview", screens: ["home", "plan"] },
  { title: "Wealth", screens: ["networth", "portfolio", "income", "pension", "other"] },
  { title: "Tax & data", screens: ["tax", "data"] },
];

function NavButton({ label, Icon, active, onClick }) {
  return (
    <button onClick={onClick} aria-current={active ? "page" : undefined}
      className={"w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm font-medium transition text-left " +
        (active ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "text-[var(--muted)] hover:bg-[var(--panel2)] hover:text-[var(--fg)]")}>
      <Icon size={15} className="shrink-0" aria-hidden="true" /> <span className="truncate">{label}</span>
    </button>
  );
}

function NavSections({ tab, onSelect, onOpenPalette }) {
  const activeScreen = screenOf(tab).key;
  return (
    <div className="px-2 py-3 space-y-4">
      {onOpenPalette && (
        <button onClick={onOpenPalette}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:bg-[var(--panel2)]"
          title="Jump anywhere — screens, tools, holdings">
          <Search size={14} aria-hidden="true" /> <span className="truncate">Search…</span>
          <kbd className="ml-auto text-[11px] px-1 py-0.5 rounded border border-[var(--border)] text-[var(--muted)] hidden sm:inline">⌘K</kbd>
        </button>
      )}
      {SECTIONS.map((sec) => (
        <div key={sec.title}>
          <div className="px-2.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)] mb-1">{sec.title}</div>
          <div className="space-y-0.5">
            {sec.screens.map((k) => {
              const s = SCREENS.find((x) => x.key === k);
              return (
                <NavButton key={s.key} label={s.label} Icon={s.icon} active={activeScreen === s.key}
                  onClick={() => onSelect(s.leaves[0])} />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// Desktop (sm+): a static column, sticky within the viewport so it stays put
// while a long tab (e.g. Transactions) scrolls underneath it.
export function DesktopSidebar({ tab, setTab, onOpenPalette }) {
  return (
    <aside className="hidden sm:flex sm:flex-col w-56 shrink-0 border-r border-[var(--border)] bg-[var(--panel)] sticky top-0 h-screen overflow-y-auto">
      <div className="px-4 py-4 flex items-center gap-2 border-b border-[var(--border)]">
        <Receipt size={18} className="text-[var(--accent)]" aria-hidden="true" />
        <span className="font-semibold text-sm truncate">Wealth Dashboard</span>
      </div>
      <nav aria-label="Main navigation"><NavSections tab={tab} onSelect={setTab} onOpenPalette={onOpenPalette} /></nav>
    </aside>
  );
}

// Mobile (<sm): an overlay drawer, only mounted while open. A plain
// conditional render is simpler and more robust than a permanently-mounted,
// CSS-transform toggle, and a drawer this size doesn't need enter/exit
// animation to feel responsive. Escape closes it and focus moves to the
// close button on open (and back to the menu-opening button on close, via
// the caller keeping a ref) — a minimal, real focus/keyboard story rather
// than relying on the backdrop click alone.
export function MobileDrawer({ tab, setTab, open, onClose, onOpenPalette }) {
  const closeRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 sm:hidden">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="Navigation menu"
        className="absolute inset-y-0 left-0 w-64 bg-[var(--panel)] border-r border-[var(--border)] overflow-y-auto shadow-xl">
        <div className="px-4 py-4 flex items-center gap-2 border-b border-[var(--border)]">
          <Receipt size={18} className="text-[var(--accent)]" aria-hidden="true" />
          <span className="font-semibold text-sm truncate">Wealth Dashboard</span>
          <button ref={closeRef} className="ml-auto text-[var(--muted)]" onClick={onClose} aria-label="Close menu"><X size={18} aria-hidden="true" /></button>
        </div>
        {/* The palette was keyboard-only (⌘K) + a desktop-sidebar button —
            a dead end on touch. The drawer closes first so the palette
            isn't stacked under the drawer's own overlay. */}
        <nav aria-label="Main navigation">
          <NavSections tab={tab} onSelect={(k) => { setTab(k); onClose(); }}
            onOpenPalette={onOpenPalette ? () => { onClose(); onOpenPalette(); } : undefined} />
        </nav>
      </div>
    </div>
  );
}

// Sub-tab bar for screens with more than one leaf — rendered by the shell
// above the active tab's content. Same pill language as CgtSection's
// internal sub-tabs so it reads as one pattern.
export function SubTabBar({ tab, setTab }) {
  const screen = screenOf(tab);
  if (screen.leaves.length < 2) return null;
  return (
    <div className="flex gap-1 mb-4 border-b border-[var(--border)] pb-2 flex-wrap" role="tablist" aria-label={`${screen.label} sections`}>
      {screen.leaves.map((leaf) => (
        <button key={leaf} role="tab" aria-selected={tab === leaf} onClick={() => setTab(leaf)}
          className={"px-3 py-1.5 rounded-lg text-sm font-medium " +
            (tab === leaf ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "text-[var(--muted)] hover:bg-[var(--panel2)] hover:text-[var(--fg)]")}>
          {LEAF_LABELS[leaf] || leaf}
        </button>
      ))}
    </div>
  );
}
