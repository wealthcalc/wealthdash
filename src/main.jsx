import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { restoreLocalStorageIfEvicted } from "./state/durable.js";

// If the browser evicted localStorage (cleanup, "clear site data", Safari
// ITP), restore it from the IndexedDB mirror BEFORE the app module loads —
// the store reads localStorage synchronously at import time, so the app is
// dynamic-imported only once the restore has settled. If IndexedDB is
// unavailable this resolves immediately and boot is unchanged.
restoreLocalStorageIfEvicted()
  .catch(() => {})
  .then(() => import("./CgtDashboard.jsx"))
  .then(({ default: App }) => {
    createRoot(document.getElementById("root")).render(
      <React.StrictMode><App /></React.StrictMode>
    );
  });
