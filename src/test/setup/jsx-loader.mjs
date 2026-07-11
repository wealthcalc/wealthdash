// Node module-loader hook: transform .jsx on the fly with esbuild (already
// present as Vite's own dependency — no new install) so `node --test` can
// import React components directly. Used ONLY by the UI smoke tests via
// `--import ./src/test/setup/register.mjs`; the core test suite stays
// plain .mjs with zero transform cost.
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

export async function load(url, context, nextLoad) {
  if (url.endsWith(".jsx")) {
    const src = await readFile(new URL(url), "utf8");
    const { code } = await transform(src, {
      loader: "jsx",
      format: "esm",
      jsx: "automatic", // react/jsx-runtime — no React-in-scope requirement
      sourcefile: url,
    });
    return { format: "module", source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
