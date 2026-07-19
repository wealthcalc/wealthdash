import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normaliseMerchant, ruleMatches, categoriseTxn, categoriseAll, learnMerchants,
  uncategorisedGroups, suggestRule,
} from "../core/categorise.mjs";

test("normaliseMerchant strips the noise banks staple onto merchant names", () => {
  // The real point: these all collapse to the SAME key.
  const keys = [
    "TESCO STORES 3155", "TESCO STORES 6241 LONDON GB", "TESCO STORES 0092 ON 04 MAR 25",
  ].map(normaliseMerchant);
  assert.equal(new Set(keys).size, 1, keys.join(" | "));
  assert.equal(keys[0], "tesco stores");
  assert.equal(normaliseMerchant("PRET A MANGER 4471"), "pret a manger");
  assert.equal(normaliseMerchant("AMZNMktplace REF: 402881"), "amznmktplace");
  assert.equal(normaliseMerchant(""), "");
});

test("ruleMatches: each operator, and a bad regex never throws", () => {
  const t = { description: "TESCO STORES 3155", amount: 42.1 };
  assert.equal(ruleMatches({ op: "contains", value: "tesco", categoryId: "g" }, t), true);
  assert.equal(ruleMatches({ op: "startsWith", value: "TES", categoryId: "g" }, t), true);
  assert.equal(ruleMatches({ op: "equals", value: "TESCO STORES 3155", categoryId: "g" }, t), true);
  assert.equal(ruleMatches({ op: "regex", value: "^tesco.*\\d+$", categoryId: "g" }, t), true);
  assert.equal(ruleMatches({ op: "gt", value: 40, categoryId: "g" }, t), true);
  assert.equal(ruleMatches({ op: "lt", value: 40, categoryId: "g" }, t), false);
  assert.equal(ruleMatches({ op: "regex", value: "([unclosed", categoryId: "g" }, t), false);
  // guards
  assert.equal(ruleMatches({ op: "contains", value: "tesco", categoryId: "g", enabled: false }, t), false);
  assert.equal(ruleMatches({ op: "contains", value: "tesco" }, t), false); // no categoryId
});

test("PRECEDENCE: manual beats rules, rules beat merchant memory", () => {
  const rules = [{ id: "r1", op: "contains", value: "TESCO", categoryId: "groceries", enabled: true }];
  const merchantMap = { "tesco stores": "learned" };
  const t = { description: "TESCO STORES 3155", amount: 30 };

  assert.deepEqual(categoriseTxn(t, { rules, merchantMap }), { categoryId: "groceries", via: "rule", ruleId: "r1" });
  assert.deepEqual(categoriseTxn({ ...t, manualCategoryId: "mine" }, { rules, merchantMap }),
    { categoryId: "mine", via: "manual", ruleId: null });
  assert.deepEqual(categoriseTxn(t, { rules: [], merchantMap }),
    { categoryId: "learned", via: "merchant", ruleId: null });
  assert.deepEqual(categoriseTxn(t, {}), { categoryId: null, via: null, ruleId: null });
});

test("rules are first-match-wins in order", () => {
  const rules = [
    { id: "r1", op: "contains", value: "COFFEE", categoryId: "coffee", enabled: true },
    { id: "r2", op: "contains", value: "SHOP", categoryId: "shopping", enabled: true },
  ];
  assert.equal(categoriseTxn({ description: "THE COFFEE SHOP" }, { rules }).categoryId, "coffee");
  assert.equal(categoriseTxn({ description: "THE COFFEE SHOP" }, { rules: [rules[1], rules[0]] }).categoryId, "shopping");
});

test("categorisation is DERIVED — editing a rule re-categorises history", () => {
  const txns = [{ id: 1, description: "TESCO 3155", amount: 30 }, { id: 2, description: "PRET 991", amount: 4 }];
  const before = categoriseAll(txns, { rules: [{ id: "r", op: "contains", value: "TESCO", categoryId: "gro", enabled: true }] });
  assert.equal(before[0].categoryId, "gro");
  assert.equal(before[1].categoryId, null);
  // change the rule set, same stored rows → different result, no re-import
  const after = categoriseAll(txns, { rules: [{ id: "r", op: "contains", value: "PRET", categoryId: "fun", enabled: true }] });
  assert.equal(after[0].categoryId, null);
  assert.equal(after[1].categoryId, "fun");
  // and the source rows were not mutated
  assert.equal(txns[0].categoryId, undefined);
});

test("learnMerchants only learns from MANUAL decisions, latest wins", () => {
  const map = learnMerchants([
    { description: "PRET A MANGER 1", manualCategoryId: "food" },
    { description: "PRET A MANGER 2", manualCategoryId: "coffee" }, // corrected
    { description: "TESCO 99", categoryId: "gro" },                 // rule output: ignored
  ]);
  assert.deepEqual(map, { "pret a manger": "coffee" });
});

test("uncategorisedGroups clusters by merchant, biggest money first", () => {
  const groups = uncategorisedGroups([
    { id: 1, description: "PRET A MANGER 1", amount: 4 },
    { id: 2, description: "PRET A MANGER 2", amount: 6 },
    { id: 3, description: "BRITISH GAS 8821", amount: 180 },
    { id: 4, description: "TESCO 1", amount: 30, categoryId: "gro" }, // already done
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].key, "british gas");   // £180 first
  assert.equal(groups[1].count, 2);
  assert.equal(groups[1].total, 10);
  assert.deepEqual(groups[1].ids, [1, 2]);
});

test("suggestRule needs a pattern, not a single data point", () => {
  assert.equal(suggestRule({ key: "pret a manger", count: 1 }, "food"), null);
  assert.equal(suggestRule({ key: "pret a manger", count: 5 }, null), null);
  const r = suggestRule({ key: "pret a manger", count: 5 }, "food");
  assert.deepEqual(r, { field: "description", op: "contains", value: "MANGER", categoryId: "food", enabled: true });
  // no usable token
  assert.equal(suggestRule({ key: "a b c", count: 9 }, "food"), null);
});
