import React, { useState } from "react";
import { CloudUpload, CloudDownload, ShieldCheck, KeyRound, Copy, Power, FileDown, AlertTriangle } from "lucide-react";
import { randomSyncId } from "../core/sync-crypto.mjs";
import {
  getSyncConfig, setSyncConfig, disableSync, pushNow, pullAndApply, lastSyncResult,
} from "../state/sync.js";
import { todayISO } from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";

/* ======================================================================
   BACKUP & SYNC — optional end-to-end-encrypted sync via /api/sync
   (Vercel Blob). Everything readable happens on this device: the
   passphrase-derived key never leaves it, the server stores ciphertext
   under an unguessable id, and 14 versions are kept server-side as the
   undo for last-writer-wins. OFF by default; the app stays fully
   local-first when disabled.
   ====================================================================== */

const Row = ({ children }) => <div className="flex items-center gap-2 flex-wrap">{children}</div>;

function PassphraseWarning() {
  return (
    <p className="text-xs text-[var(--m-bb)] leading-relaxed flex items-start gap-1.5">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>The passphrase is the encryption key. It is never sent anywhere, and there is <em>no reset</em> — a forgotten passphrase makes the server copy permanently unreadable (your local data stays fine). Write it down somewhere real.</span>
    </p>
  );
}

const OVERFLOW_LABEL = {
  txns: "transactions", valuations: "valuation history", netWorthSnapshots: "net-worth history",
  incomeEntries: "dividend/interest ledger", eriEntries: "excess reportable income entries",
};

export default function SyncTab() {
  const storageOverflow = useAppStore((s) => s.storageOverflow);
  const [cfg, setCfg] = useState(getSyncConfig());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // create-flow state
  const [newPass, setNewPass] = useState(""), [newPass2, setNewPass2] = useState("");
  // connect-flow state
  const [joinId, setJoinId] = useState(""), [joinPass, setJoinPass] = useState("");
  const [confirmingDisable, setConfirmingDisable] = useState(false);

  const refresh = () => setCfg(getSyncConfig());
  const flash = (m) => setMsg(m);

  const createSync = async () => {
    if (newPass.length < 8) { flash("Passphrase needs at least 8 characters."); return; }
    if (newPass !== newPass2) { flash("Passphrases don't match."); return; }
    setBusy(true); setMsg("");
    try {
      const id = randomSyncId();
      setSyncConfig({ enabled: true, id, passphrase: newPass, device: navigator.platform || "this device", lastSyncedAt: null });
      await pushNow();
      refresh(); setNewPass(""); setNewPass2("");
      flash("Sync created and first encrypted push done. Save the recovery kit below, then connect your other devices with the sync id + passphrase.");
    } catch (e) {
      disableSync(); refresh();
      flash(`Couldn't create sync: ${e.message}`);
    }
    setBusy(false);
  };

  const connect = async () => {
    setBusy(true); setMsg("");
    try {
      const res = await pullAndApply({ id: joinId.trim().toLowerCase(), passphrase: joinPass, force: true });
      flash(`Connected — restored ${res.keys} data sets from the encrypted copy. Reloading…`);
      setTimeout(() => window.location.reload(), 800);
    } catch (e) { flash(e.message); setBusy(false); }
  };

  const syncNow = async () => {
    setBusy(true); setMsg("");
    try { const r = await pushNow(); flash(`Pushed encrypted state (${r.savedAt}).`); }
    catch (e) { flash(e.message); }
    refresh(); setBusy(false);
  };

  const restoreLatest = async () => {
    setBusy(true); setMsg("");
    try {
      const res = await pullAndApply({ id: cfg.id, passphrase: cfg.passphrase, force: true });
      flash(res.applied ? "Restored the server copy. Reloading…" : res.reason);
      if (res.applied) setTimeout(() => window.location.reload(), 800);
      else setBusy(false);
    } catch (e) { flash(e.message); setBusy(false); }
  };

  const copyId = async () => { try { await navigator.clipboard.writeText(cfg.id); flash("Sync id copied."); } catch { flash("Couldn't copy — select it manually."); } };

  const recoveryKit = () => {
    const text = [
      "WEALTH DASHBOARD — SYNC RECOVERY KIT", "",
      `Sync id:   ${cfg.id}`,
      `Created:   ${todayISO()}`,
      `App:       ${window.location.origin}`, "",
      "Your PASSPHRASE is deliberately NOT in this file — store it in a",
      "password manager or on paper. To recover on any device: open the app,",
      "Data → Backup & sync → Connect this device, enter the id above plus",
      "your passphrase. Without the passphrase the encrypted copy cannot be",
      "read by anyone — including you, and including the server.",
    ].join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `sync-recovery-kit-${todayISO()}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const last = lastSyncResult();

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
        <div className="text-sm font-semibold flex items-center gap-1.5"><ShieldCheck size={15} className="text-[var(--accent)]" /> Backup &amp; sync — end-to-end encrypted</div>
        <p className="text-xs text-[var(--muted)] leading-relaxed">
          Optional. Encrypts your entire dataset ON THIS DEVICE (AES-256-GCM, key derived from your passphrase) and stores only the ciphertext on the server, under a random id. The server — and whoever runs it — can never read it. Newest copy wins across devices; the server keeps 14 versions as an undo. When off, nothing leaves this browser, exactly as before.
        </p>
        <p className="text-xs text-[var(--muted)] leading-relaxed">
          Pushes are batched 30 seconds after your last change (and immediately when you leave the tab), skipped entirely when nothing has actually changed, and write a restore point once a day rather than every save. That keeps a normal day inside a handful of Vercel Blob operations — the free tier allows 2,000 a month, and an earlier version could spend a month's worth in an afternoon of editing.
        </p>
        {msg && <div role="status" className="text-xs rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2">{msg}</div>}
      </div>

      {storageOverflow.length > 0 && (
        <div role="status" className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 text-xs text-[var(--muted)] leading-relaxed flex items-start gap-1.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--m-bb)]" aria-hidden="true" />
          <span>
            Your {storageOverflow.map((k) => OVERFLOW_LABEL[k] || k).join(", ")} {storageOverflow.length > 1 ? "have" : "has"} grown past what the browser's quick-access storage (localStorage) can hold on this device. Nothing is lost — the full data is kept in this browser's larger IndexedDB store instead, and (if enabled above) synced normally. This only affects how it's cached locally, not what's saved.
          </span>
        </div>
      )}

      {!cfg.enabled && (
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
            <div className="text-sm font-semibold flex items-center gap-1.5"><KeyRound size={15} className="text-[var(--accent)]" /> Create a new sync</div>
            <p className="text-xs text-[var(--muted)]">First device: pick a passphrase, get a sync id, push the first encrypted copy.</p>
            <input type="password" className="input w-full" placeholder="Passphrase (min 8 characters)" value={newPass} onChange={(e) => setNewPass(e.target.value)} aria-label="New sync passphrase" />
            <input type="password" className="input w-full" placeholder="Repeat passphrase" value={newPass2} onChange={(e) => setNewPass2(e.target.value)} aria-label="Repeat passphrase" />
            <PassphraseWarning />
            <button onClick={createSync} disabled={busy} className="btn-accent disabled:opacity-50"><CloudUpload size={14} /> Create &amp; push</button>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
            <div className="text-sm font-semibold flex items-center gap-1.5"><CloudDownload size={15} className="text-[var(--accent)]" /> Connect this device</div>
            <p className="text-xs text-[var(--muted)]">Already synced elsewhere? Enter that sync id and passphrase. <span className="font-medium text-[var(--m-bb)]">This replaces everything currently on this device</span> with the synced copy.</p>
            <input className="input w-full font-mono text-xs" placeholder="xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx" value={joinId} onChange={(e) => setJoinId(e.target.value)} aria-label="Sync id" />
            <input type="password" className="input w-full" placeholder="Passphrase" value={joinPass} onChange={(e) => setJoinPass(e.target.value)} aria-label="Sync passphrase" />
            <button onClick={connect} disabled={busy || !joinId || !joinPass} className="btn-accent disabled:opacity-50"><CloudDownload size={14} /> Connect &amp; restore</button>
          </div>
        </div>
      )}

      {cfg.enabled && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
          <Row>
            <span className="text-xs text-[var(--muted)]">Sync id</span>
            <code className="text-xs font-mono px-2 py-1 rounded bg-[var(--panel2)] border border-[var(--border)]">{cfg.id}</code>
            <button onClick={copyId} className="text-[var(--muted)] hover:text-[var(--fg)]" title="Copy sync id" aria-label="Copy sync id"><Copy size={13} /></button>
          </Row>
          <div className="text-xs text-[var(--muted)]">
            Last synced: <span className="num">{cfg.lastSyncedAt || "never"}</span>
            {last && <span className={last.ok ? "" : " text-[var(--loss)]"}> · {last.message}</span>}
            <span> · pushes automatically a few seconds after any change.</span>
          </div>
          <Row>
            <button onClick={syncNow} disabled={busy} className="btn-accent disabled:opacity-50"><CloudUpload size={14} /> Sync now</button>
            <button onClick={restoreLatest} disabled={busy} title="Fetch the server copy and overwrite this device with it"
              className="inline-flex items-center gap-1.5 text-sm font-medium px-3 h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)]"><CloudDownload size={14} /> Restore from server</button>
            <button onClick={recoveryKit} className="inline-flex items-center gap-1.5 text-sm font-medium px-3 h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)]"><FileDown size={14} /> Recovery kit</button>
            <button onClick={() => { if (confirmingDisable) { disableSync(); refresh(); setConfirmingDisable(false); flash("Sync turned off on this device. The encrypted server copy remains for your other devices."); } else setConfirmingDisable(true); }}
              className={"inline-flex items-center gap-1.5 text-sm font-medium px-3 h-9 rounded-lg border " + (confirmingDisable ? "border-[var(--loss)] text-[var(--loss)]" : "border-[var(--border)] hover:bg-[var(--panel2)]")}>
              <Power size={14} /> {confirmingDisable ? "Click again to confirm" : "Turn off on this device"}
            </button>
          </Row>
          <PassphraseWarning />
        </div>
      )}

      <p className="text-xs text-[var(--muted)] leading-relaxed">
        Requires a Vercel Blob store connected to the deployment (Storage → Blob in the Vercel dashboard) — without one, pushes report that sync isn't set up. The JSON Save/Load backup buttons keep working independently and never include sync credentials.
      </p>
    </div>
  );
}
