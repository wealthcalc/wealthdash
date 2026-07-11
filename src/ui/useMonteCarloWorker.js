/* ======================================================================
   useMonteCarloWorker — wraps workers/monteCarloWorker.js behind a plain
   run(inputs, {onProgress}) -> Promise<result> interface, so PlanTab can
   call it like any other async function instead of juggling postMessage
   plumbing. One worker instance is created lazily on first run and reused
   across every subsequent run (including both sides of a Scenario A/B
   comparison, run sequentially against the same worker), terminated on
   unmount. Falls back to running the simulation synchronously on the main
   thread if Workers aren't available (very old browser, or a non-browser
   test/SSR context) rather than hanging forever waiting for a worker that
   will never exist.
   ====================================================================== */
import { useRef, useCallback, useEffect } from "react";

export function useMonteCarloWorker() {
  const workerRef = useRef(null);
  const nextId = useRef(1);
  const pending = useRef(new Map()); // id -> {resolve, reject, onProgress}

  const getWorker = useCallback(() => {
    if (!workerRef.current) {
      workerRef.current = new Worker(new URL("../workers/monteCarloWorker.js", import.meta.url), { type: "module" });
      workerRef.current.onmessage = (e) => {
        const { id, type, frac, result, message } = e.data;
        const p = pending.current.get(id);
        if (!p) return;
        if (type === "progress") p.onProgress?.(frac);
        else if (type === "done") { pending.current.delete(id); p.resolve(result); }
        else if (type === "error") { pending.current.delete(id); p.reject(new Error(message)); }
      };
      workerRef.current.onerror = (e) => {
        // A worker-level failure (e.g. bundling issue) rejects every
        // still-pending call rather than leaving callers hanging forever.
        for (const [, p] of pending.current) p.reject(new Error(e.message || "Monte Carlo worker error"));
        pending.current.clear();
      };
    }
    return workerRef.current;
  }, []);

  const run = useCallback((inputs, { onProgress } = {}) => {
    if (typeof Worker === "undefined") {
      // No Worker support — run synchronously in place. Dynamic import
      // keeps this fallback path out of the main bundle's eager graph.
      return import("../core/monte-carlo.mjs").then(({ runMonteCarlo }) => runMonteCarlo({ ...inputs, onProgress }));
    }
    return new Promise((resolve, reject) => {
      const id = nextId.current++;
      pending.current.set(id, { resolve, reject, onProgress });
      getWorker().postMessage({ id, inputs });
    });
  }, [getWorker]);

  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  return run;
}
