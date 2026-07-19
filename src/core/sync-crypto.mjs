/* ======================================================================
   SYNC CRYPTO — end-to-end encryption for the optional sync/backup
   feature. The server (api/sync.mjs → Vercel Blob) only ever sees the
   envelope this module produces: random salt + IV + AES-256-GCM
   ciphertext. The key derives from the user's passphrase via PBKDF2 and
   NEVER leaves the device; consequently a forgotten passphrase makes the
   server copy unrecoverable BY DESIGN — the UI must say so in plain
   words, and the recovery-kit download exists for exactly this reason.

   Threat-model honesty (stated once, here): the app already keeps the
   full PLAINTEXT dataset in this device's localStorage — that is the
   existing local threat model and sync doesn't change it. What this
   module protects is the data in transit and at rest on the server. The
   passphrase is therefore also stored in localStorage for usability
   (auto-sync without re-typing); anyone who can read that key could
   already read the data itself sitting next to it.

   WebCrypto only (globalThis.crypto.subtle) — works in every evergreen
   browser AND under `node --test` (Node 18+), so the full round-trip is
   node-tested with zero new dependencies. GCM authenticates as well as
   encrypts: a tampered or wrong-passphrase envelope fails loudly, it
   can never silently decrypt to garbage state.
   ====================================================================== */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const ENVELOPE_VERSION = 1;
export const PBKDF2_ITERATIONS = 600000; // OWASP 2023+ guidance for SHA-256

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Readable, unguessable sync id: 16 random bytes, hex, dash-grouped.
// 128 bits — the blob path is unguessable even before the encryption.
export function randomSyncId(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{8}/g).join("-");
}

export const isValidSyncId = (s) => /^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/.test(String(s || "").trim().toLowerCase());

async function deriveKey(passphrase, saltBytes, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// obj -> envelope { v, iter, salt, iv, ct, savedAt, device } (all JSON-safe).
// Fresh random salt+IV per encryption — never reused across pushes.
export async function encryptState(obj, passphrase, { savedAt, device = "" } = {}) {
  if (!passphrase || passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plaintext = enc.encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    v: ENVELOPE_VERSION,
    iter: PBKDF2_ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(ct),
    savedAt: savedAt || new Date().toISOString(),
    device,
  };
}

// envelope -> obj. Throws on wrong passphrase or tampering (GCM auth tag).
export async function decryptState(envelope, passphrase) {
  if (!envelope || envelope.v !== ENVELOPE_VERSION) throw new Error("Unrecognised sync envelope version.");
  const key = await deriveKey(passphrase, unb64(envelope.salt), envelope.iter || PBKDF2_ITERATIONS);
  let plainBuf;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.iv) }, key, unb64(envelope.ct));
  } catch {
    throw new Error("Couldn't decrypt — wrong passphrase, or the data was corrupted in storage.");
  }
  return JSON.parse(dec.decode(plainBuf));
}

// Last-writer-wins decision, pure and tested: apply the remote copy only
// when it's genuinely newer than the last write THIS device has seen.
// Equal timestamps (same write echoed back) and older remotes are no-ops.
// Stable content fingerprint of the plaintext state, used to skip pushing
// data the server already has. It must be computed on the PLAINTEXT: every
// encryptState() call draws a fresh random salt and IV, so two encryptions
// of identical data produce completely different ciphertext and comparing
// envelopes would never detect "nothing changed".
// Key order is normalised so a re-serialisation with different insertion
// order isn't mistaken for a real edit.
export async function stateFingerprint(state, cryptoImpl = globalThis.crypto) {
  const keys = Object.keys(state || {}).sort();
  const canonical = JSON.stringify(keys.map((k) => [k, state[k]]));
  const digest = await cryptoImpl.subtle.digest("SHA-256", enc.encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function shouldApplyRemote(localSavedAt, remoteSavedAt) {
  if (!remoteSavedAt) return false;
  if (!localSavedAt) return true;
  return remoteSavedAt > localSavedAt;
}
