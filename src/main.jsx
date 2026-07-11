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
  });
