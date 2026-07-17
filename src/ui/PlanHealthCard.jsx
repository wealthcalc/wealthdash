import React, { useMemo } from "react";
import { HeartPulse } from "lucide-react";
import { buildProjection } from "../core/drawdown.mjs";
import { gbp0, pctPlain, Stat } from "./shared.jsx";

/* ======================================================================
   PLAN HEALTH CARD — a compact, read-only retirement headline for the
   mobile summary layer (CgtDashboard.jsx). Reuses `buildProjection()`
   (core/drawdown.mjs) directly rather than duplicating any projection
   logic — this is the exact same deterministic engine the Plan tab's
   Overview sub-tab runs, just condensed to 4 numbers and no charts. It
   intentionally does NOT run Monte Carlo (that needs the Web Worker, and
   a phone check-in should be instant, not a spinner) — the deterministic
   result alone is enough for "is my plan roughly on track".
   ====================================================================== */
function PlanHealthCard({ planInputs, onOpenPlan }) {
  const det = useMemo(() => {
    if (!planInputs) return null;
    try { return buildProjection(planInputs); } catch { return null; }
  }, [planInputs]);

  if (!planInputs || !det || !Number.isFinite(det.wealthAtRetire)) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="text-sm font-semibold flex items-center gap-1.5"><HeartPulse size={15} className="text-[var(--accent)]" /> Plan health</div>
        <p className="text-xs text-[var(--muted)] mt-1.5 leading-relaxed">
          No retirement plan set up yet.{" "}
          <button onClick={onOpenPlan} className="text-[var(--accent)] underline underline-offset-2">Open the Plan tab</button> to build one — it works from assumptions alone, no real data required to start.
        </p>
      </div>
    );
  }

  const lasts = det.depletionAge === null;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-sm font-semibold flex items-center gap-1.5"><HeartPulse size={15} className="text-[var(--accent)]" /> Plan health</div>
        <button onClick={onOpenPlan} className="text-xs text-[var(--accent)] underline underline-offset-2 shrink-0">Full plan →</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label={`Pot at retirement (age ${planInputs.retireAge})`} value={gbp0(det.wealthAtRetire)} />
        <Stat label="Money lasts to" value={lasts ? `${planInputs.planAge}+` : `age ${det.depletionAge}`} tone={lasts ? "gain" : "loss"} />
        <Stat label="Year-1 net income (today's £)" value={gbp0(det.firstYearNetToday)} />
        <Stat label="Replaces of pre-retirement net pay" value={pctPlain(det.replacementNet, 0)} />
      </div>
    </div>
  );
}

export default PlanHealthCard;
