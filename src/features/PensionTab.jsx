import React, { useState, useMemo, useCallback, useRef } from "react";
import { Plus, Trash2, ClipboardPaste, Check } from "lucide-react";
import { normWrapper } from "../core/portfolio.mjs";
import { xirr } from "../core/returns.mjs";
import { parseLgimPaste, parseLgimApi, matchLgimRows, suggestLgimMatch, lgimIgnoreKey } from "../core/lgim-import.mjs";
import { gbp, gbp0, WrapperChip, num, round2, CurrencyInput, NumberInput, uid, todayISO, rateIsDisplayable, Field, Stat, Empty } from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";
import { removeWithUndo } from "../ui/undo.jsx";

/* Workplace fund prices, pasted.

   These funds have no live quote source. The scheme publishes a price table
   on the web, but the page it appears on only EMBEDS a widget from another
   host, and that widget renders client-side — so there is nothing for a
   server-side fetch to read. Pasting the copied table is therefore not a
   lazy shortcut, it's the only thing that reliably works today, and it can't
   break when the provider restyles their site.

   Design notes that matter for correctness:
   - Prices are quoted in PENCE and are dated with the day the price was
     STRUCK, typically a day or two back. The quote date is what gets
     recorded, so staleness is judged against the fund's own date rather than
     the moment you pasted.
   - Nothing is guessed. A fund only takes a price once its name is mapped to
     a ticker; the mapping is remembered in secMeta.lgimName so subsequent
     pastes are one click. Putting a wrong price on a pension holding is far
     worse than asking once. */
function LgimPastePanel({ rows: holdingRows, secMeta, setSecMeta, setPrices, setPriceMeta, ignored, setIgnored }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [assign, setAssign] = useState({});   // fund name -> ticker chosen now
  const [done, setDone] = useState("");
  const [fetched, setFetched] = useState(null); // rows from the live feed
  const [busy, setBusy] = useState(false);
  const [fetchErr, setFetchErr] = useState("");
  const [showDismissed, setShowDismissed] = useState(false);

  // The widget's own JSON feed, via /api/lgim-prices. Failure is never fatal:
  // it just leaves the paste box as the way through, which always works.
  const fetchLive = async () => {
    setBusy(true); setFetchErr("");
    try {
      const r = await fetch("/api/lgim-prices?site=32");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const out = parseLgimApi(j.json);
      if (!out.rows.length) throw new Error(out.warnings[0] || "No prices in the response.");
      setFetched(out); setText("");
    } catch (e) {
      setFetchErr(`${e.message} — paste the table instead.`);
    } finally { setBusy(false); }
  };

  const parsed = useMemo(() => {
    if (text.trim()) return parseLgimPaste(text);   // a paste overrides a fetch
    return fetched || { rows: [], warnings: [] };
  }, [text, fetched]);
  const { matched, unmatched } = useMemo(() => matchLgimRows(parsed.rows, { secMeta }), [parsed.rows, secMeta]);

  // Pension-fund tickers that don't already have a price from this paste.
  const claimed = new Set(matched.map((m) => m.ticker));
  const assignable = holdingRows.filter((r) => !claimed.has(r.ticker));

  // Provider names and the names people actually file holdings under rarely
  // agree ("Citi UK Plan Global Equity Fund - Passive" vs "Citi SIPP — L&G
  // Global Equity Fund (Passive)"), so offer a best guess rather than making
  // the user map every fund by hand. Suggestions only PRE-SELECT; nothing is
  // applied until Apply is pressed.
  const ignoredSet = useMemo(() => new Set(ignored || []), [ignored]);
  const isIgnored = (r) => ignoredSet.has(lgimIgnoreKey(r));
  // A scheme feed lists every fund in the plan; you hold a handful. Anything
  // dismissed stays dismissed across refreshes — re-proposing a rejected
  // match every time is worse than not suggesting at all.
  const liveUnmatched = unmatched.filter((r) => !isIgnored(r));
  const dismissed = unmatched.filter(isIgnored);

  const suggestions = useMemo(() => {
    const cands = assignable.map((h) => ({ ticker: h.ticker, name: secMeta[h.ticker]?.name || h.ticker }));
    const out = {};
    for (const u of liveUnmatched) {
      const s = suggestLgimMatch(u, cands);
      if (s) out[u.name] = s.ticker;
    }
    return out;
  }, [liveUnmatched, assignable, secMeta]);

  const dismiss = (r) => {
    setIgnored((cur) => [...new Set([...(cur || []), lgimIgnoreKey(r)])]);
    setAssign((a) => { const n = { ...a }; delete n[r.name]; return n; });
  };
  const restore = (r) => {
    const k = lgimIgnoreKey(r);
    setIgnored((cur) => (cur || []).filter((x) => x !== k));
  };

  // An explicit choice wins over a suggestion; "" means the user cleared it.
  const chosenFor = (r) => (assign[r.name] !== undefined ? assign[r.name] : (suggestions[r.name] || ""));

  const pending = [
    ...matched.map((m) => ({ ...m, ticker: m.ticker, via: "saved" })),
    ...liveUnmatched.filter((u) => chosenFor(u)).map((u) => ({ ...u, ticker: chosenFor(u), via: "new" })),
  ];

  const apply = () => {
    if (!pending.length) return;
    setPrices((p) => {
      const next = { ...p };
      for (const r of pending) next[r.ticker] = r.price;
      return next;
    });
    setPriceMeta((p) => {
      const next = { ...p };
      for (const r of pending) {
        // asOf is the QUOTE date, not now — these strike in arrears.
        next[r.ticker] = { asOf: `${r.date}T00:00:00.000Z`, raw: r.pricePence, ccy: "GBp", source: "L&G" };
      }
      return next;
    });
    // Remember newly confirmed mappings so the next run needs no clicks.
    // The provider's fund CODE is stored where available — it survives the
    // renames that fund names go through, and is what matching prefers.
    // Spreading the existing entry is deliberate: exposure/look-through data
    // lives on the same object and must not be clobbered.
    const fresh = pending.filter((r) => r.via === "new");
    if (fresh.length) {
      setSecMeta((m) => {
        const next = { ...m };
        for (const r of fresh) {
          next[r.ticker] = { ...next[r.ticker], lgimName: r.name, ...(r.code ? { lgimCode: r.code } : {}) };
        }
        return next;
      });
    }
    setDone(`Updated ${pending.length} fund price${pending.length === 1 ? "" : "s"} (priced ${pending[0].date}).`);
    setText(""); setAssign({}); setFetched(null);
    setTimeout(() => setDone(""), 6000);
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 space-y-2">
      <button onClick={() => setOpen((o) => !o)} className="text-sm font-semibold flex items-center gap-1.5">
        <ClipboardPaste size={15} className="text-[var(--accent)]" aria-hidden="true" />
        Update workplace fund prices {open ? "▾" : "▸"}
      </button>
      {done && <div className="text-xs text-[var(--gain)] flex items-center gap-1"><Check size={13} aria-hidden="true" /> {done}</div>}
      {open && (
        <div className="space-y-2">
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Workplace funds aren&apos;t on Yahoo. Fetch pulls today&apos;s prices from your scheme&apos;s own fund centre; if that ever fails, copy the price table off the scheme page and paste it below instead. Either way prices are stamped with the date the provider struck them, not today.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={fetchLive} disabled={busy} className={busy ? "btn-accent opacity-60" : "btn-accent"}>
              {busy ? "Fetching…" : "Fetch latest prices"}
            </button>
            {fetched && !text.trim() && <span className="text-xs text-[var(--gain)]">Live feed · {fetched.rows.length} funds</span>}
          </div>
          {fetchErr && <div className="text-xs text-[var(--m-bb)]">{fetchErr}</div>}

          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
            aria-label="Paste the fund price table"
            placeholder="Citi UK Plan Growth Fund0.4065%0.0161%0.4226%1,134.39p06/08/2026Download data"
            className="input w-full text-xs font-mono" />

          {parsed.warnings.map((w, i) => <div key={i} className="text-xs text-[var(--m-bb)]">{w}</div>)}

          {parsed.rows.length > 0 && (
            <>
              <div className="text-xs text-[var(--muted)] flex flex-wrap items-center gap-x-1.5">
                <span>
                  Found <strong className="text-[var(--fg)]">{parsed.rows.length}</strong> priced fund{parsed.rows.length === 1 ? "" : "s"} · {matched.length} mapped{liveUnmatched.length > 0 && <> · {liveUnmatched.length} unmatched</>}{dismissed.length > 0 && <> · {dismissed.length} dismissed</>}
                </span>
                {dismissed.length > 0 && (
                  <button onClick={() => setShowDismissed((v) => !v)} className="underline underline-offset-2 hover:text-[var(--fg)]">
                    {showDismissed ? "hide dismissed" : `show ${dismissed.length} dismissed`}
                  </button>
                )}
              </div>
              <div className="rounded-lg border border-[var(--border)] max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-[var(--border)]">
                    {[...matched, ...liveUnmatched, ...(showDismissed ? dismissed : [])].map((r) => {
                      const isMatched = matched.includes(r);
                      const wasDismissed = isIgnored(r);
                      const chosen = isMatched ? r.ticker : (wasDismissed ? "" : chosenFor(r));
                      const isSuggested = !isMatched && !wasDismissed && chosen && assign[r.name] === undefined;
                      return (
                        <tr key={r.name} className={wasDismissed ? "opacity-45" : (chosen ? "" : "opacity-70")}>
                          <td className="px-2 py-1.5">{r.name}</td>
                          <td className="px-2 py-1.5 num text-right whitespace-nowrap">{r.pricePence}p</td>
                          <td className="px-2 py-1.5 num text-right whitespace-nowrap text-[var(--muted)]">{gbp(r.price)}</td>
                          <td className="px-2 py-1.5">
                            {isMatched ? (
                              <span className="text-[var(--gain)]">→ {r.ticker}</span>
                            ) : wasDismissed ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span className="text-[10px] text-[var(--muted)]">not mine</span>
                                <button onClick={() => restore(r)} className="text-[10px] underline underline-offset-2 hover:text-[var(--fg)]"
                                  title="Bring this fund back — use this if you've switched into it">restore</button>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5">
                                <select value={chosen} aria-label={`Holding for ${r.name}`}
                                  onChange={(e) => setAssign((a) => ({ ...a, [r.name]: e.target.value }))}
                                  className="input text-xs py-0.5">
                                  <option value="">— skip —</option>
                                  {assignable.map((h) => <option key={h.ticker} value={h.ticker}>{h.ticker} · {secMeta[h.ticker]?.name || h.ticker}</option>)}
                                </select>
                                {isSuggested && <span className="text-[10px] text-[var(--m-bb)]" title="Best guess from the fund name — check it before applying">suggested</span>}
                                <button onClick={() => dismiss(r)} className="text-[10px] text-[var(--muted)] underline underline-offset-2 hover:text-[var(--fg)]"
                                  title="I don't hold this fund — stop offering it on future refreshes">not mine</button>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button onClick={apply} disabled={!pending.length} className={pending.length ? "btn-accent" : "btn-accent opacity-40 cursor-not-allowed"}>
                Apply {pending.length} price{pending.length === 1 ? "" : "s"}
              </button>
              <p className="text-[11px] text-[var(--muted)]">
                The feed lists every fund in the scheme, not just yours. “Not mine” hides a fund for good, so refreshes stop re-proposing it; nothing is deleted, and if you later switch into one, use <span className="whitespace-nowrap">“show dismissed”</span> → restore to map it. Confirmed mappings are remembered by the provider&apos;s fund code, so future refreshes are one click.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Phase 2.8 de-drilling: raw state from the store; the shell keeps
// providing recomputeProviderCost (cross-slice derived logic).
function PensionTab({ recomputeProviderCost }) {
  const txns = useAppStore((s) => s.txns), setTxns = useAppStore((s) => s.setTxns);
  const cash = useAppStore((s) => s.cash), setCash = useAppStore((s) => s.setCash);
  const secMeta = useAppStore((s) => s.secMeta), setSecMeta = useAppStore((s) => s.setSecMeta);
  const prices = useAppStore((s) => s.prices), setPrices = useAppStore((s) => s.setPrices);
  const setPriceMeta = useAppStore((s) => s.setPriceMeta);
  const lgimIgnored = useAppStore((s) => s.lgimIgnored), setLgimIgnored = useAppStore((s) => s.setLgimIgnored);
  const pensionCashflows = useAppStore((s) => s.pensionCashflows), setPensionCashflows = useAppStore((s) => s.setPensionCashflows);
  const [form, setForm] = useState({ wrapper: "SIPP", provider: "", ticker: "", name: "", units: "", price: "" });
  const [cfForm, setCfForm] = useState({ provider: "", date: todayISO(), type: "Regular Contribution", amount: "" });
  const [confirmRemoveProvider, setConfirmRemoveProvider] = useState(null);
  const [renaming, setRenaming] = useState(null); // provider name currently being renamed
  const [renameValue, setRenameValue] = useState("");
  const [expandedCf, setExpandedCf] = useState(null); // provider whose contribution history is expanded

  // LISA "invested but not itemised by fund" ticker — excluded from the
  // normal per-provider fund tables below, shown in its own summary instead.
  const LISA_INVESTED_TICKER = "LISA_INVESTED";
  const rows = useMemo(() => {
    const byKey = {};
    for (const t of txns) {
      const w = normWrapper(t.wrapper);
      if (w !== "SIPP" && w !== "LISA") continue;
      if (t.ticker === LISA_INVESTED_TICKER) continue;
      const key = w + "\u0000" + t.ticker;
      const sign = t.side === "SELL" ? -1 : 1;
      (byKey[key] ||= { wrapper: w, ticker: t.ticker, units: 0, cost: 0 });
      byKey[key].units += sign * t.quantity;
      byKey[key].cost += sign * t.gbpAmount;
    }
    return Object.values(byKey).filter((r) => Math.abs(r.units) > 1e-9)
      .map((r) => ({ ...r, provider: secMeta[r.ticker]?.provider || "Unassigned" }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.wrapper.localeCompare(b.wrapper) || a.ticker.localeCompare(b.ticker));
  }, [txns, secMeta]);

  // LISA "invested but not itemised by fund" — book cost + market value as
  // a single pair, for when you don't have (or don't want) per-fund units.
  // Reuses the same position machinery as everything else (qty fixed at 1,
  // price = market value, cost = book cost) rather than a parallel schema.
  const lisaInvestedCost = txns.find((t) => normWrapper(t.wrapper) === "LISA" && t.ticker === LISA_INVESTED_TICKER)?.gbpAmount || 0;
  const lisaInvestedValue = prices[LISA_INVESTED_TICKER] || 0;
  const setLisaInvested = (cost, value) => {
    setSecMeta((m) => ({ ...m, [LISA_INVESTED_TICKER]: { ...m[LISA_INVESTED_TICKER], name: "LISA — invested, not itemised by fund", domicile: "GB", eri: false, kind: "fund" } }));
    setTxns((all) => {
      const rest = all.filter((t) => !(normWrapper(t.wrapper) === "LISA" && t.ticker === LISA_INVESTED_TICKER));
      if (cost <= 0 && value <= 0) return rest; // both cleared -> remove the row entirely
      return [...rest, {
        id: `pension_LISA_${LISA_INVESTED_TICKER}`, date: todayISO(), ticker: LISA_INVESTED_TICKER, side: "BUY",
        quantity: 1, nativeCurrency: "GBP", nativeAmount: round2(cost), fxRate: 1, gbpAmount: round2(cost), wrapper: "LISA",
        note: "LISA invested total (book cost / market value), not broken down by fund.",
      }];
    });
    setPrices((p) => ({ ...p, [LISA_INVESTED_TICKER]: round2(value) }));
    setPriceMeta((m) => ({
      ...m,
      [LISA_INVESTED_TICKER]: { asOf: new Date().toISOString(), raw: round2(value), ccy: "GBP", source: "manual" },
    }));
  };

  const total = rows.reduce((s, r) => s + (prices[r.ticker] != null ? r.units * prices[r.ticker] : r.cost), 0) + (+cash.LISA || 0) + lisaInvestedValue;
  const providers = useMemo(() => [...new Set(rows.map((r) => r.provider))].sort(), [rows]);
  const byProvider = useMemo(() => {
    const m = {};
    for (const r of rows) (m[r.provider] ||= []).push(r);
    return m;
  }, [rows]);
  const cashflowsByProvider = useMemo(() => {
    const m = {};
    for (const c of pensionCashflows) (m[c.provider] ||= []).push(c);
    return m;
  }, [pensionCashflows]);
  // Money-weighted return per provider: contributions are negative (money
  // out of pocket), current provider value is the one positive terminal
  // cashflow — same XIRR convention already used for GIA/ISA holdings.
  // Non-GBP contribution rows without a resolved GBP amount are excluded
  // (flagged separately) rather than guessed.
  const xirrByProvider = useMemo(() => {
    const out = {};
    for (const provider of providers) {
      const cfs = cashflowsByProvider[provider] || [];
      const usable = cfs.filter((c) => c.gbpAmount != null);
      const flows = usable.map((c) => ({ date: c.date, amount: -Math.abs(c.gbpAmount) }));
      // current MARKET VALUE (units × live price), not book cost — XIRR
      // compares money contributed against what it's worth now, not what
      // was paid in. Falls back to cost only if no price is set at all.
      const currentValue = byProvider[provider].reduce((s, r) => {
        const price = prices[r.ticker];
        return s + (price != null ? r.units * price : r.cost);
      }, 0);
      if (currentValue > 0) flows.push({ date: todayISO(), amount: currentValue });
      out[provider] = { result: xirr(flows), needsFx: cfs.length - usable.length, nCashflows: usable.length };
    }
    return out;
  }, [providers, cashflowsByProvider, byProvider, prices]);

  // Replace ALL transactions for (wrapper, ticker) with a single consolidated
  // snapshot — quantity only. Cost is set separately (see setManualCost /
  // recomputeProviderCost below): conflating "price you tell us" with "cost
  // you paid" was the original design's bug — a contribution added later had
  // nowhere to go, since cost was always just units × price at last edit.
  const setUnits = (wrapper, ticker, units, fallbackCostIfNew) => {
    setTxns((all) => {
      const existing = all.find((t) => normWrapper(t.wrapper) === wrapper && t.ticker === ticker);
      const cost = existing ? existing.gbpAmount : round2(units * (fallbackCostIfNew || 0));
      const rest = all.filter((t) => !(normWrapper(t.wrapper) === wrapper && t.ticker === ticker));
      return [...rest, {
        id: existing?.id || `pension_${wrapper}_${ticker}_${Date.now()}`, date: existing?.date || todayISO(), ticker, side: "BUY",
        quantity: units, nativeCurrency: "GBP", nativeAmount: cost, fxRate: 1, gbpAmount: cost, wrapper,
        note: existing?.note || "Pension/LISA snapshot — units set via the Pension & LISA tab; cost tracked separately.",
      }];
    });
  };
  // Price is purely a market-value input (same as every other holding's live
  // price elsewhere in the app) — it does NOT touch cost.
  //
  // priceMeta is stamped too. Editing a price here used to write ONLY the
  // price, leaving the old provenance record untouched — so the Live prices
  // panel went on reporting a date from weeks earlier, the staleness checks
  // judged a freshly-entered figure as stale, and "since you last opened"
  // read from that same stale metadata. Any hand-entered price is, by
  // definition, manual and current.
  const setPrice = (ticker, price) => {
    setPrices((p) => ({ ...p, [ticker]: price }));
    setPriceMeta((m) => ({
      ...m,
      [ticker]: { asOf: new Date().toISOString(), raw: price, ccy: "GBP", source: "manual" },
    }));
  };
  // Manual cost override — only meaningful (and only offered in the UI) for
  // a provider with no contribution history to derive cost from instead.
  const setManualCost = (wrapper, ticker, cost) => setTxns((all) => all.map((t) =>
    (normWrapper(t.wrapper) === wrapper && t.ticker === ticker) ? { ...t, gbpAmount: cost, nativeAmount: cost } : t
  ));
  const removeRow = (wrapper, ticker) => setTxns((all) => all.filter((t) => !(normWrapper(t.wrapper) === wrapper && t.ticker === ticker)));

  // recomputeProviderCost is now passed in as a prop (shared with the Import
  // tab's bulk CSV path) so both use the exact same allocation logic.

  const addRow = () => {
    const tk = form.ticker.toUpperCase().trim();
    const units = +form.units, price = +form.price;
    if (!tk || !Number.isFinite(units) || !Number.isFinite(price) || units <= 0) return;
    setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], name: form.name.trim() || tk, domicile: "GB", eri: false, kind: "fund", provider: form.provider.trim() || "Unassigned" } }));
    setUnits(form.wrapper, tk, units, price);
    setPrice(tk, price);
    setForm({ ...form, ticker: "", name: "", units: "", price: "" });
  };

  // Adding a contribution one at a time — the alternative to bulk CSV import
  // on the Import tab. Same cashflow shape either way, so both feed XIRR
  // identically. Immediately reallocates that provider's fund cost so it
  // shows up in the book cost right away, not just in XIRR.
  const addContribution = () => {
    const amt = +cfForm.amount;
    if (!cfForm.provider.trim() || !cfForm.date || !Number.isFinite(amt) || amt <= 0) return;
    const provider = cfForm.provider.trim();
    const newEntry = { id: uid(), date: cfForm.date, provider, type: cfForm.type, ccy: "GBP", nativeAmount: round2(amt), gbpAmount: round2(amt) };
    setPensionCashflows((p) => [...p, newEntry]);
    setCfForm({ ...cfForm, amount: "" });
    // Pass the about-to-be-current list directly rather than reading state
    // that hasn't re-rendered with this addition yet.
    recomputeProviderCost(provider, [...pensionCashflows, newEntry]);
  };

  // Removing a provider drops every holding tagged with it — for when a
  // pension is transferred/consolidated away entirely. Two-step (click to
  // arm, click again to confirm) rather than a browser confirm dialog.
  const removeProvider = (provider) => {
    if (confirmRemoveProvider !== provider) { setConfirmRemoveProvider(provider); return; }
    const tickers = (byProvider[provider] || []).map((r) => r.ticker);
    setTxns((all) => all.filter((t) => !(tickers.includes(t.ticker) && (normWrapper(t.wrapper) === "SIPP" || normWrapper(t.wrapper) === "LISA"))));
    setConfirmRemoveProvider(null);
  };
  const renameProvider = (oldName) => {
    const next = renameValue.trim();
    if (!next || next === oldName) { setRenaming(null); return; }
    setSecMeta((m) => {
      const copy = { ...m };
      for (const tk of Object.keys(copy)) if ((copy[tk].provider || "Unassigned") === oldName) copy[tk] = { ...copy[tk], provider: next };
      return copy;
    });
    setRenaming(null);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="Pension & LISA total" value={gbp0(total)} big />
        <Stat label="SIPP" value={gbp0(rows.filter((r) => r.wrapper === "SIPP").reduce((s, r) => s + (prices[r.ticker] != null ? r.units * prices[r.ticker] : r.cost), 0))} />
        <Stat label="LISA" value={gbp0(rows.filter((r) => r.wrapper === "LISA").reduce((s, r) => s + (prices[r.ticker] != null ? r.units * prices[r.ticker] : r.cost), 0) + (+cash.LISA || 0) + lisaInvestedValue)} />
      </div>

      {rows.length > 0 && (
        <LgimPastePanel rows={rows} secMeta={secMeta} setSecMeta={setSecMeta} setPrices={setPrices} setPriceMeta={setPriceMeta}
          ignored={lgimIgnored} setIgnored={setLgimIgnored} />
      )}

      {rows.length === 0 && !(+cash.LISA) ? (
        <Empty msg="No pension or LISA holdings yet. Add a fund below, or set a LISA cash total if you don't want to itemise by fund." />
      ) : (
        <div className="space-y-4">
          {providers.map((provider) => {
            const providerRows = byProvider[provider];
            const providerCost = providerRows.reduce((s, r) => s + r.cost, 0);
            const providerValue = providerRows.reduce((s, r) => s + (prices[r.ticker] != null ? r.units * prices[r.ticker] : r.cost), 0);
            const xr = xirrByProvider[provider];
            const cfs = (cashflowsByProvider[provider] || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
            const showingCf = expandedCf === provider;
            const hasContributions = (cashflowsByProvider[provider] || []).some((c) => c.gbpAmount != null);
            return (
              <div key={provider} className="rounded-xl border border-[var(--border)] overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-[var(--panel2)] flex-wrap gap-y-1">
                  {renaming === provider ? (
                    <div className="flex items-center gap-1.5">
                      <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && renameProvider(provider)}
                        className="input py-1 text-sm w-48" />
                      <button onClick={() => renameProvider(provider)} className="text-[var(--accent)] text-xs font-medium">Save</button>
                      <button onClick={() => setRenaming(null)} className="text-[var(--muted)] text-xs">Cancel</button>
                    </div>
                  ) : (
                    <button onClick={() => { setRenaming(provider); setRenameValue(provider); }} className="text-sm font-medium hover:underline decoration-dotted">{provider}</button>
                  )}
                  <div className="flex items-center gap-3 flex-wrap">
                    {xr && xr.result.rate != null && (rateIsDisplayable(xr.result) ? (
                      <span className={"text-xs font-medium num " + (xr.result.rate >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")} title={`Money-weighted return (XIRR) from ${xr.nCashflows} contribution${xr.nCashflows === 1 ? "" : "s"}${xr.needsFx ? `; ${xr.needsFx} non-GBP row(s) need FX, excluded` : ""}`}>
                        XIRR {(xr.result.rate * 100).toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--muted)]" title="Too little contribution history to annualise meaningfully — the XIRR badge appears once 90 days of history exist.">XIRR n/a</span>
                    ))}
                    {cfs.length > 0 && (
                      <button onClick={() => setExpandedCf(showingCf ? null : provider)} className="text-xs text-[var(--muted)] hover:text-[var(--fg)]">
                        {cfs.length} contribution{cfs.length === 1 ? "" : "s"} {showingCf ? "▲" : "▼"}
                      </button>
                    )}
                    {hasContributions && (
                      <button onClick={() => recomputeProviderCost(provider)} className="text-xs text-[var(--accent)] hover:underline" title="Reallocate cost across this provider's funds from its total contributions, by current value weight">
                        Recalculate cost
                      </button>
                    )}
                    <span className="num text-sm font-medium" title={`Cost £${providerCost.toFixed(2)}`}>{gbp(providerValue)}</span>
                    <button onClick={() => removeProvider(provider)}
                      className={"text-xs px-2 py-1 rounded " + (confirmRemoveProvider === provider ? "bg-[var(--loss)] text-white" : "text-[var(--muted)] hover:text-[var(--loss)]")}>
                      {confirmRemoveProvider === provider ? "Click again to remove all holdings" : "Remove provider"}
                    </button>
                  </div>
                </div>
                {!hasContributions && (
                  <p className="text-xs text-[var(--muted)] px-3 pt-2">No contributions logged for this provider yet — cost below is set directly. Add contributions (below, or via Import) to have cost derived from them instead.</p>
                )}
                <table className="w-full text-sm">
                  <thead className="text-[var(--muted)] text-xs uppercase tracking-wide">
                    <tr>{["Wrapper", "Fund", "Units", "Price", "Cost", "Value", "Gain", ""].map((h, i) => <th key={i} className={"px-3 py-1.5 font-medium " + (i >= 2 ? "text-right" : "text-left")}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                    {providerRows.map((r) => {
                      const name = secMeta[r.ticker]?.name || r.ticker;
                      const price = prices[r.ticker] ?? (r.units ? r.cost / r.units : 0);
                      const value = r.units * price;
                      const gain = value - r.cost;
                      return (
                        <tr key={r.wrapper + r.ticker}>
                          <td className="px-3 py-2"><WrapperChip wrapper={r.wrapper} /></td>
                          <td className="px-3 py-2">
                            <div className="font-medium">{r.ticker}</div>
                            <div className="text-xs text-[var(--muted)]">{name}</div>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <NumberInput value={r.units} onChange={(v) => setUnits(r.wrapper, r.ticker, v, price)} className="w-28 py-1" dp={4} />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <span title="Market price — for valuation only, doesn't affect cost">
                              <NumberInput value={price} onChange={(v) => setPrice(r.ticker, v)} className="w-28 py-1" dp={4} />
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            {hasContributions ? (
                              <span className="num" title="Derived from this provider's contributions — use Recalculate cost above after editing units or a contribution">{gbp(r.cost)}</span>
                            ) : (
                              <input type="number" defaultValue={round2(r.cost)} onBlur={(e) => setManualCost(r.wrapper, r.ticker, +e.target.value || 0)} className="input num w-24 text-right py-1" />
                            )}
                          </td>
                          <td className="px-3 py-2 text-right num font-medium">{gbp(value)}</td>
                          <td className={"px-3 py-2 text-right num " + (gain >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{gbp(gain)}</td>
                          <td className="px-3 py-2 text-right"><button onClick={() => removeRow(r.wrapper, r.ticker)} aria-label={`Remove ${r.ticker} (${r.wrapper})`} title="Remove" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} aria-hidden="true" /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {showingCf && (
                  <div className="border-t border-[var(--border)] max-h-64 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="text-[var(--muted)] sticky top-0 bg-[var(--panel)]"><tr>{["Date", "Type", "Amount", ""].map((h, i) => <th key={i} className={"px-3 py-1 font-medium " + (i === 2 ? "text-right" : "text-left")}>{h}</th>)}</tr></thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {cfs.map((c) => (
                          <tr key={c.id}>
                            <td className="px-3 py-1 num">{c.date}</td>
                            <td className="px-3 py-1">{c.type}</td>
                            <td className="px-3 py-1 text-right num">{c.gbpAmount != null ? gbp(c.gbpAmount) : <span className="text-[var(--m-bb)]" title="Non-GBP, no FX resolved — excluded from XIRR">{c.nativeAmount} {c.ccy} (needs FX)</span>}</td>
                            <td className="px-3 py-1 text-right"><button onClick={() => removeWithUndo({ list: pensionCashflows, setList: setPensionCashflows, id: c.id, label: `${c.date} contribution` })} aria-label={`Remove ${c.date} contribution`} title="Remove" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={12} aria-hidden="true" /></button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-end gap-2 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        <Field label="Wrapper"><select value={form.wrapper} onChange={(e) => setForm({ ...form, wrapper: e.target.value })} className="input">{["SIPP", "LISA"].map((w) => <option key={w}>{w}</option>)}</select></Field>
        <Field label="Provider (existing or new)">
          <input list="pension-providers" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} className="input w-44" placeholder="e.g. L&G (Citi)" />
          <datalist id="pension-providers">{providers.map((p) => <option key={p} value={p} />)}</datalist>
        </Field>
        <Field label="Ticker / code"><input value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })} className="input num w-28" placeholder="e.g. CITIUS" /></Field>
        <Field label="Fund name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input w-56" placeholder="e.g. L&G Global Equity" /></Field>
        <Field label="Units"><input type="number" value={form.units} onChange={(e) => setForm({ ...form, units: e.target.value })} className="input num w-28" placeholder="0" /></Field>
        <Field label="Price / unit (£)"><input type="number" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className="input num w-28" placeholder="0.00" /></Field>
        <button onClick={addRow} className="btn-accent"><Plus size={15} /> Add fund</button>
      </div>

      {/* One-off contribution — the alternative to bulk CSV import on the
          Import tab. Either path feeds the same XIRR calculation; use this
          for a single payslip, the CSV importer for a full history at once. */}
      <div className="flex items-end gap-2 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        <Field label="Provider">
          <input list="pension-providers" value={cfForm.provider} onChange={(e) => setCfForm({ ...cfForm, provider: e.target.value })} className="input w-44" placeholder="e.g. L&G (Citi)" />
        </Field>
        <Field label="Date"><input type="date" value={cfForm.date} onChange={(e) => setCfForm({ ...cfForm, date: e.target.value })} className="input num" /></Field>
        <Field label="Type"><select value={cfForm.type} onChange={(e) => setCfForm({ ...cfForm, type: e.target.value })} className="input"><option>Regular Contribution</option><option>Employer Contribution</option><option>Adjustment</option></select></Field>
        <Field label="Amount (£)"><input type="number" value={cfForm.amount} onChange={(e) => setCfForm({ ...cfForm, amount: e.target.value })} className="input num w-32" placeholder="0.00" /></Field>
        <button onClick={addContribution} className="btn-accent"><Plus size={15} /> Add contribution</button>
      </div>

      <div className="flex items-end gap-3 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        <Field label="LISA invested — book cost (£)"><CurrencyInput value={lisaInvestedCost} onChange={(v) => setLisaInvested(v, lisaInvestedValue)} className="w-44" /></Field>
        <Field label="LISA invested — market value (£)"><CurrencyInput value={lisaInvestedValue} onChange={(v) => setLisaInvested(lisaInvestedCost, v)} className="w-44" /></Field>
        <Field label="LISA cash / unallocated (£)"><CurrencyInput value={cash.LISA || 0} onChange={(v) => setCash((c) => ({ ...c, LISA: v }))} className="w-40" /></Field>
        <p className="text-xs text-[var(--muted)] pb-2 max-w-md">Most LISAs hold stocks & shares, not just cash — use the cost/value pair for a single running total (e.g. a S&amp;S LISA statement), the per-fund table above for detail, or plain cash if that's genuinely all it is. Any combination is fine; all three add up into the LISA total.</p>
      </div>

      <p className="text-xs text-[var(--muted)]">
        Holdings are grouped by provider — click a provider's name to rename it (e.g. when a scheme moves administrator), or "Remove provider" to drop every holding under it in one go (for a full transfer/consolidation elsewhere). New funds pick up whichever provider you type or select.
        Editing units or price replaces the position outright (this is a snapshot, not a running ledger) — cost basis resets to the new value, since contribution history usually isn't available for insurer-administered pensions.
        Contributions feed each provider's XIRR — add them one at a time above, or in bulk on the Import tab's "Pension contributions" mode.
        SIPP and LISA are both tax-sheltered, so nothing here affects any CGT or income-tax figure elsewhere in the app; it only feeds your total wealth.
      </p>
    </div>
  );
}



export default PensionTab;
