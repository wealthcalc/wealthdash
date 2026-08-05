// Vercel serverless function: encrypted-sync blob store (Vercel Blob).
//
// ZERO-KNOWLEDGE BY CONSTRUCTION: the client only ever sends the envelope
// produced by src/core/sync-crypto.mjs — random salt + IV + AES-256-GCM
// ciphertext. This function stores and returns those bytes verbatim; the
// passphrase-derived key never leaves the device, so nothing readable
// exists server-side even for the deployment's owner. The blob path
// contains the 128-bit random sync id (unguessable), and the content is
// ciphertext anyway — two independent layers.
//
// Layout per sync id:
//   sync/<id>/latest.json          — current envelope (overwritten)
//   sync/<id>/v-<ISO timestamp>.json — version history (pruned to KEEP)
// History exists because last-writer-wins needs an undo: a device with a
// stale clock or a fat-fingered restore can overwrite good data, and the
// versions are how the user climbs back out.
//
//   GET  /api/sync?id=<syncId>            -> envelope JSON | 404
//   POST /api/sync { id, envelope }       -> { ok, savedAt, versions }
//
// Requires a Vercel Blob store connected to the project
// (BLOB_READ_WRITE_TOKEN env var — Vercel dashboard → Storage → Blob →
// Connect). Without it this returns 501 with instructions rather than a
// cryptic crash.

import { put, list, del } from "@vercel/blob";
import { guard } from "./_lib/guard.mjs";

const KEEP_VERSIONS = 14;
const MAX_BYTES = 5 * 1024 * 1024; // a full encrypted state is ~100s of KB; 5MB is generous
const ID_RE = /^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/;

const configured = () => !!process.env.BLOB_READ_WRITE_TOKEN;

/* BLOB OPERATION BUDGET — the server half.
   Vercel bills put/list/del as Advanced Operations (2,000/month on the free
   tier). The client side is already careful (see state/sync.js), but the READ
   path was quietly the biggest spender: every GET called list() to discover
   the latest.json URL, and bootSyncPull runs on EVERY page load. A day of
   reloading a deployed build costs more operations than a month of actual
   edits.

   list() is unnecessary here: the path is fully deterministic
   (sync/<id>/latest.json, written with addRandomSuffix:false), so the public
   URL is derivable. We cache it per sync id in module scope — populated for
   free by put()'s return value on any POST, and by a single list() on a cold
   read that has never seen this id. Warm invocations then cost ZERO advanced
   operations to read: just a plain HTTPS fetch of a public URL, which is
   bandwidth, not an operation. */
const urlCache = new Map(); // syncId -> latest.json public URL

// Blob's CDN can serve a stale copy after an overwrite; a cache-buster makes
// the read authoritative without costing an operation.
const freshFetch = (url) => fetch(`${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`, { cache: "no-store" });

export default async function handler(req, res) {
  // Credential-class endpoint (it holds the user's whole dataset,
  // encrypted or not) — stricter rate limit than the price proxies.
  if (!guard(req, res, { perMinute: 12, burst: 6 })) return;
  if (!configured()) {
    res.status(501).json({ error: "Sync isn't set up on this deployment: create a Blob store in the Vercel dashboard (Storage → Blob) and connect it to this project, then redeploy." });
    return;
  }

  const id = ((req.method === "GET" ? req.query?.id : req.body?.id) ?? "").toString().trim().toLowerCase();
  if (!ID_RE.test(id)) {
    res.status(400).json({ error: "Missing or malformed sync id." });
    return;
  }
  const prefix = `sync/${id}/`;

  try {
    if (req.method === "GET") {
      // Fast path: a URL we already know for this id — no billed operation.
      let url = urlCache.get(id);
      if (url) {
        const r = await freshFetch(url);
        if (r.ok) { res.status(200).json(await r.json()); return; }
        urlCache.delete(id); // stale/deleted — fall through and rediscover
      }
      const { blobs } = await list({ prefix: `${prefix}latest`, limit: 1 });
      if (!blobs.length) { res.status(404).json({ error: "No sync data for this id yet." }); return; }
      urlCache.set(id, blobs[0].url);
      const r = await freshFetch(blobs[0].url);
      if (!r.ok) throw new Error(`blob fetch ${r.status}`);
      res.status(200).json(await r.json());
      return;
    }

    if (req.method === "POST") {
      const envelope = req.body?.envelope;
      if (!envelope || typeof envelope !== "object" || !envelope.ct || !envelope.salt || !envelope.iv) {
        res.status(400).json({ error: "POST body must be { id, envelope } with an encrypted envelope." });
        return;
      }
      const body = JSON.stringify(envelope);
      if (body.length > MAX_BYTES) {
        res.status(413).json({ error: "Encrypted state exceeds the size limit." });
        return;
      }
      const savedAt = envelope.savedAt || new Date().toISOString();
      const opts = { access: "public", addRandomSuffix: false, contentType: "application/json", allowOverwrite: true };
      const saved = await put(`${prefix}latest.json`, body, opts);
      // Free URL discovery: remembering it here means subsequent reads on this
      // warm instance never need a list() to find it.
      if (saved?.url) urlCache.set(id, saved.url);

      // Version history + pruning are the expensive part (put + list + del
      // are all billed Advanced Operations), so they run only when the
      // client asks for a restore point — once per day, see the budget
      // note in state/sync.js. Older clients omit the flag; defaulting to
      // TRUE keeps their history behaviour identical rather than silently
      // dropping restore points for anyone on a stale tab.
      const withVersion = req.body?.withVersion !== false;
      let versions = null;
      if (withVersion) {
        await put(`${prefix}v-${savedAt.replace(/[:.]/g, "-")}.json`, body, opts);
        const { blobs } = await list({ prefix: `${prefix}v-`, limit: 1000 });
        const stale = blobs
          .sort((a, b) => (a.pathname < b.pathname ? -1 : 1)) // ISO order = time order
          .slice(0, Math.max(0, blobs.length - KEEP_VERSIONS));
        if (stale.length) await del(stale.map((b) => b.url));
        versions = Math.min(blobs.length, KEEP_VERSIONS);
      }

      res.status(200).json({ ok: true, savedAt, versions, wroteVersion: withVersion });
      return;
    }

    res.status(405).json({ error: "Use GET ?id=… or POST { id, envelope }." });
  } catch (e) {
    res.status(502).json({ error: (e && e.message) || "Sync storage failed." });
  }
}
