import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptState, decryptState, randomSyncId, isValidSyncId, shouldApplyRemote, stateFingerprint,
} from "../core/sync-crypto.mjs";

const STATE = { "cgt.txns": [{ id: "1", ticker: "VWRL", gbpAmount: 9000 }], "cgt.income": 100000 };
const PASS = "correct horse battery";

test("round-trip: encrypt then decrypt returns deep-equal state", async () => {
  const env = await encryptState(STATE, PASS, { device: "test" });
  assert.equal(env.v, 1);
  assert.ok(env.salt && env.iv && env.ct);
  assert.deepEqual(await decryptState(env, PASS), STATE);
});

test("ciphertext is not plaintext and differs between encryptions (fresh salt/iv)", async () => {
  const a = await encryptState(STATE, PASS);
  const b = await encryptState(STATE, PASS);
  assert.ok(!a.ct.includes("VWRL"));
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
});

test("wrong passphrase throws, never returns garbage", async () => {
  const env = await encryptState(STATE, PASS);
  await assert.rejects(() => decryptState(env, "wrong passphrase"), /wrong passphrase|corrupted/i);
});

test("tampered ciphertext fails the GCM auth check", async () => {
  const env = await encryptState(STATE, PASS);
  const bytes = Uint8Array.from(atob(env.ct), (c) => c.charCodeAt(0));
  bytes[5] ^= 0xff;
  const tampered = { ...env, ct: btoa(String.fromCharCode(...bytes)) };
  await assert.rejects(() => decryptState(tampered, PASS));
});

test("short passphrases are refused at encryption time", async () => {
  await assert.rejects(() => encryptState(STATE, "short"), /at least 8/);
});

test("unknown envelope version is refused", async () => {
  const env = await encryptState(STATE, PASS);
  await assert.rejects(() => decryptState({ ...env, v: 99 }, PASS), /version/);
});

test("sync ids are well-formed, unique, and validated", () => {
  const a = randomSyncId(), b = randomSyncId();
  assert.ok(isValidSyncId(a), a);
  assert.notEqual(a, b);
  assert.equal(isValidSyncId("not-an-id"), false);
  assert.equal(isValidSyncId(""), false);
  assert.equal(isValidSyncId(a.toUpperCase()), true); // case-insensitive entry
});

test("last-writer-wins decision", () => {
  assert.equal(shouldApplyRemote(null, "2026-07-10T10:00:00Z"), true);   // fresh device
  assert.equal(shouldApplyRemote("2026-07-10T10:00:00Z", null), false);  // nothing remote
  assert.equal(shouldApplyRemote("2026-07-10T10:00:00Z", "2026-07-10T10:00:00Z"), false); // own echo
  assert.equal(shouldApplyRemote("2026-07-10T10:00:00Z", "2026-07-10T11:00:00Z"), true);  // remote newer
  assert.equal(shouldApplyRemote("2026-07-10T11:00:00Z", "2026-07-10T10:00:00Z"), false); // remote older
});

/* ---------------- content fingerprint (Blob-operation budget) ---------- */

test("stateFingerprint: same content same hash, regardless of key order", async () => {
  const a = { "cgt.txns": [{ id: 1, t: "VWRL" }], "cgt.cash": { GIA: 500 } };
  const b = { "cgt.cash": { GIA: 500 }, "cgt.txns": [{ id: 1, t: "VWRL" }] };
  assert.equal(await stateFingerprint(a), await stateFingerprint(b));
});

test("stateFingerprint: any real change changes the hash", async () => {
  const base = { "cgt.txns": [{ id: 1, qty: 10 }] };
  const h = await stateFingerprint(base);
  assert.notEqual(h, await stateFingerprint({ "cgt.txns": [{ id: 1, qty: 11 }] }));
  assert.notEqual(h, await stateFingerprint({ "cgt.txns": [{ id: 1, qty: 10 }], "cgt.cash": {} }));
  assert.notEqual(h, await stateFingerprint({}));
});

test("stateFingerprint must read the PLAINTEXT — ciphertext can't detect 'unchanged'", async () => {
  // Two encryptions of identical data differ completely (fresh salt+IV),
  // which is why the skip-unchanged check fingerprints the plaintext.
  const state = { "cgt.txns": [{ id: 1 }] };
  const e1 = await encryptState(state, "correct horse battery", { savedAt: "2026-07-19T10:00:00Z" });
  const e2 = await encryptState(state, "correct horse battery", { savedAt: "2026-07-19T10:00:00Z" });
  assert.notEqual(e1.ct, e2.ct);
  assert.equal(await stateFingerprint(state), await stateFingerprint(state));
});
