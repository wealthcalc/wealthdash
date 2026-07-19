/* ======================================================================
   TRANSACTION CATEGORISATION — three layers, in strict precedence:

     1. MANUAL: a category set by hand on a specific transaction. Never
        overwritten by anything below. If the user has looked at a row and
        made a decision, no rule gets to second-guess it.
     2. RULES: ordered, first-match-wins patterns ("description contains
        TESCO → Groceries"). Deterministic and inspectable — you can
        always answer "why did this land in Groceries?".
     3. MERCHANT MEMORY: a learned description→category map, built from
        the user's manual decisions. Categorising one "PRET A MANGER 4471"
        teaches every future Pret row, without the user writing a rule.

   Anything that matches none of the three is UNCATEGORISED, which is a
   first-class state, not an error: the UI's job is to make that queue
   small, and inventing a category to make the queue look empty would put
   fictional numbers into a budget people plan around.

   Merchant keys are NORMALISED descriptions: card statements append
   transaction ids, store numbers and dates to the merchant name
   ("AMZNMktplace 402-8817", "TESCO STORES 3155"), so a raw string match
   almost never repeats. normaliseMerchant() strips digits, punctuation,
   card-network noise and location suffixes to get a stable key.

   Pure and node-tested (categorise.test.mjs).
   ====================================================================== */

// Statement noise that is never part of a merchant's identity.
const NOISE = [
  /\bON \d{2}[\s/-]\w{3}[\s/-]\d{2,4}\b/gi,   // "ON 04 MAR 25"
  /\b\d{2}[/-]\d{2}[/-]\d{2,4}\b/g,            // dates
  /\bREF[:\s]*\w*/gi,                          // "REF: 88213", "REF88213", trailing "REF"
  /\bCARD \d+\b/gi,
  /\b(VISA|MASTERCARD|DEBIT|CREDIT|CONTACTLESS|CHIP AND PIN|POS|ATM)\b/gi,
  /\b[A-Z]{2}\d{4,}\b/g,                       // transaction ids
  /\d{3,}/g,                                   // long digit runs (store/txn numbers)
  /\s\d{1,2}\s*$/g,                            // short trailing counter ("PRET A MANGER 2")
];
// Location/country suffixes banks append. Applied repeatedly, since they
// stack ("... LONDON GB") and one pass would leave the inner one behind.
const LOCATION_SUFFIX = /\s+(gb|uk|gbr|london|united kingdom)$/;

// A stable key for "the same merchant". Lower-cased, noise stripped,
// punctuation collapsed. Deliberately keeps SHORT digit groups that are
// part of a brand ("Pizza 2 Go") by only stripping runs of 3+.
export function normaliseMerchant(description = "") {
  let s = String(description).toUpperCase();
  for (const re of NOISE) s = s.replace(re, " ");
  s = s.replace(/[^A-Z0-9&' ]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  // Trailing country/city noise, stripped until none remain.
  let prev;
  do { prev = s; s = s.replace(LOCATION_SUFFIX, "").trim(); } while (s !== prev);
  return s;
}

// rule: { id, field: "description"|"amount", op, value, categoryId, enabled }
// ops: "contains" | "equals" | "startsWith" | "regex" | "gt" | "lt"
// Returns true/false; never throws on a bad regex (user input).
export function ruleMatches(rule, txn) {
  if (!rule || rule.enabled === false || !rule.categoryId) return false;
  const desc = String(txn?.description || "");
  const amt = +txn?.amount || 0;
  const v = rule.value;
  switch (rule.op) {
    case "contains": return !!v && desc.toUpperCase().includes(String(v).toUpperCase());
    case "equals": return desc.trim().toUpperCase() === String(v || "").trim().toUpperCase();
    case "startsWith": return !!v && desc.toUpperCase().startsWith(String(v).toUpperCase());
    case "regex": {
      try { return new RegExp(v, "i").test(desc); } catch { return false; }
    }
    case "gt": return amt > (+v || 0);
    case "lt": return amt < (+v || 0);
    default: return false;
  }
}

// The single decision function. Returns { categoryId, via } where `via` is
// "manual" | "rule" | "merchant" | null — the UI shows this so a
// surprising categorisation is always traceable to its cause.
export function categoriseTxn(txn, { rules = [], merchantMap = {} } = {}) {
  if (txn?.manualCategoryId) return { categoryId: txn.manualCategoryId, via: "manual", ruleId: null };
  for (const r of rules) {
    if (ruleMatches(r, txn)) return { categoryId: r.categoryId, via: "rule", ruleId: r.id };
  }
  const key = normaliseMerchant(txn?.description);
  if (key && merchantMap[key]) return { categoryId: merchantMap[key], via: "merchant", ruleId: null };
  return { categoryId: null, via: null, ruleId: null };
}

// Apply to a list, returning new objects with categoryId/categorisedVia
// resolved. Never mutates the stored rows: categorisation is DERIVED, so
// editing a rule instantly re-categorises history rather than requiring a
// re-import (the alternative — writing categoryId into each row at import
// time — makes rules retroactively useless, which is the whole point of
// having rules).
export function categoriseAll(txns = [], opts = {}) {
  return txns.map((t) => {
    const { categoryId, via, ruleId } = categoriseTxn(t, opts);
    return { ...t, categoryId, categorisedVia: via, categorisedByRule: ruleId };
  });
}

// Build the learned merchant→category map from manual decisions. Later
// decisions win (the user corrected themselves). Only manual choices
// teach the map — learning from rule output would make rules impossible
// to change later, since their past effects would have calcified into
// merchant memory.
export function learnMerchants(txns = []) {
  const map = {};
  for (const t of txns) {
    if (!t?.manualCategoryId) continue;
    const key = normaliseMerchant(t.description);
    if (key) map[key] = t.manualCategoryId;
  }
  return map;
}

// The uncategorised queue, grouped by normalised merchant so the user
// clears "23 Pret transactions" with one decision rather than 23. Sorted
// by total spend: the biggest unexplained money first, since that's what
// actually distorts a budget.
export function uncategorisedGroups(txns = []) {
  const groups = new Map();
  for (const t of txns) {
    if (t?.categoryId) continue;
    const key = normaliseMerchant(t?.description) || "(no description)";
    if (!groups.has(key)) groups.set(key, { key, sample: t?.description || "", count: 0, total: 0, ids: [] });
    const g = groups.get(key);
    g.count++; g.total += +t?.amount || 0; g.ids.push(t.id);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, total: Math.round(g.total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);
}

// Suggest a rule from a manual decision — "you categorised 8 Tesco rows;
// make it a rule?". Returns null when the evidence is thin (a single
// transaction is a decision, not a pattern).
export function suggestRule(group, categoryId, { minCount = 3 } = {}) {
  if (!group || group.count < minCount || !categoryId) return null;
  // Use the longest word-ish token as the contains-pattern: merchant
  // names survive normalisation better than the surrounding noise.
  const token = (group.key || "").split(" ").filter((w) => w.length >= 4).sort((a, b) => b.length - a.length)[0];
  if (!token) return null;
  return { field: "description", op: "contains", value: token.toUpperCase(), categoryId, enabled: true };
}
