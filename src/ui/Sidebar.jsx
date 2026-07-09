/* Five-section sidebar IA — replaces the old flat, wrapping 12-button tab
   row. With Plan and Allowances added on top of the original build, a single
   row no longer scaled: it wrapped to 2-3 lines on anything narrower than a
   wide desktop, and gave no structure to help a user find a tab by what it's
   for. Grouped by purpose, not alphabetically: orientation, the portfolio
   itself, wrapper-specific instruments with their own mechanics (gilts have
   coupons/AIS, pensions have provider snapshots), tax tools, then raw data
   in/out. Desktop gets a static, sticky column; mobile gets an overlay
   drawer so narrow screens don't lose vertical space to a permanent rail. */
import React, { useEffect, useRef } from "react";
import {
  Wallet, PoundSterling, PieChart, Percent, Landmark, PiggyBank, TrendingUp, Gauge, Target,
  TableProperties, Receipt, FileUp, X, Home, Building2,
} from "lucide-react";

export const NAV_SECTIONS = [
  { title: "Overview", items: [
    ["home", "Home", TrendingUp],
    ["plan", "Plan", Gauge],
  ] },
  { title: "Portfolio", items: [
    ["wealth", "Wealth", PieChart],
    ["holdings", "Holdings", Wallet],
    ["returns", "Returns", Percent],
    ["property", "Property", Home],
    ["private", "Private", Building2],
  ] },
  { title: "Instruments", items: [
    ["gilts", "Gilts", Landmark],
    ["pension", "Pension & LISA", PiggyBank],
  ] },
  { title: "Tax", items: [
    ["cgt", "CGT", TableProperties],
    ["allowances", "Allowances", Target],
    ["income", "Income", PoundSterling],
  ] },
  { title: "Data", items: [
    ["ledger", "Transactions", Receipt],
    ["import", "Import CSV", FileUp],
  ] },
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

function NavSections({ tab, onSelect }) {
  return (
    <div className="px-2 py-3 space-y-4">
      {NAV_SECTIONS.map((sec) => (
        <div key={sec.title}>
          <div className="px-2.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] mb-1">{sec.title}</div>
          <div className="space-y-0.5">
            {sec.items.map(([k, label, Icon]) => (
              <NavButton key={k} label={label} Icon={Icon} active={tab === k} onClick={() => onSelect(k)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Desktop (sm+): a static column, sticky within the viewport so it stays put
// while a long tab (e.g. Transactions) scrolls underneath it.
export function DesktopSidebar({ tab, setTab }) {
  return (
    <aside className="hidden sm:flex sm:flex-col w-56 shrink-0 border-r border-[var(--border)] bg-[var(--panel)] sticky top-0 h-screen overflow-y-auto">
      <div className="px-4 py-4 flex items-center gap-2 border-b border-[var(--border)]">
        <Receipt size={18} className="text-[var(--accent)]" aria-hidden="true" />
        <span className="font-semibold text-sm truncate">Wealth Dashboard</span>
      </div>
      <nav aria-label="Main navigation"><NavSections tab={tab} onSelect={setTab} /></nav>
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
export function MobileDrawer({ tab, setTab, open, onClose }) {
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
        <nav aria-label="Main navigation"><NavSections tab={tab} onSelect={(k) => { setTab(k); onClose(); }} /></nav>
      </div>
    </div>
  );
}
