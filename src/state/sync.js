/* ======================================================================
   CLIENT SYNC ENGINE — optional, OFF by default, local-first unchanged.

   Data flow: every change already lands in localStorage synchronously
   (appStore's persistence subscription), so this module reads state
   straight from localStorage via PERSIST_KEYS — it needs no store import
   (and so can be imported BY the store without a cycle). Push = encrypt
   the full key→value map (core/sync-crypto.mjs) and POST to /api/sync;
   pull = GET, decrypt, write keys back to localStorage.

   Boot order matters and mirrors the durable-mirror pattern exactly:
   main.jsx awaits bootSyncPull() BEFORE dynamic-importing the app, so a
   newer remote copy is already sitting in localStorage when the store
   reads it synchronously at import time — no mid-session state swap, no
   reload dance on the common path. (Connecting a NEW device mid-session
   does reload, once, deliberately.)

   Conflict policy: last-writer-wins on the envelope's savedAt, with the
   server keeping 14 versions as the undo (api/sync.mjs). The config —
   id, passphrase, device label, lastSyncedAt — lives under its own
   localStorage key, deliberately OUTSIDE PERSIST_KEYS: sync config must
   never sync itself, mirror itself, or land in a backup file.
   ====================================================================== */
import { PERSIST_KEYS } from "./durable.js";
import { encryptState, decryptState, shouldApplyRemote, isValidSyncId } from "../core/sync-crypto.mjs";

const CONFIG_KEY = "cgt.sync";

const lsGet = (k, fallback) => { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };

export function getSyncConfig() {
  return lsGet(CONFIG_KEY, { enabled: false, id: "", passphrase: "", device: "", lastSyncedAt: null });
}
export function setSyncConfig(patch) {
  const next = { ...getSyncConfig(), ...patch };
  lsSet(CONFIG_KEY, next);
  return next;
}
export function disableSync() {
  // Local opt-out only — the encrypted server copy stays (other devices
  // may still use it); the UI says so.
  lsSet(CONFIG_KEY, { enabled: false, id: "", passphrase: "", device: "", lastSyncedAt: null });
}

// Full persisted state as { localStorageKey: value } — the same shape the
// durable mirror stores, read from the same source of truth.
export function collectState() {
  const out = {};
  for (const k of Object.values(PERSIST_KEYS)) {
    const v = lsGet(k, undefined);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function applyState(byLsKey) {
  let n = 0;
  for (const [k, v] of Object.entries(byLsKey)) {
    if (!Object.values(PERSIST_KEYS).includes(k)) continue; // never write unknown keys
    lsSet(k, v); n++;
  }
  return n;
}

/* ------------------------------- push --------------------------------- */

let _pushTimer = null;
let _lastResult = null; // { at, ok, message } for the UI's status line
export const lastSyncResult = () => _lastResult;

export async function pushNow({ id, passphrase, device } = {}) {
  const cfg = getSyncConfig();
  const useId = id ?? cfg.id, usePass = passphrase ?? cfg.passphrase;
  if (!isValidSyncId(useId) || !usePass) throw new Error("Sync isn't configured.");
  const savedAt = new Date().toISOString();
  const envelope = await encryptState(collectState(), usePass, { savedAt, device: device ?? cfg.device });
  const r = await fetch("/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: useId, envelope }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Sync push failed (${r.status}).`);
  setSyncConfig({ lastSyncedAt: savedAt });
  _lastResult = { at: savedAt, ok: true, message: "Pushed to encrypted backup." };
  return { savedAt };
}

// Debounced push, called from the store's persistence subscription on any
// change. Failures are recorded for the UI, never thrown into the app.
export function schedulePush(delayMs = 4000) {
  if (!getSyncConfig().enabled) return;
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    pushNow().catch((e) => { _lastResult = { at: new Date().toISOString(), ok: false, message: e.message }; });
  }, delayMs);
}

/* ------------------------------- pull --------------------------------- */

export async function fetchRemote(id) {
  const r = await fetch(`/api/sync?id=${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Sync fetch failed (${r.status}).`);
  return j;
}

// Connect flow (new device) or explicit restore: fetch, decrypt with the
// SUPPLIED credentials, overwrite local state. Returns key count; caller
// reloads. `force` skips the LWW check (explicit user restore).
export async function pullAndApply({ id, passphrase, force = false }) {
  if (!isValidSyncId(id)) throw new Error("That sync id doesn't look right — expected four dash-separated groups.");
  const envelope = await fetchRemote(id);
  if (!envelope) throw new Error("No data found for that sync id.");
  const cfg = getSyncConfig();
  if (!force && !shouldApplyRemote(cfg.lastSyncedAt, envelope.savedAt)) {
    return { applied: false, reason: "This device already has the latest copy." };
  }
  const state = await decryptState(envelope, passphrase); // throws on wrong passphrase
  const n = applyState(state);
  setSyncConfig({ enabled: true, id, passphrase, lastSyncedAt: envelope.savedAt });
  return { applied: true, keys: n, savedAt: envelope.savedAt };
}

// Boot path (main.jsx, before the app module loads): if sync is enabled
// and the server has a NEWER envelope than this device last saw, apply it
// to localStorage so the store boots from it. Every failure degrades to
// a normal local boot — sync must never be able to brick the app.
export async function bootSyncPull() {
  try {
    const cfg = getSyncConfig();
    if (!cfg.enabled || !isValidSyncId(cfg.id) || !cfg.passphrase) return { pulled: false, reason: "sync off" };
    const envelope = await fetchRemote(cfg.id);
    if (!envelope) return { pulled: false, reason: "nothing remote" };
    if (!shouldApplyRemote(cfg.lastSyncedAt, envelope.savedAt)) return { pulled: false, reason: "local is current" };
    const state = await decryptState(envelope, cfg.passphrase);
    const n = applyState(state);
    setSyncConfig({ lastSyncedAt: envelope.savedAt });
    _lastResult = { at: envelope.savedAt, ok: true, message: `Pulled newer copy from ${envelope.device || "another device"}.` };
    return { pulled: true, keys: n };
  } catch (e) {
    _lastResult = { at: new Date().toISOString(), ok: false, message: e.message };
    return { pulled: false, reason: e.message };
  }
}
