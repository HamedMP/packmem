/**
 * Skeleton lines. Each original line becomes one of:
 *   J<json>    the record, with long strings replaced by "\u0000<hash>" references
 *   V<text>    the line as written (not JSON, or JSON that does not re-serialise to the same bytes)
 *   B<base64>  the line as written, when its bytes are not valid UTF-8
 * and the skeleton ends with T{"lines":n,"newline":bool}, so the final newline is restored exactly.
 */
export const REF = "\u0000";
const MAX_DEPTH = 256;

class Unstorable extends Error {}

/** The parsed value when JSON.stringify(JSON.parse(line)) === line; otherwise undefined. */
export function canonical(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  return JSON.stringify(value) === line ? value : undefined;
}

/**
 * Replaces every string the interner accepts with a reference. Strings that start with REF always go to the
 * interner, so a reference is never ambiguous. Returns undefined when the value is too deep, or when a string
 * that starts with REF had to stay inline; the caller then keeps the line verbatim.
 */
export function strip(value, intern) {
  try {
    return walk(value, "", 0, intern);
  } catch (error) {
    if (error instanceof Unstorable) return undefined;
    throw error;
  }
}

function walk(value, key, depth, intern) {
  if (depth > MAX_DEPTH) throw new Unstorable();
  if (typeof value === "string") {
    const hash = intern(value, key);
    if (hash !== null) return REF + hash;
    if (value.startsWith(REF)) throw new Unstorable();
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, key, depth + 1, intern));
  if (value !== null && typeof value === "object") {
    // fromEntries defines own properties, so a "__proto__" key stays a key instead of changing the prototype.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k, depth + 1, intern)]));
  }
  return value;
}

export function collectRefs(value, out) {
  if (typeof value === "string") {
    if (value.startsWith(REF)) out.add(value.slice(1));
  } else if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectRefs(v, out);
  }
}

export function fill(value, lookup) {
  if (typeof value === "string") return value.startsWith(REF) ? lookup(value.slice(1)) : value;
  if (Array.isArray(value)) return value.map((item) => fill(item, lookup));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, lookup)]));
  return value;
}
