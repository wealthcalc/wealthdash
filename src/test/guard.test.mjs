import { test } from "node:test";
import assert from "node:assert/strict";
import { sameOriginOk, takeToken } from "../../api/_lib/guard.mjs";

/* --------------------------- sameOriginOk ----------------------------- */

test("same-origin fetch from the app is allowed", () => {
  assert.equal(sameOriginOk({ "sec-fetch-site": "same-origin", origin: "https://app.example.com", host: "app.example.com" }, "app.example.com"), true);
});

test("direct address-bar hit (sec-fetch-site: none) is allowed", () => {
  assert.equal(sameOriginOk({ "sec-fetch-site": "none" }, "app.example.com"), true);
});

test("cross-site browser request is rejected", () => {
  assert.equal(sameOriginOk({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }, "app.example.com"), false);
});

test("same-site (subdomain) browser request is rejected", () => {
  assert.equal(sameOriginOk({ "sec-fetch-site": "same-site" }, "app.example.com"), false);
});

test("no sec-fetch-site but mismatched origin is rejected", () => {
  assert.equal(sameOriginOk({ origin: "https://evil.example" }, "app.example.com"), false);
});

test("no sec-fetch-site but mismatched referer is rejected", () => {
  assert.equal(sameOriginOk({ referer: "https://evil.example/page" }, "app.example.com"), false);
});

test("matching referer with path is allowed", () => {
  assert.equal(sameOriginOk({ referer: "https://app.example.com/import" }, "app.example.com"), true);
});

test("header-less client (curl, uptime check) is allowed — rate limit is the cap", () => {
  assert.equal(sameOriginOk({}, "app.example.com"), true);
});

test("unparseable origin header is not treated as a match failure", () => {
  assert.equal(sameOriginOk({ origin: "not a url" }, "app.example.com"), true);
});

/* ----------------------------- takeToken ------------------------------ */

const CFG = { perMinute: 30, burst: 15 };

test("full bucket allows and decrements", () => {
  const [ok, left] = takeToken(15, 1000, 1000, CFG);
  assert.equal(ok, true);
  assert.equal(left, 14);
});

test("empty bucket rejects", () => {
  const [ok] = takeToken(0.2, 1000, 1000, CFG);
  assert.equal(ok, false);
});

test("bucket refills with elapsed time at perMinute rate", () => {
  // 0 tokens, 60s later: refill = 30, capped at burst 15 -> allowed, 14 left.
  const [ok, left] = takeToken(0, 0, 60000, CFG);
  assert.equal(ok, true);
  assert.equal(left, 14);
});

test("refill is capped at burst", () => {
  const [, left] = takeToken(15, 0, 3600000, CFG);
  assert.equal(left, 14); // never exceeds burst - 1 after a take
});

test("sustained rate above perMinute settles into rejections", () => {
  // Fire 2 requests/second for 60s against a 30/min bucket: at most
  // burst + perMinute (15 + 30) can succeed.
  let tokens = 15, last = 0, allowed = 0;
  for (let t = 0; t <= 60000; t += 500) {
    const [ok, next] = takeToken(tokens, last, t, CFG);
    if (ok) allowed++;
    tokens = next; last = t;
  }
  assert.ok(allowed <= 46, `allowed ${allowed}`);
  assert.ok(allowed >= 40, `allowed ${allowed}`);
});
