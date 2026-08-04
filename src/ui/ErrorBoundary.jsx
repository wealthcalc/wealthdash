/* ======================================================================
   ERROR BOUNDARY — contains a render/lifecycle throw to ONE tab instead of
   unmounting the whole app to a blank page.

   Why this matters here specifically: every tab is a lazy chunk rendered
   into a single shell. Without a boundary, one bad number (a NaN reaching a
   chart, an undefined field on a half-imported row) blanks the entire
   dashboard — which looks exactly like data loss even though localStorage
   is untouched. So the fallback's first job is to SAY the data is safe, and
   its second is to offer an immediate backup download: if something is
   genuinely corrupt, the user should be able to get their ledger out before
   touching anything else.

   `resetKey` lets the shell clear the error when the user navigates to a
   different tab — otherwise a crashed tab would stay crashed for the
   session even after moving away and back.

   React error boundaries must be class components: there is no hook
   equivalent for componentDidCatch. This is the app's only class component,
   deliberately.
   ====================================================================== */
import React from "react";
import { AlertTriangle, RotateCcw, FileDown } from "lucide-react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    // Navigating elsewhere clears the error so the app stays usable.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { label = "This screen", onBackup } = this.props;

    return (
      <div className="mt-4 rounded-xl border p-4 space-y-3"
        style={{ background: "color-mix(in srgb, var(--loss) 8%, transparent)", borderColor: "color-mix(in srgb, var(--loss) 35%, transparent)" }}>
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--loss)" }}>
          <AlertTriangle size={16} aria-hidden="true" /> {label} hit an error and couldn&apos;t render
        </div>
        <p className="text-sm text-[var(--fg)] leading-relaxed">
          <strong>Your data is safe.</strong> This is a display fault in this screen only — nothing has been written or deleted, and every other tab still works. Switching tabs clears this.
        </p>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => this.setState({ error: null })}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)]">
            <RotateCcw size={14} aria-hidden="true" /> Try again
          </button>
          {onBackup && (
            <button onClick={onBackup}
              className="inline-flex items-center gap-1.5 text-sm font-medium px-3 h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)]">
              <FileDown size={14} aria-hidden="true" /> Download a backup first
            </button>
          )}
        </div>
        <details className="text-xs text-[var(--muted)]">
          <summary className="cursor-pointer hover:text-[var(--fg)]">Technical detail (useful if reporting this)</summary>
          <pre className="mt-2 p-2 rounded-lg bg-[var(--panel2)] overflow-x-auto whitespace-pre-wrap break-words">
            {String(error && (error.stack || error.message || error))}
          </pre>
        </details>
      </div>
    );
  }
}
