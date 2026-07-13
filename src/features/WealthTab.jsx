import React, { useState } from "react";
import { AlertCircle, Banknote, AlertTriangle, CreditCard, ArrowRight } from "lucide-react";
import { WRAPPERS } from "../core/portfolio.mjs";
import {
  cashAccountsByWrapper, totalCashAccounts, weightedAverageRate, accountsMaturingSoon,
} from "../core/cash.mjs";
import { totalCreditCardDebt } from "../core/credit-cards.mjs";
import LivePricesPanel from "../ui/LivePricesPanel.jsx";
import {
  gbp, gbp0, num, CurrencyInput, Stat, Empty,
  uid, todayISO, Field, useSort, sortRows, SortTh, TwoStepDelete,
} from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";

const ACCOUNT_BLANK = () => ({
  id: uid(), wrapper: "GIA", label: "", institution: "", balance: "",
  rate: "", rateType: "variable", maturityDate: "", notes: "",
});
const CARD_BLANK = () => ({ id: uid(), label: "", issuer: "", balance: "", notes: "" });

// Raw persisted state comes from the store via selectors; only DERIVED
// data (model, netWorth) arrives as props — Phase 2.8 de-drilling.
// `netWorth` (householdNetWorth, core/property.mjs) folds property equity,
// mortgages, other liabilities and credit cards into a single balance-sheet
// total; `setTab` powers the one-line link over to Portfolio ▸ Holdings,
// where the per-position table and allocation/exposure views now live.
function WealthTab({ model, netWorth = null, setTab }) {
  const cash = useAppStore((s) => s.cash), setCash = useAppStore((s) => s.setCash);
  const cashAccounts = useAppStore((s) => s.cashAccounts), setCashAccounts = useAppStore((s) => s.setCashAccounts);
  const creditCards = useAppStore((s) => s.creditCards), setCreditCards = useAppStore((s) => s.setCreditCards);
  // Hooks must run in the same order every render regardless of whether
  // `model` is null this time round, so anything stateful lives above both
  // early-return guards below (this file previously had no hooks at all,
  // which is why those guards used to sit at the very top safely).
  const [acctForm, setAcctForm] = useState(ACCOUNT_BLANK());
  const [acctSort, toggleAcctSort] = useSort("wrapper", "asc");
  const [cardForm, setCardForm] = useState(CARD_BLANK());

  if (!model) return <Empty msg="Couldn't build the portfolio model — check the Transactions tab for ledger errors." />;
  const { positions, byWrapper, total, income } = model;
  if (!positions.length && !Object.keys(cash).length && !cashAccounts.length)
    return <Empty msg="No holdings yet. Add transactions (any wrapper — GIA, ISA, SIPP, LISA, VCT) on the Transactions or Import tab, and cash balances below will appear here." />;

  const tickers = [...new Set(positions.map((p) => p.ticker))].sort();
  const wrapperOrder = [...WRAPPERS, ...Object.keys(byWrapper).filter((w) => !WRAPPERS.includes(w))].filter((w) => byWrapper[w]);
  const setWrapperCash = (w, v) => setCash((c) => { const n = { ...c }; if (v === "" || isNaN(+v)) delete n[w]; else n[w] = +v; return n; });
  const acctByWrapper = cashAccountsByWrapper(cashAccounts);

  // ---- cash accounts (named, with rate + maturity) ----
  const addAccount = () => {
    if (!(+acctForm.balance >= 0)) return;
    setCashAccounts((p) => [...p, { ...acctForm, balance: +acctForm.balance, rate: acctForm.rate === "" ? null : +acctForm.rate }]);
    setAcctForm(ACCOUNT_BLANK());
  };
  const updateAccount = (id, patch) => setCashAccounts((p) => p.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const removeAccount = (id) => setCashAccounts((p) => p.filter((a) => a.id !== id));

  // ---- credit cards (named, subtracted from net worth) ----
  const addCard = () => {
    if (!(+cardForm.balance >= 0)) return;
    setCreditCards((p) => [...p, { ...cardForm, balance: +cardForm.balance }]);
    setCardForm(CARD_BLANK());
  };
  const updateCard = (id, patch) => setCreditCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const removeCard = (id) => setCreditCards((p) => p.filter((c) => c.id !== id));
  const cardsTotal = totalCreditCardDebt(creditCards);

  const acctRows = sortRows(cashAccounts, acctSort, {
    wrapper: (a) => a.wrapper, label: (a) => a.label || "", institution: (a) => a.institution || "",
    balance: (a) => a.balance, rate: (a) => a.rate, maturityDate: (a) => a.maturityDate || null,
  });
  const acctTotal = totalCashAccounts(cashAccounts);
  const acctAvgRate = weightedAverageRate(cashAccounts);
  const acctMaturing = accountsMaturingSoon(cashAccounts, todayISO(), 90);
  // Pension wrappers aren't accessible until retirement age — split out from
  // everything else ("readily available": GIA, ISA, VCT) so Total Wealth
  // doesn't imply money you can't actually get at right now.
  const PENSION_WRAPPERS = ["SIPP", "LISA"];
  const pensionTotal = PENSION_WRAPPERS.reduce((s, w) => s + (byWrapper[w]?.total || 0), 0);
  const readilyAvailable = total.total - pensionTotal;

  // True balance-sheet headline: investments + cash + property equity +
  // private/RSU holdings − other liabilities − credit cards, from the one
  // householdNetWorth figure (core/property.mjs) the Home tab already uses,
  // so the two screens can never quote a different "net worth". Falls back
  // to invested+cash only if the shell hasn't computed netWorth yet (it
  // always does when a model exists, but the guard keeps this pure-ish).
  const headlineValue = netWorth ? netWorth.netWorth : total.total;
  // The property/private/RSU/credit-card breakdown line only earns its place
  // once there's something to break down — for an existing user with no
  // property or liabilities entered, netWorth.netWorth === total.total
  // exactly, so a lone "Investments + cash" row would be pure noise. Same
  // test as HomeTab's hasBalanceSheetExtras.
  const hasBalanceSheetExtras = !!netWorth && (netWorth.propertyValue > 0 || netWorth.otherLiabilities > 0 || netWorth.privateValue > 0 || netWorth.rsuValue > 0 || netWorth.creditCardDebt > 0);

  return (
    <div className="space-y-4">
      {/* headline */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 col-span-2 sm:col-span-1">
          <div className="text-xs text-[var(--muted)]">Net worth</div>
          <div className="num font-semibold text-2xl mt-0.5">{gbp0(headlineValue)}</div>
          <div className="text-xs text-[var(--muted)] mt-0.5">{hasBalanceSheetExtras ? "assets − liabilities, whole household" : `${total.positions} holding${total.positions === 1 ? "" : "s"} + cash across ${wrapperOrder.length} wrapper${wrapperOrder.length === 1 ? "" : "s"}`}</div>
          <div className="mt-2 pt-2 border-t border-[var(--border)] flex justify-between gap-3 text-xs">
            <span><span className="text-[var(--muted)]">Readily available</span> <span className="num font-medium">{gbp0(readilyAvailable)}</span></span>
            <span><span className="text-[var(--muted)]">Pension (SIPP+LISA)</span> <span className="num font-medium">{gbp0(pensionTotal)}</span></span>
          </div>
        </div>
        <Stat label="Invested (priced)" value={total.priced ? gbp0(total.marketValue) : "—"} sub={total.unpriced ? `${total.priced}/${total.positions} priced` : "all priced"} />
        <Stat label="Cash" value={gbp0(total.cash)} />
        <Stat label="Unrealised gain" value={total.priced ? gbp0(total.unrealised) : "—"} sub={total.bookCostPriced ? `${total.unrealised >= 0 ? "+" : ""}${num((total.unrealised / total.bookCostPriced) * 100)}% on priced book cost` : undefined} tone={total.unrealised >= 0 ? "gain" : "loss"} />
      </div>

      {/* balance-sheet breakdown — the pieces that make up net worth, tying
          the invested wealth model together with the Property & debts sub-tab
          and the credit cards below. Only shown once there's a non-investment
          asset or liability to show (see hasBalanceSheetExtras). */}
      {hasBalanceSheetExtras && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3">
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm num">
            <span><span className="text-[var(--muted)]">Investments + cash</span> <span className="font-medium">{gbp0(total.total)}</span></span>
            <span><span className="text-[var(--muted)]">Property equity</span> <span className="font-medium">{gbp0(netWorth.propertyEquity)}</span></span>
            {netWorth.privateValue > 0 && <span><span className="text-[var(--muted)]">Private holdings</span> <span className="font-medium">{gbp0(netWorth.privateValue)}</span></span>}
            {netWorth.rsuValue > 0 && <span><span className="text-[var(--muted)]">RSU holdings</span> <span className="font-medium">{gbp0(netWorth.rsuValue)}</span></span>}
            {netWorth.otherLiabilities > 0 && <span><span className="text-[var(--muted)]">Other liabilities</span> <span className="font-medium text-[var(--loss)]">−{gbp0(netWorth.otherLiabilities)}</span></span>}
            {netWorth.creditCardDebt > 0 && <span><span className="text-[var(--muted)]">Credit cards</span> <span className="font-medium text-[var(--loss)]">−{gbp0(netWorth.creditCardDebt)}</span></span>}
          </div>
          <p className="text-xs text-[var(--muted)] mt-2 leading-relaxed">
            Property, mortgages and other liabilities are entered on the <span className="font-medium text-[var(--fg)]">Property &amp; debts</span> sub-tab; credit cards below. Mortgages are netted inside property equity, not subtracted twice.
          </p>
        </div>
      )}

      {total.unpriced > 0 && (
        <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)]">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
          <span>{total.unpriced} holding{total.unpriced === 1 ? "" : "s"} without a price ({total.unpricedTickers.join(", ")}) — excluded from market value until priced. Fetch live prices below, or set a price by hand on Portfolio ▸ Holdings.</span>
        </div>
      )}

      <LivePricesPanel tickers={tickers} />

      {/* per-wrapper roll-up with editable cash */}
      <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>{["Wrapper", "Holdings", "Book cost", "Market value", "Unrealised", "Cash", "Total"].map((h, i) => (
              <th key={i} className={"px-3 py-2 font-medium " + (i === 0 ? "text-left" : "text-right")}>{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {wrapperOrder.map((w) => {
              const a = byWrapper[w];
              return (
                <tr key={w} className="hover:bg-[var(--panel2)]">
                  <td className="px-3 py-2">
                    <span className="font-medium">{w}</span>
                    <span className={"ml-2 text-[11px] font-semibold px-1.5 py-0.5 rounded " + (a.taxable ? "bg-[var(--chip)] text-[var(--fg)]" : "bg-[color:color-mix(in_srgb,var(--gain)_18%,transparent)] text-[var(--gain)]")}>{a.taxable ? "taxable" : "sheltered"}</span>
                  </td>
                  <td className="px-3 py-2 num text-right">{a.positions}{a.unpriced ? <span className="text-[var(--m-bb)]" title={`${a.unpriced} unpriced`}> *</span> : null}</td>
                  <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(a.bookCost)}</td>
                  <td className="px-3 py-2 num text-right">{a.priced ? gbp(a.marketValue) : "—"}</td>
                  <td className={"px-3 py-2 num text-right " + (a.priced ? (a.unrealised >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]") : "text-[var(--muted)]")}>{a.priced ? gbp(a.unrealised) : "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <CurrencyInput value={cash[w] ?? 0} onChange={(v) => setWrapperCash(w, v)} className="w-32 ml-auto" />
                    {acctByWrapper[w] > 0 && <div className="text-[11px] text-[var(--muted)] mt-0.5">+ {gbp(acctByWrapper[w])} in named accounts</div>}
                  </td>
                  <td className="px-3 py-2 num text-right font-medium">{gbp(a.total)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-[var(--panel2)]">
            <tr className="font-medium">
              <td className="px-3 py-2">Total</td>
              <td className="px-3 py-2 num text-right">{total.positions}</td>
              <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(total.bookCost)}</td>
              <td className="px-3 py-2 num text-right">{total.priced ? gbp(total.marketValue) : "—"}</td>
              <td className={"px-3 py-2 num text-right " + (total.unrealised >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{total.priced ? gbp(total.unrealised) : "—"}</td>
              <td className="px-3 py-2 num text-right">{gbp(total.cash)}</td>
              <td className="px-3 py-2 num text-right">{gbp(total.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* cash accounts — named, with rate + maturity, additive on top of the manual/unallocated figures above */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Banknote size={15} className="text-[var(--accent)]" /> Cash accounts</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Stat label="In named accounts" value={gbp0(acctTotal)} sub={`${cashAccounts.length} account${cashAccounts.length === 1 ? "" : "s"}`} />
          <Stat label="Blended rate" value={acctAvgRate != null ? `${num(acctAvgRate, 2)}%` : "—"} sub="balance-weighted, rated accounts only" />
          <Stat label="Unallocated (manual)" value={gbp0(total.cash - acctTotal)} sub="the Cash column above, per wrapper" />
        </div>

        {acctMaturing.length > 0 && (
          <div className="flex items-start gap-2 text-sm rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel)]">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
            <span>{acctMaturing.length} fixed-term account{acctMaturing.length === 1 ? "" : "s"} {acctMaturing.some((a) => a.matured) ? "matured or " : ""}maturing within 90 days: {acctMaturing.map((a) => `${a.label || a.institution || a.wrapper} (${a.maturityDate}${a.matured ? ", matured — check it hasn't rolled to a low easy-access rate" : ""})`).join("; ")}.</span>
          </div>
        )}

        {cashAccounts.length > 0 && (
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>
                  <SortTh id="wrapper" label="Wrapper" sort={acctSort} onSort={toggleAcctSort} className="px-3 py-2 font-medium" />
                  <SortTh id="label" label="Label" sort={acctSort} onSort={toggleAcctSort} className="px-3 py-2 font-medium" />
                  <SortTh id="institution" label="Institution" sort={acctSort} onSort={toggleAcctSort} className="px-3 py-2 font-medium" />
                  <SortTh id="balance" label="Balance" sort={acctSort} onSort={toggleAcctSort} align="right" className="px-3 py-2 font-medium" />
                  <SortTh id="rate" label="Rate" sort={acctSort} onSort={toggleAcctSort} align="right" className="px-3 py-2 font-medium" />
                  <th className="px-3 py-2 font-medium text-left">Type</th>
                  <SortTh id="maturityDate" label="Maturity" sort={acctSort} onSort={toggleAcctSort} className="px-3 py-2 font-medium" />
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {acctRows.map((a) => (
                  <tr key={a.id} className="hover:bg-[var(--panel2)]">
                    <td className="px-3 py-2">
                      <select className="input text-xs py-1" value={a.wrapper} onChange={(e) => updateAccount(a.id, { wrapper: e.target.value })}>
                        {WRAPPERS.map((w) => <option key={w} value={w}>{w}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2"><input className="input text-xs py-1 w-28" value={a.label || ""} onChange={(e) => updateAccount(a.id, { label: e.target.value })} /></td>
                    <td className="px-3 py-2"><input className="input text-xs py-1 w-28" value={a.institution || ""} onChange={(e) => updateAccount(a.id, { institution: e.target.value })} /></td>
                    <td className="px-3 py-2 text-right"><input type="number" className="input num text-xs py-1 w-28 text-right" value={a.balance} onChange={(e) => updateAccount(a.id, { balance: +e.target.value || 0 })} /></td>
                    <td className="px-3 py-2 text-right"><input type="number" step="0.01" className="input num text-xs py-1 w-16 text-right" value={a.rate ?? ""} onChange={(e) => updateAccount(a.id, { rate: e.target.value === "" ? null : +e.target.value })} />%</td>
                    <td className="px-3 py-2">
                      <select className="input text-xs py-1" value={a.rateType} onChange={(e) => updateAccount(a.id, { rateType: e.target.value })}>
                        <option value="variable">Variable</option><option value="fixed">Fixed</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      {a.rateType === "fixed" ? <input type="date" className="input num text-xs py-1" value={a.maturityDate || ""} onChange={(e) => updateAccount(a.id, { maturityDate: e.target.value })} /> : <span className="text-[var(--muted)] text-xs">n/a</span>}
                    </td>
                    <td className="px-3 py-2 text-right"><TwoStepDelete onConfirm={() => removeAccount(a.id)} label="Remove account" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
          <div className="text-sm font-medium">Add a cash account</div>
          <div className="flex flex-wrap gap-2 items-end">
            <Field label="Wrapper">
              <select className="input" value={acctForm.wrapper} onChange={(e) => setAcctForm({ ...acctForm, wrapper: e.target.value })}>
                {WRAPPERS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </Field>
            <Field label="Label"><input className="input w-32" placeholder="Emergency fund" value={acctForm.label} onChange={(e) => setAcctForm({ ...acctForm, label: e.target.value })} /></Field>
            <Field label="Institution"><input className="input w-32" placeholder="Marcus" value={acctForm.institution} onChange={(e) => setAcctForm({ ...acctForm, institution: e.target.value })} /></Field>
            <Field label="Balance"><input type="number" className="input num w-28" value={acctForm.balance} onChange={(e) => setAcctForm({ ...acctForm, balance: e.target.value })} /></Field>
            <Field label="Rate %"><input type="number" step="0.01" className="input num w-20" value={acctForm.rate} onChange={(e) => setAcctForm({ ...acctForm, rate: e.target.value })} /></Field>
            <Field label="Type">
              <select className="input" value={acctForm.rateType} onChange={(e) => setAcctForm({ ...acctForm, rateType: e.target.value })}>
                <option value="variable">Variable</option><option value="fixed">Fixed</option>
              </select>
            </Field>
            {acctForm.rateType === "fixed" && <Field label="Maturity"><input type="date" className="input num" value={acctForm.maturityDate} onChange={(e) => setAcctForm({ ...acctForm, maturityDate: e.target.value })} /></Field>}
            <button onClick={addAccount} className="btn-accent">Add account</button>
          </div>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Additive on top of the manual "Cash" figure per wrapper above — a wrapper's true cash total is the manual/unallocated amount PLUS everything entered here, same principle as the LISA cash/fund-table split on the Pension tab. No compounding or reinvestment is projected: balances and rates are what you last entered, not a forecast.
          </p>
        </div>
      </div>

      {/* credit cards — named revolving-debt balances, subtracted from net worth */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><CreditCard size={15} className="text-[var(--accent)]" /> Credit cards</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Stat label="Total card debt" value={gbp0(cardsTotal)} sub={`${creditCards.length} card${creditCards.length === 1 ? "" : "s"}`} tone={cardsTotal > 0 ? "loss" : undefined} />
        </div>

        {creditCards.length > 0 && (
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 font-medium text-left">Card</th>
                  <th className="px-3 py-2 font-medium text-left">Issuer</th>
                  <th className="px-3 py-2 font-medium text-right">Balance</th>
                  <th className="px-3 py-2 font-medium text-left">Notes</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {creditCards.map((c) => (
                  <tr key={c.id} className="hover:bg-[var(--panel2)]">
                    <td className="px-3 py-2"><input className="input text-xs py-1 w-28" value={c.label || ""} onChange={(e) => updateCard(c.id, { label: e.target.value })} /></td>
                    <td className="px-3 py-2"><input className="input text-xs py-1 w-28" value={c.issuer || ""} onChange={(e) => updateCard(c.id, { issuer: e.target.value })} /></td>
                    <td className="px-3 py-2 text-right"><input type="number" className="input num text-xs py-1 w-28 text-right" value={c.balance} onChange={(e) => updateCard(c.id, { balance: +e.target.value || 0 })} /></td>
                    <td className="px-3 py-2"><input className="input text-xs py-1 w-36" value={c.notes || ""} onChange={(e) => updateCard(c.id, { notes: e.target.value })} /></td>
                    <td className="px-3 py-2 text-right"><TwoStepDelete onConfirm={() => removeCard(c.id)} label="Remove card" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
          <div className="text-sm font-medium">Add a credit card</div>
          <div className="flex flex-wrap gap-2 items-end">
            <Field label="Card"><input className="input w-32" placeholder="Everyday Amex" value={cardForm.label} onChange={(e) => setCardForm({ ...cardForm, label: e.target.value })} /></Field>
            <Field label="Issuer"><input className="input w-32" placeholder="Amex" value={cardForm.issuer} onChange={(e) => setCardForm({ ...cardForm, issuer: e.target.value })} /></Field>
            <Field label="Balance owed (£)"><CurrencyInput value={cardForm.balance === "" ? 0 : cardForm.balance} onChange={(v) => setCardForm({ ...cardForm, balance: v })} className="w-32" /></Field>
            <Field label="Notes"><input className="input w-36" placeholder="optional" value={cardForm.notes} onChange={(e) => setCardForm({ ...cardForm, notes: e.target.value })} /></Field>
            <button onClick={addCard} className="btn-accent">Add card</button>
          </div>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Balances here are subtracted from net worth on the Home tab, same as property mortgages and other liabilities. No interest/APR modelling — a balance is what you last entered, not a forecast; update it as statements come in.
          </p>
        </div>
      </div>

      {/* Per-position detail (the Wrapper/Ticker/Qty/cost/price/value table)
          and the allocation/exposure views (concentration, region/sector
          look-through, fund overlap) both moved to Portfolio ▸ Holdings —
          "what do I hold / how am I invested" is a portfolio question, not a
          balance-sheet one. This screen keeps the per-wrapper rollup above;
          the line below is the one-hop link to the detail. */}
      <button
        onClick={() => setTab && setTab("holdings")}
        className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-[var(--panel2)] transition">
        <span className="text-sm">
          <span className="font-medium">Per-holding detail &amp; allocation</span>
          <span className="text-[var(--muted)]"> — every position, plus concentration and region/sector exposure, live on Portfolio ▸ Holdings.</span>
        </span>
        <span className="flex items-center gap-1 text-sm font-medium text-[var(--accent)] shrink-0">Holdings <ArrowRight size={15} aria-hidden="true" /></span>
      </button>

      {/* income strip */}
      {income.total.total > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Income (all wrappers)" value={gbp(income.total.total)} sub="dividends + interest + ERI, gross" />
          <Stat label="of which dividends" value={gbp(income.total.dividends)} />
          <Stat label="of which interest" value={gbp(income.total.interest)} />
          <Stat label="Taxable (GIA only)" value={gbp(income.total.taxableTotal)} sub="what the Income tab computes tax on" />
        </div>
      )}

      <p className="text-xs text-[var(--muted)] leading-relaxed">
        This is the household balance sheet: the per-wrapper rollup and cash above, plus property equity and liabilities (Property &amp; debts sub-tab) and credit cards, summed into one net-worth figure — the same number the Home tab shows. Per-position detail and allocation live on Portfolio ▸ Holdings. Cash balances are per wrapper, entered manually, and count toward net worth. Tax stays gated where it belongs: only GIA holdings feed the CGT and Income tabs, and CGT-exempt instruments are flagged. Same ticker in two wrappers = two independent Section 104 pools, as HMRC requires only for the unsheltered one — sheltered pools reuse the same engine purely for book-cost consistency.
      </p>
    </div>
  );
}

export default WealthTab;
