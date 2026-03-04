/**
 * Mulberry32 - a fast, high-quality 32-bit seeded PRNG.
 * Returns a function that produces values in [0, 1) on each call.
 */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a-inspired hash that turns an arbitrary string into a 32-bit integer.
 * Deterministic: same string always produces the same number.
 */
export function hashCode(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Convenience: get a seeded random value in [0, 1) for a given key combination.
 * Useful for one-shot lookups where you don't need a stateful generator.
 */
export function seededRandom(...parts: (string | number)[]): number {
  const seed = hashCode(parts.join('/'));
  return mulberry32(seed)();
}
