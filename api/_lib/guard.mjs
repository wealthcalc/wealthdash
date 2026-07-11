// Shared request guard for every /api function: same-origin enforcement +
// a light per-IP rate limit. These proxies exist solely so the app's own
// browser client can reach CORS-less upstreams (Yahoo, IBKR, DMO, Land
// Registry) — nothing else should be calling them. Without a guard the
// endpoints are an open relay anyone can hotlink, spending this
// deployment's Vercel/upstream quota.
//
// Same-origin check, two layers (both header-based, defence in depth, not
// a security boundary against a determined scripter — the rate limit is
// what actually caps abuse):
//   1. `Sec-Fetch-Site` — sent by all evergreen browsers and unforgeable
//      from page JS. Reject anything except "same-origin" (or "none", a
//      direct address-bar hit, which leaks nothing and helps debugging).
//      Absent header (curl, old browsers) falls through to layer 2.
//   2. If an Origin or Referer header IS present, its host must match the
//      request's own host. Absent both (curl again) we allow — blocking
//      header-less clients outright would also block uptime checks, and a
//      curl user can trivially fake any header anyway; that's the rate
//      limit's job.
//
// Rate limit: token bucket per client IP, module-scope Map — meaning per
// WARM LAMBDA INSTANCE, not global. Honest scope: it caps sustained abuse
// through any one instance; a distributed attack gets a fresh bucket per
// cold start. Real global limiting needs KV/Upstash — deliberately not
// added here (no new infra for a personal deployment). Buckets are pruned
// on each call so the Map can't grow unbounded.

const buckets = new Map(); // ip -> { tokens, last }
const PRUNE_AFTER_MS = 10 * 60 * 1000;

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.socket?.remoteAddress || "unknown";
}

function hostOf(urlish) {
  try { return new URL(urlish).host; } catch { return null; }
}

export function sameOriginOk(headers, ownHost) {
  const sfs = headers["sec-fetch-site"];
  if (sfs && sfs !== "same-origin" && sfs !== "none") return false;
  for (const h of ["origin", "referer"]) {
    const v = headers[h];
    if (v) {
      const host = hostOf(v);
      if (host && ownHost && host !== ownHost) return false;
    }
  }
  return true;
}

// Pure token-bucket step, exported for tests: returns [allowed, newTokens].
export function takeToken(tokens, last, now, { perMinute, burst }) {
  const refilled = Math.min(burst, tokens + ((now - last) / 60000) * perMinute);
  return refilled >= 1 ? [true, refilled - 1] : [false, refilled];
}

// Returns true if the request may proceed; otherwise writes the 403/429
// response itself and returns false.
export function guard(req, res, { perMinute = 30, burst = 15 } = {}) {
  res.setHeader("Cache-Control", "no-store");
  if (!sameOriginOk(req.headers, req.headers.host)) {
    res.status(403).json({ error: "This endpoint only serves its own app." });
    return false;
  }
  const now = Date.now();
  const ip = clientIp(req);
  const b = buckets.get(ip) || { tokens: burst, last: now };
  const [allowed, tokens] = takeToken(b.tokens, b.last, now, { perMinute, burst });
  buckets.set(ip, { tokens, last: now });
  if (buckets.size > 500) {
    for (const [k, v] of buckets) if (now - v.last > PRUNE_AFTER_MS) buckets.delete(k);
  }
  if (!allowed) {
    res.status(429).json({ error: "Too many requests — try again shortly." });
    return false;
  }
  return true;
}
