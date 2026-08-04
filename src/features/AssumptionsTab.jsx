/* ======================================================================
   ASSUMPTIONS — every estimate the dashboard makes on your behalf, what it
   drives, and whether you've changed it. Renders straight off the registry
   in core/assumptions.mjs, so adding an assumption there makes it appear
   here automatically.

   Two classes of row, deliberately different:
   - Registry-owned: editable inline, stored sparsely in `assumptionOverrides`.
     Only what you actually change is stored, so improving a default later
     doesn't silently overwrite a real choice.
   - Plan-owned: shown READ-ONLY with a jump to the Plan tab. Two editors
     writing one number is how figures start disagreeing between tabs.
   ====================================================================== */
import React, { useMemo, useState } from "react";
import { SlidersHorizontal, RotateCcw, ArrowRight } from "lucide-react";
import {
  ASSUMPTIONS, ASSUMPTION_GROUPS, resolveAssumptions, coerceAssumption,
  isOverridden, overriddenCount,
} from "../core/assumptions.mjs";
import { Empty } from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";

export default function AssumptionsTab({ setTab }) {
  const overrides = useAppStore((s) => s.assumptionOverrides) || {};
  const setOverrides = useAppStore((s) => s.setAssumptionOverrides);
  const planInputs = useAppStore((s) => s.planInputs) || {};
  const [onlyChanged, setOnlyChanged] = useState(false);

  const resolved = useMemo(() => resolveAssumptions(overrides, planInputs), [overrides, planInputs]);
  const changed = overriddenCount(overrides);

  const setOne = (id, raw) => setOverrides((cur) => ({ ...(cur || {}), [id]: coerceAssumption(id, raw) }));
  const resetOne = (id) => setOverrides((cur) => {
    const next = { ...(cur || {}) };
    delete next[id];
    return next;
  });
  const resetAll = () => setOverrides({});

  const groups = useMemo(() => ASSUMPTION_GROUPS.map((g) => ({
    group: g,
    rows: ASSUMPTIONS.filter((a) => a.group === g && (!onlyChanged || isOverridden(a.id, overrides))),
  })).filter((g) => g.rows.length), [onlyChanged, overrides]);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel2)] text-[var(--muted)]">
        <SlidersHorizontal size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
        <span>
          Wherever the app can't know something, it estimates — and every estimate it makes is listed here with what it affects. Change any of them and the figures downstream move with it. Real data always wins: a holding with actual payment history uses its own yield, and a gilt with a known coupon uses that, regardless of what's set here.
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm">
          <strong>{changed}</strong> <span className="text-[var(--muted)]">of {ASSUMPTIONS.filter((a) => a.home === "assumptions").length} editable assumptions changed from default</span>
        </div>
        <div className="ml-auto flex gap-2">
          <label className="flex items-center gap-1.5 text-xs text-[var(--muted)] cursor-pointer">
            <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} className="accent-[var(--accent)]" />
            Only show changed
          </label>
          {changed > 0 && (
            <button onClick={resetAll}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 h-8 rounded-lg border border-[var(--border)] hover:bg-[var(--panel2)]">
              <RotateCcw size={13} aria-hidden="true" /> Reset all
            </button>
          )}
        </div>
      </div>

      {!groups.length && <Empty msg="No assumptions changed from their defaults." />}

      {groups.map(({ group, rows }) => (
        <div key={group} className="space-y-2">
          <h3 className="text-sm font-semibold">{group}</h3>
          <div className="rounded-xl border border-[var(--border)] divide-y divide-[var(--border)] bg-[var(--panel)]">
            {rows.map((a) => {
              const over = isOverridden(a.id, overrides);
              const value = resolved[a.id];
              const planOwned = a.home === "plan";
              return (
                <div key={a.id} className="p-3 flex flex-col sm:flex-row sm:items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                      {a.label}
                      {over && <span className="text-[10px] px-1.5 py-0.5 rounded-md" style={{ background: "color-mix(in srgb, var(--accent) 18%, transparent)", color: "var(--accent)" }}>changed</span>}
                      {planOwned && <span className="text-[10px] px-1.5 py-0.5 rounded-md border border-[var(--border)] text-[var(--muted)]">set in Plan</span>}
                    </div>
                    <div className="text-xs text-[var(--muted)] mt-0.5">
                      Drives: {a.drives.join(" · ")}
                    </div>
                    {a.note && <div className="text-xs text-[var(--muted)] mt-1 italic">{a.note}</div>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {planOwned ? (
                      <>
                        <span className="num text-sm font-medium tabular-nums">{value}{a.unit === "%" ? "%" : ""}</span>
                        {setTab && (
                          <button onClick={() => setTab("plan")}
                            className="inline-flex items-center gap-1 text-xs px-2 h-8 rounded-lg border border-[var(--border)] hover:bg-[var(--panel2)] text-[var(--muted)] hover:text-[var(--fg)]">
                            Edit in Plan <ArrowRight size={12} aria-hidden="true" />
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        {a.kind === "text" ? (
                          <input type="text" value={value} onChange={(e) => setOne(a.id, e.target.value)}
                            aria-label={a.label} className="input w-32 text-sm py-1" />
                        ) : (
                          <div className="flex items-center gap-1">
                            <input type="number" value={value} min={a.min} max={a.max} step={a.step}
                              onChange={(e) => setOne(a.id, e.target.value)}
                              aria-label={a.label} className="input num w-24 text-right text-sm py-1" />
                            <span className="text-xs text-[var(--muted)] w-3">{a.unit === "%" ? "%" : a.unit === "×" ? "×" : ""}</span>
                          </div>
                        )}
                        <button onClick={() => resetOne(a.id)} disabled={!over}
                          title={over ? `Reset to ${a.def}` : "Already the default"}
                          className={"inline-flex items-center justify-center w-8 h-8 rounded-lg border border-[var(--border)] " + (over ? "hover:bg-[var(--panel2)] text-[var(--muted)] hover:text-[var(--fg)]" : "opacity-30 cursor-not-allowed")}>
                          <RotateCcw size={13} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <p className="text-xs text-[var(--muted)] leading-relaxed">
        Defaults are deliberately round numbers, not forecasts — they exist so a figure can be shown at all, and they're all reversible. Changes save automatically and travel in your backup. None of this is tax or investment advice.
      </p>
    </div>
  );
}
