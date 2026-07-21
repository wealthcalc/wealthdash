import React, { useMemo } from "react";
import { HeartPulse } from "lucide-react";
import { buildProjection } from "../core/drawdown.mjs";
import { trackPlan } from "../core/plan-tracking.mjs";
import { gbp0, pctPlain, Stat, todayISO } from "./shared.jsx";

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
function PlanHealthCard({ planInputs, onOpenPlan, netWorthSnapshots = [] }) {
  const det = useMemo(() => {
    if (!planInputs) return null;
    try { return buildProjection(planInputs); } catch { return null; }
  }, [planInputs]);

  // "Am I on track?" — the projection vs what actually happened. Only the
  // INVESTABLE part of each snapshot is comparable: the projection models
  // pension + ISA + GIA + LISA, so including property equity would show a
  // permanent "ahead of plan" the size of the house (see
  // core/plan-tracking.mjs).
  //
  // The anchor is TODAY: `currentAge` in the plan means "now", so the
  // projection's age axis is pinned to today's date and past snapshots map
  // to younger ages. That means the comparison is against the plan AS IT
  // STANDS, not as it stood when each snapshot was taken — edit a
  // contribution and the whole history re-scores. Disclosed in the UI
  // rather than silently presented as a track record.
  const tracking = useMemo(() => {
    if (!det || !planInputs || !netWorthSnapshots.length) return null;
    try {
      return trackPlan({
        snapshots: netWorthSnapshots.map((s) => ({
          date: s.date,
          investable: (+s.invested || 0) + (+s.cash || 0),
        })),
        timeline: det.timeline,
        anchorDate: todayISO(),
        currentAge: planInputs.currentAge,
      });
    } catch { return null; }
  }, [det, planInputs, netWorthSnapshots]);

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

      {tracking && tracking.summary && (
        <div className="mt-3 pt-3 border-t border-[var(--border)]">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Actual vs plan</span>
            <span className={"text-sm font-semibold num " + (tracking.summary.onTrack ? "text-[var(--gain)]" : tracking.summary.ahead ? "text-[var(--gain)]" : "text-[var(--loss)]")}>
              {tracking.summary.latest.variancePct > 0 ? "+" : ""}{tracking.summary.latest.variancePct?.toFixed(1)}%
            </span>
          </div>
          <p className="text-xs text-[var(--muted)] mt-1 leading-relaxed">
            Investable wealth is <strong className="text-[var(--fg)]">{gbp0(tracking.summary.latest.actual)}</strong> against a projected{" "}
            <strong className="text-[var(--fg)]">{gbp0(tracking.summary.latest.projected)}</strong>
            {tracking.summary.onTrack ? " — on track (within 10%)." : tracking.summary.ahead ? " — comfortably ahead." : " — behind plan."}
            {tracking.summary.points > 2 && tracking.summary.trendPct != null && Math.abs(tracking.summary.trendPct) >= 1 && (
              <> The gap has {tracking.summary.trendPct > 0 ? "narrowed" : "widened"} by {Math.abs(tracking.summary.trendPct).toFixed(1)}pp over {tracking.summary.yearsTracked < 1 ? `${tracking.summary.spanDays} days` : `${tracking.summary.yearsTracked.toFixed(1)} years`}.</>
            )}
          </p>
          <p className="text-[11px] text-[var(--muted)] mt-1 leading-relaxed">
            Compares pension + ISA + GIA + LISA only — property and other assets aren't in the projection. Scored against the plan as it stands today, so editing assumptions re-scores the whole history.
          </p>
        </div>
      )}
    </div>
  );
}

export default PlanHealthCard;
