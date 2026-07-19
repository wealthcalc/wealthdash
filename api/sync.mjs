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
      const { blobs } = await list({ prefix: `${prefix}latest`, limit: 1 });
      if (!blobs.length) { res.status(404).json({ error: "No sync data for this id yet." }); return; }
      const r = await fetch(blobs[0].url);
      if (!r.ok) throw new Error(`blob fetch ${r.status}`);
      const envelope = await r.json();
      res.status(200).json(envelope);
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
      await put(`${prefix}latest.json`, body, opts);

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
