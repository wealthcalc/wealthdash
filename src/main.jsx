import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { restoreLocalStorageIfEvicted } from "./state/durable.js";
import { bootSyncPull } from "./state/sync.js";

// If the browser evicted localStorage (cleanup, "clear site data", Safari
// ITP), restore it from the IndexedDB mirror BEFORE the app module loads —
// the store reads localStorage synchronously at import time, so the app is
// dynamic-imported only once the restore has settled. If IndexedDB is
// unavailable this resolves immediately and boot is unchanged.
// Then, if encrypted sync is enabled and the server holds a NEWER copy,
// pull it into localStorage the same way — the store boots from it as if
// it had always been here. Both steps degrade to a plain local boot on
// any failure; neither can brick the app.
restoreLocalStorageIfEvicted()
  .catch(() => {})
  .then(() => bootSyncPull())
  .catch(() => {})
  .then(() => import("./CgtDashboard.jsx"))
  .then(({ default: App }) => {
    createRoot(document.getElementById("root")).render(
      <React.StrictMode><App /></React.StrictMode>
    );
  })
  // Without this the app fails SILENTLY to a blank white page — which is
  // exactly what a stale cached index.html produces after a redeploy: the
  // browser requests a hashed chunk the new deployment no longer has, the
  // dynamic import rejects, and nothing ever mounts. A blank screen tells
  // the user nothing and, worse, looks like their data is gone. It isn't:
  // localStorage/IndexedDB are untouched by a render failure, so say so.
  .catch((err) => {
    const stale = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(err?.message || "");
    const root = document.getElementById("root");
    if (!root) return;
    root.innerHTML = `
      <div style="max-width:34rem;margin:12vh auto;padding:0 1.5rem;font:15px/1.6 system-ui,-apple-system,sans-serif;color:#c9d1d9">
        <h1 style="font-size:1.1rem;margin:0 0 .75rem">The dashboard didn't load</h1>
        <p style="margin:0 0 .75rem;color:#8b949e">
          ${stale
    ? "This usually means a new version was deployed while your browser held the old one cached."
    : "Something went wrong while starting the app."}
        </p>
        <p style="margin:0 0 1.25rem;color:#8b949e">
          <strong style="color:#c9d1d9">Your data is safe.</strong> It's stored in this browser and a failure to start can't touch it.
        </p>
        <button id="reloadBtn" style="background:#2f81f7;color:#fff;border:0;border-radius:.5rem;padding:.5rem .9rem;font-size:.9rem;font-weight:600;cursor:pointer">
          Reload
        </button>
        <p style="margin:1.25rem 0 0;color:#6e7681;font-size:.8rem">
          If that doesn't help, do a hard refresh (⌘⇧R / Ctrl-F5). Technical detail: ${String(err?.message || err).slice(0, 200)}
        </p>
      </div>`;
    document.getElementById("reloadBtn")?.addEventListener("click", () => window.location.reload(true));
  });
