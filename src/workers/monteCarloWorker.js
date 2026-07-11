/* ======================================================================
   MONTE CARLO WEB WORKER — thin postMessage glue around the pure
   core/monte-carlo.mjs simulation. Runs off the main thread so a 1000+-run
   simulation doesn't freeze scrolling/typing anywhere else in the app
   while it computes (the old inline version blocked the main thread and
   only faked responsiveness with a setTimeout before starting).

   Not node-tested (it's a Worker entry point, not importable under
   node --test the way a plain ES module is) — the actual simulation logic
   it calls IS fully tested, in test/monte-carlo.test.mjs. This file is
   deliberately as thin as possible so there's as little untested surface
   as it can get away with: unwrap the message, call the pure function,
   post the result back.
   ====================================================================== */
import { runMonteCarlo } from "../core/monte-carlo.mjs";

self.onmessage = (e) => {
  const { id, inputs } = e.data;
  try {
    const result = runMonteCarlo({
      ...inputs,
      onProgress: (frac) => self.postMessage({ id, type: "progress", frac }),
    });
    self.postMessage({ id, type: "done", result });
  } catch (err) {
    self.postMessage({ id, type: "error", message: err?.message || String(err) });
  }
};
