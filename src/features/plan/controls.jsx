/* Plan tab UI atoms — Card, Stat, Field, Segmented, Toggle, PanelSection,
   Legendlet, Note, Barline, Row. Extracted verbatim from PlanTab.jsx during
   the file split; no behaviour change. They're shared by every Plan sub-tab,
   which is exactly why they now live in one importable place. */
import React, { useState } from "react";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { T, MONO, SANS, gbp } from "./theme.js";
import { store } from "../../ui/shared.jsx";

function Card({ children, style }) {
  return (
    <div
      style={{
        background: T.surface,
        border: `1px solid ${T.line}`,
        borderRadius: 14,
        padding: 18,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ label, value, sub, tone = "ink", big }) {
  const color =
    tone === "green" ? T.green : tone === "red" ? T.red : tone === "amber" ? T.amber : T.ink;
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: T.muted,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: MONO,
          fontSize: big ? 30 : 22,
          fontWeight: 600,
          color,
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.1,
          marginTop: 4,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: T.ink2, marginTop: 3 }}>{sub}</div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, min, max, step = 1, prefix, suffix, hint }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12.5, color: T.ink2, fontWeight: 600 }}>{label}</span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 13,
            color: T.ink,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {prefix}
          {typeof value === "number" ? value.toLocaleString("en-GB") : value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        // The visible label and the value sit in sibling spans, so the
        // implicit <label> association produces a muddled name; state it.
        // aria-valuetext carries the UNIT — a screen reader otherwise reads
        // "6" for both "6%" growth and "£6", which are not the same thing.
        aria-label={label}
        aria-valuetext={`${prefix || ""}${typeof value === "number" ? value.toLocaleString("en-GB") : value}${suffix || ""}`}
        style={{ width: "100%", accentColor: T.green, cursor: "pointer" }}
      />
      {hint && (
        <div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>{hint}</div>
      )}
    </label>
  );
}

function Segmented({ options, value, onChange, accent = T.ink, ariaLabel }) {
  // Radiogroup semantics + arrow-key traversal with a roving tabindex, so a
  // keyboard user tabs into the group once rather than through every option.
  // (Matches SegmentedControl in ui/shared.jsx; this one keeps the Plan tab's
  // own inline-style look.)
  const onKey = (e) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir || !options.length) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    onChange(options[(i + dir + options.length) % options.length].value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKey}
      style={{
        display: "inline-flex",
        background: T.lineSoft,
        borderRadius: 10,
        padding: 3,
        gap: 2,
        flexWrap: "wrap",
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            style={{
              border: "none",
              cursor: "pointer",
              borderRadius: 8,
              padding: "7px 13px",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: SANS,
              background: active ? T.surface : "transparent",
              color: active ? accent : T.muted,
              boxShadow: active ? "0 1px 2px rgba(0,0,0,.08)" : "none",
              transition: "all .15s",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  // A <button> inside a <label> gets no implicit association, so this used to
  // announce as an unnamed, stateless button. role="switch" + aria-checked +
  // an explicit name fixes both halves.
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 14,
      }}
    >
      <span style={{ fontSize: 12.5, color: T.ink2, fontWeight: 600 }}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={!!checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        style={{
          width: 42,
          height: 24,
          borderRadius: 12,
          border: "none",
          cursor: "pointer",
          background: checked ? T.green : T.line,
          position: "relative",
          transition: "background .15s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: checked ? 21 : 3,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#fff",
            transition: "left .15s",
            boxShadow: "0 1px 2px rgba(0,0,0,.2)",
          }}
        />
      </button>
    </div>
  );
}


const PANEL_OPEN_DEFAULT = new Set(["Scenario library", "You & timing", "Money in"]);

function PanelSection({ title, children }) {
  const [open, setOpen] = useState(() => store.get(`plan.panel.${title}`, PANEL_OPEN_DEFAULT.has(title)));
  React.useEffect(() => { store.set(`plan.panel.${title}`, open); }, [open, title]);
  return (
    <div style={{ marginBottom: open ? 22 : 10 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", background: "none", border: "none", cursor: "pointer",
          padding: "0 0 6px", marginBottom: open ? 12 : 0,
          fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase",
          color: T.gold, fontWeight: 700, textAlign: "left",
          borderBottom: `1px solid ${T.lineSoft}`,
        }}
      >
        <span>{title}</span>
        <span aria-hidden="true" style={{ color: T.muted, fontSize: 10 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && children}
    </div>
  );
}

function Legendlet({ items }) {
  return (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 10 }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: T.ink2 }}>
          <span style={{ width: 16, height: 0, borderTop: `${it.dash ? "2px dashed" : "3px solid"} ${it.c}` }} />
          {it.t}
        </div>
      ))}
    </div>
  );
}

function Note({ children, tone = "amber" }) {
  const c = tone === "amber" ? T.amber : tone === "red" ? T.red : T.blue;
  const bg = tone === "amber" ? T.amberSoft : tone === "red" ? T.redSoft : T.blueSoft;
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        background: bg,
        border: `1px solid ${c}33`,
        borderRadius: 11,
        padding: "12px 15px",
        marginTop: 14,
        fontSize: 13,
        color: T.ink2,
        lineHeight: 1.5,
      }}
    >
      <Info size={16} color={c} style={{ flexShrink: 0, marginTop: 1 }} />
      <div>{children}</div>
    </div>
  );
}

/* ---- Accumulation tab ---- */

function Barline({ label, value, total, color }) {
  const w = Math.max(0, Math.min(100, (value / total) * 100));
  return (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
        <span style={{ color: T.ink2 }}>{label}</span>
        <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{gbp(value)}</span>
      </div>
      <div style={{ height: 7, background: T.lineSoft, borderRadius: 4 }}>
        <div style={{ width: w + "%", height: "100%", background: color, borderRadius: 4 }} />
      </div>
    </div>
  );
}
// tiny labelled row
function Row({ l, v, neg, bold }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
      <span style={{ color: bold ? T.ink : T.ink2, fontWeight: bold ? 700 : 400 }}>{l}</span>
      <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: neg ? T.red : T.ink, fontWeight: bold ? 700 : 500 }}>{v}</span>
    </div>
  );
}


export { Card, Stat, Field, Segmented, Toggle, PANEL_OPEN_DEFAULT, PanelSection, Legendlet, Note, Barline, Row };
