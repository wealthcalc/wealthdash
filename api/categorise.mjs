// Vercel serverless function: suggest budget categories for merchant
// descriptions the rules engine couldn't place.
//
// PRIVACY POSTURE, stated plainly because this is the only endpoint in
// the app that sends personal data anywhere:
//   - Only MERCHANT DESCRIPTIONS and the user's own CATEGORY NAMES leave
//     the device. No amounts, dates, account numbers, balances, or
//     anything identifying the person — a list like ["TESCO STORES 3155",
//     "PRET A MANGER"] is close to public knowledge about high streets.
//   - It runs only on an explicit button press, never on import.
//   - Nothing is stored server-side; the response is generated and
//     forgotten.
//   - Requires ANTHROPIC_API_KEY. Without it this returns 501 with
//     instructions rather than failing cryptically — the rules engine and
//     manual categorisation work fine without ever calling this.
//
// The model is asked to choose ONLY from the user's existing categories
// and to return nothing for merchants it can't place. Inventing a
// category, or guessing at a plausible-sounding one, would put fiction
// into a budget the user plans around — the same "don't fabricate" rule
// the rest of the app follows.
//
//   POST /api/categorise { descriptions: string[], categories: string[] }
//     -> { suggestions: { [description]: categoryName } }

import { guard } from "./_lib/guard.mjs";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_DESCRIPTIONS = 60;

// Tolerate the two invisible ways a pasted env var goes wrong: whitespace
// around the NAME (Vercel accepts "ANTHROPIC_API_KEY " and the dashboard
// renders it identically) and whitespace/newlines around the VALUE. Falls
// back to a trimmed-name lookup before declaring the key missing.
function apiKey() {
  const direct = process.env.ANTHROPIC_API_KEY;
  if (direct && direct.trim()) return direct.trim();
  for (const [k, v] of Object.entries(process.env)) {
    if (k.trim() === "ANTHROPIC_API_KEY" && v && v.trim()) return v.trim();
  }
  return null;
}

// DIAGNOSTIC, names only — never values. Same-origin guarded like every
// other endpoint here. Returned only in the 501 body, so it appears when
// something is already wrong and never in normal operation. Shows the
// name with visible delimiters so a trailing space is actually visible.
function keyDiagnostics() {
  const names = Object.keys(process.env).filter((k) => /anthropic|api[_-]?key/i.test(k));
  return {
    matchingNames: names.map((k) => `[${k}]`),
    exactNamePresent: Object.prototype.hasOwnProperty.call(process.env, "ANTHROPIC_API_KEY"),
    exactNameEmpty: Object.prototype.hasOwnProperty.call(process.env, "ANTHROPIC_API_KEY") && !String(process.env.ANTHROPIC_API_KEY || "").trim(),
    totalEnvKeys: Object.keys(process.env).length,
  };
}

export default async function handler(req, res) {
  if (!guard(req, res, { perMinute: 10, burst: 4 })) return;
  if (req.method !== "POST") { res.status(405).json({ error: "POST only." }); return; }
  const key = apiKey();
  if (!key) {
    const d = keyDiagnostics();
    const hint = d.exactNameEmpty
      ? "The variable EXISTS but its value is empty — re-paste the key."
      : d.matchingNames.length
        ? `No usable ANTHROPIC_API_KEY, but these similar names are visible to the function: ${d.matchingNames.join(", ")} (square brackets show any stray spaces).`
        : `No ANTHROPIC_API_KEY reached this function at all (${d.totalEnvKeys} env vars visible). Check it's on the wealthdash project, ticked for Production, and that a NEW deployment was created after adding it.`;
    res.status(501).json({
      error: `AI suggestions aren't set up on this deployment. ${hint} Rules and manual categorisation work without it.`,
      diagnostics: d,
    });
    return;
  }

  const descriptions = Array.isArray(req.body?.descriptions) ? req.body.descriptions.slice(0, MAX_DESCRIPTIONS).map((s) => String(s).slice(0, 120)) : [];
  const categories = Array.isArray(req.body?.categories) ? req.body.categories.slice(0, 40).map((s) => String(s).slice(0, 60)) : [];
  if (!descriptions.length || !categories.length) {
    res.status(400).json({ error: "Need { descriptions: [...], categories: [...] }." });
    return;
  }

  const prompt = [
    "You are categorising UK bank and credit-card transaction descriptions into a person's own budget categories.",
    "",
    "Their categories (use ONLY these, exactly as written):",
    ...categories.map((c) => `- ${c}`),
    "",
    "Transaction descriptions:",
    ...descriptions.map((d, i) => `${i + 1}. ${d}`),
    "",
    "Return ONLY a JSON object mapping each description string to one category name.",
    "Omit any description you cannot confidently place — a missing entry is much better than a wrong one.",
    "Do not invent categories. Do not add commentary or markdown fences.",
  ].join("\n");

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      res.status(502).json({ error: `Suggestion service returned ${r.status}.`, detail: detail.slice(0, 300) });
      return;
    }
    const data = await r.json();
    const text = (data?.content || []).map((b) => b?.text || "").join("").trim();
    // Tolerate a fenced or prose-wrapped response rather than failing.
    const match = text.match(/\{[\s\S]*\}/);
    let suggestions = {};
    if (match) {
      try { suggestions = JSON.parse(match[0]); } catch { suggestions = {}; }
    }
    // Only pass back suggestions naming a REAL category — the client
    // checks too, but an endpoint shouldn't return output it knows is
    // invalid.
    const allowed = new Set(categories.map((c) => c.toLowerCase()));
    const clean = {};
    for (const [k, v] of Object.entries(suggestions)) {
      if (typeof v === "string" && allowed.has(v.toLowerCase())) clean[k] = v;
    }
    res.status(200).json({ suggestions: clean, model: MODEL, asked: descriptions.length, answered: Object.keys(clean).length });
  } catch (e) {
    res.status(502).json({ error: (e && e.message) || "Suggestion request failed." });
  }
}
