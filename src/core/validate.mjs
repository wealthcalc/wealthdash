/* ======================================================================
   FORM VALIDATION — one small, pure vocabulary for every add-form in the
   app. Node-tested (validate.test.mjs).

   Why this exists: fifteen add-forms shared the same handler shape —

       if (!draft.ticker || !(+draft.quantity > 0)) return;

   — a bare `return` on invalid input. Click "Add", nothing happens, no
   message, no highlighted field. That reads as a broken app rather than a
   missing value, and it was the direct cause of a user being unable to
   register a gilt. The fix for one form (gilt-registry.mjs) is the fix for
   all of them; this module is the shared half so each form only has to
   declare WHICH fields matter and WHAT each must satisfy.

   Usage:
     const r = validateFields(draft, {
       ticker:   [req("Ticker")],
       date:     [isoDate("Date")],
       quantity: [pos("Quantity")],
     });
     if (!r.ok) { setErrors(r.errors); return; }

   Rules are plain functions (value, allValues) -> message | null, checked
   in order; the first failing rule's message is kept per field, so a blank
   field says "required" rather than "isn't a number" AND "must be > 0".
   ====================================================================== */

const blank = (v) => v == null || String(v).trim() === "";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------- rules -------------------------------- */
export const req = (label) => (v) => (blank(v) ? `${label} is required.` : null);

// A number > 0. Blank is reported as required rather than as not-a-number,
// because that's what the user actually did.
export const pos = (label) => (v) =>
  blank(v) ? `${label} is required.`
    : !Number.isFinite(+v) ? `${label} isn't a number.`
      : !(+v > 0) ? `${label} must be more than 0.` : null;

// A number >= 0; blank is allowed (caller adds req() if it isn't).
export const nonNeg = (label) => (v) =>
  blank(v) ? null
    : !Number.isFinite(+v) ? `${label} isn't a number.`
      : +v < 0 ? `${label} can't be negative.` : null;

// Any finite number; blank allowed.
export const numberish = (label) => (v) =>
  blank(v) || Number.isFinite(+v) ? null : `${label} isn't a number — enter 4.25, not 4¼ or 4.25%.`;

export const isoDate = (label) => (v) =>
  blank(v) ? `${label} is required.` : !ISO.test(String(v)) ? `${label}: enter a full date.` : null;

// Optional ISO date (blank allowed).
export const isoDateOpt = (label) => (v) => (blank(v) || ISO.test(String(v)) ? null : `${label}: enter a full date.`);

export const oneOf = (label, options) => (v) =>
  options.includes(v) ? null : `${label} must be one of ${options.join(", ")}.`;

export const maxLen = (label, n) => (v) => (String(v ?? "").length > n ? `${label} is too long (max ${n} characters).` : null);

// Cross-field: a date that must not be before another field's date.
export const notBefore = (label, otherField, otherLabel) => (v, all) =>
  !blank(v) && !blank(all?.[otherField]) && String(v) < String(all[otherField])
    ? `${label} can't be before ${otherLabel}.` : null;

/* ------------------------------ runner -------------------------------- */
// { ok, errors: { field: message }, first: message|null }
export function validateFields(values = {}, rules = {}) {
  const errors = {};
  for (const [field, fns] of Object.entries(rules)) {
    for (const fn of Array.isArray(fns) ? fns : [fns]) {
      const msg = fn(values[field], values);
      if (msg) { errors[field] = msg; break; }
    }
  }
  const keys = Object.keys(errors);
  return { ok: keys.length === 0, errors, first: keys.length ? errors[keys[0]] : null };
}

// Flattened, de-duplicated messages in field order — for a single inline
// summary under a form whose fields aren't individually decorated.
export function errorMessages(errors = {}) {
  return [...new Set(Object.values(errors).filter(Boolean))];
}
