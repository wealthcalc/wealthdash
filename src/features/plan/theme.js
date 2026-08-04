/* Plan tab design tokens + formatters. Extracted from PlanTab.jsx when it
   passed 2,900 lines; behaviour is unchanged — these are the same tokens the
   tab's inline styles have always used, now importable by the split-out
   sub-tab modules instead of being file-local. See the mapping note below for
   why `T.*` indirects onto the app's own CSS variables. */
/* ------------------------------------------------------------------ */
/*  Design tokens — Phase 2.8: mapped onto the APP's CSS variables      */
/*  (CgtDashboard.jsx's .root / .dark .root palette) instead of a        */
/*  second, private light/dark palette that had to be kept in sync by    */
/*  hand. The `T.*` indirection every inline style here uses is          */
/*  unchanged — only what the tokens RESOLVE to moved — so this is a     */
/*  mapping table, not a 2,000-line restyle. Soft ("Soft") backgrounds   */
/*  derive via color-mix (already used throughout the app shell), and    */
/*  since the app vars flip with the .dark class, one mapping serves     */
/*  both themes — the [data-theme] attribute and THEME_CSS remain only   */
/*  so the chart-specific extras (ink2/gold) can keep per-theme values   */
/*  with the same mechanism as before.                                  */
/* ------------------------------------------------------------------ */
const SHARED_TOKENS = {
  paper: "var(--bg)",
  surface: "var(--panel)",
  ink: "var(--fg)",
  muted: "var(--muted)",
  line: "var(--border)",
  lineSoft: "color-mix(in srgb, var(--border) 55%, transparent)",
  green: "var(--gain)",
  greenSoft: "color-mix(in srgb, var(--gain) 14%, transparent)",
  blue: "var(--m-same)",
  blueSoft: "color-mix(in srgb, var(--m-same) 13%, transparent)",
  amber: "var(--m-bb)",
  amberSoft: "color-mix(in srgb, var(--m-bb) 14%, transparent)",
  red: "var(--loss)",
  redSoft: "color-mix(in srgb, var(--loss) 13%, transparent)",
  // secondary ink: between fg and muted — no app token exists for this
  ink2: "color-mix(in srgb, var(--fg) 70%, var(--muted))",
};
// Chart-only colours with no app-palette equivalent keep per-theme values.
const LIGHT = { ...SHARED_TOKENS, gold: "#8F7327" };
const DARK = { ...SHARED_TOKENS, gold: "#C6A24E" };
const T = Object.fromEntries(Object.keys(LIGHT).map((k) => [k, `var(--t-${k})`]));
const themeVars = (obj) => Object.entries(obj).map(([k, v]) => `--t-${k}:${v};`).join("");
const THEME_CSS = `[data-theme="light"]{${themeVars(LIGHT)}}[data-theme="dark"]{${themeVars(DARK)}}`;

/* ------------------------------------------------------------------ */
/*  Inputs are owned by the app's Zustand store (`planInputs`/            */
/*  `setPlanInputs` props), not local state — this used to be a plain     */
/*  `useState` backed by its own `localStorage.setItem(                   */
/*  "uk-retirement-planner:inputs", ...)` call, invisible to the app's    */
/*  IndexedDB durable mirror, daily snapshot, and JSON backup/restore,    */
/*  the same data-loss class fixed for the Allowances tab's overrides.    */
/*  It's also why this tab used to need its own Save/Load buttons: with   */
/*  inputs living in the shared store, the app-wide Save/Load already     */
/*  covers them, so this tab doesn't need its own.                        */
/* ------------------------------------------------------------------ */
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, system-ui, sans-serif";
const hdrBtn = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  border: `1px solid ${T.line}`,
  background: T.surface,
  borderRadius: 9,
  padding: "8px 11px",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
  color: T.ink,
  fontFamily: SANS,
};

/* ------------------------------------------------------------------ */
/*  Formatters                                                         */
/* ------------------------------------------------------------------ */
const gbp = (n) => "£" + Math.round(n || 0).toLocaleString("en-GB");
const gbpK = (n) => {
  const v = n || 0;
  if (Math.abs(v) >= 1e6) return "£" + (v / 1e6).toFixed(2) + "m";
  if (Math.abs(v) >= 1e3) return "£" + Math.round(v / 1e3) + "k";
  return "£" + Math.round(v);
};
const pct = (n, d = 1) => (n * 100).toFixed(d) + "%";

function tooltipStyle() {
  return {
    background: T.surface,
    border: `1px solid ${T.line}`,
    borderRadius: 10,
    fontSize: 12,
    fontFamily: SANS,
    color: T.ink,
    boxShadow: "0 4px 16px rgba(0,0,0,.08)",
  };
}

export { SHARED_TOKENS, LIGHT, DARK, T, THEME_CSS, MONO, SANS, hdrBtn, gbp, gbpK, pct, tooltipStyle };
