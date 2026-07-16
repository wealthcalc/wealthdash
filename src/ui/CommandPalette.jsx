/* ======================================================================
   COMMAND PALETTE (⌘K / Ctrl+K) — jump anywhere by typing: screens,
   sub-tabs, the deeper tools that used to be undiscoverable (Bed & ISA,
   Rebalance, Income floor, Monte Carlo…), and open holdings by ticker.
   Navigation-only by design in v1 — no mutating actions in a fuzzy-matched
   list where Enter fires on the top hit.

   Deliberately dependency-free (no cmdk etc.): a filtered list with
   arrow-key selection is ~100 lines, and this app avoids new runtime
   dependencies unless they earn their keep. Sub-tab jumps use the same
   localStorage-before-setTab trick the Home action queue established —
   CgtSection/PlanTab read their sub-tab key in a useState initialiser and
   remount on tab switch, so writing the key first lands the user on the
   right inner tab.
   ====================================================================== */
import React, { useState, useEffect, useMemo, useRef } from "react";
import { Search, CornerDownLeft } from "lucide-react";
import { SCREENS, LEAF_LABELS } from "./Sidebar.jsx";
import { store } from "./shared.jsx";

// Inner tools reachable one level below a leaf tab.
const TOOL_ITEMS = [
  { label: "CGT · Harvesting planner", leaf: "cgt", subKey: "cgt.cgtsubtab", subVal: "planning", hint: "sell within the allowance" },
  { label: "CGT · Bed & ISA", leaf: "cgt", subKey: "cgt.cgtsubtab", subVal: "bedisa", hint: "move gains into shelter" },
  { label: "CGT · Rebalance", leaf: "cgt", subKey: "cgt.cgtsubtab", subVal: "rebalance", hint: "tax-aware drift fix" },
  { label: "CGT · Asset location", leaf: "cgt", subKey: "cgt.cgtsubtab", subVal: "location", hint: "which asset in which wrapper" },
  { label: "CGT · Report (SA108)", leaf: "cgt", subKey: "cgt.cgtsubtab", subVal: "report", hint: "tax return pack" },
  { label: "CGT · What-if", leaf: "cgt", subKey: "cgt.cgtsubtab", subVal: "whatif", hint: "model a sale" },
  { label: "Plan · Income floor", leaf: "plan", subKey: "plan.subtab", subVal: "floor", hint: "guaranteed income vs essentials" },
  { label: "Plan · Run-off", leaf: "plan", subKey: "plan.subtab", subVal: "runoff", hint: "when does the selling start?" },
  { label: "Plan · Monte Carlo", leaf: "plan", subKey: "plan.subtab", subVal: "adequacy", hint: "success probability" },
  { label: "Plan · Inheritance tax", leaf: "plan", subKey: "plan.subtab", subVal: "iht", hint: "estate projection" },
  { label: "Plan · Sequencing", leaf: "plan", subKey: "plan.subtab", subVal: "drawdown", hint: "withdrawal order" },
  { label: "Plan · Buy-to-let", leaf: "plan", subKey: "plan.subtab", subVal: "btl", hint: "rental modelling" },
];

export default function CommandPalette({ open, onClose, setTab, tickers = [] }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  const items = useMemo(() => {
    const nav = [];
    for (const s of SCREENS) {
      for (const leaf of s.leaves) {
        nav.push({
          label: s.leaves.length > 1 ? `${s.label} · ${LEAF_LABELS[leaf]}` : s.label,
          hint: "go to", leaf,
        });
      }
    }
    const tools = TOOL_ITEMS;
    const holds = tickers.map((tk) => ({ label: tk, hint: "holding — open Portfolio", leaf: "holdings" }));
    return [...nav, ...tools, ...holds];
  }, [tickers]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items.slice(0, 12);
    // Simple subsequence-ish match: every space-separated term must appear.
    const terms = needle.split(/\s+/);
    return items
      .filter((it) => terms.every((t) => (it.label + " " + (it.hint || "")).toLowerCase().includes(t)))
      .slice(0, 12);
  }, [items, q]);

  useEffect(() => { setSel(0); }, [q]);

  if (!open) return null;

  const go = (item) => {
    if (!item) return;
    if (item.subKey) store.set(item.subKey, item.subVal);
    setTab(item.leaf);
    onClose();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(filtered.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); go(filtered[sel]); }
  };

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="absolute left-1/2 top-24 -translate-x-1/2 w-[min(560px,92vw)] rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 border-b border-[var(--border)]">
          <Search size={15} className="text-[var(--muted)] shrink-0" aria-hidden="true" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Jump to a screen, tool, or holding…"
            aria-label="Search screens, tools and holdings"
            className="w-full bg-transparent text-sm py-3 outline-none text-[var(--fg)] placeholder:text-[var(--muted)]" />
        </div>
        <div role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 && <div className="px-4 py-6 text-sm text-[var(--muted)] text-center">Nothing matches "{q}".</div>}
          {filtered.map((it, i) => (
            <button key={it.label + i} role="option" aria-selected={i === sel}
              onMouseEnter={() => setSel(i)} onClick={() => go(it)}
              className={"w-full flex items-center gap-2 px-4 py-2 text-sm text-left " +
                (i === sel ? "bg-[var(--panel2)] text-[var(--fg)]" : "text-[var(--muted)]")}>
              <span className="truncate text-[var(--fg)]">{it.label}</span>
              {it.hint && <span className="text-xs text-[var(--muted)] truncate">— {it.hint}</span>}
              {i === sel && <CornerDownLeft size={13} className="ml-auto shrink-0 text-[var(--muted)]" aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
