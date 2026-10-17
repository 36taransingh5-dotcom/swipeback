import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted recursively, undefined dropped. Used to hash decision
 * inputs so the same inputs always produce the same inputs_hash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Non-finite number in canonical JSON');
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
