// Value equality for re-checks against stored approval payloads.
//
// Approval payloads live in a jsonb column, and PostgreSQL does not keep the
// order of object keys (it stores them sorted by length, then bytes). A plain
// JSON.stringify comparison therefore reports "changed" for an identical
// object read back from jsonb. Keys are compared in sorted order; array order
// still matters (field display order is data). `undefined` and `null` count as
// the same absent value, as they do after a jsonb round trip.

function canonical(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map(canonical);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
