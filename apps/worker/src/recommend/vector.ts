/**
 * Embedding maths and the compact text formats (TID-067, ADR 0018). Pure functions, no I/O.
 *
 * An entry embedding is stored as base64 text of `[float32 scale][384 x int8]` (388 bytes, 520
 * characters): the vector is scaled to unit length, then each value is `round(x / scale * 127)`
 * with `scale` the largest absolute value. A profile is a unit vector as base64 float32 (1,536
 * bytes). Text, not BLOB, because D1 returns a BLOB as a JSON array of integers (388 numbers per row).
 */
export const DIMS = 384;

/** Bytes of a stored entry embedding: the float32 scale and one int8 per dimension. */
export const EMBEDDING_BYTES = 4 + DIMS;

export function l2norm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] as number) * (v[i] as number);
  return Math.sqrt(s);
}

/** Unit-length copy. A zero vector stays zero. */
export function normalise(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  const n = l2norm(v);
  if (n === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / n;
  return out;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  const d = l2norm(a) * l2norm(b);
  return d === 0 ? 0 : dot / d;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Normalises, quantises to int8 and encodes a model output. Throws on a wrong dimension. */
export function encodeEmbedding(raw: ArrayLike<number>): string {
  if (raw.length !== DIMS) throw new Error(`embedding has ${raw.length} dimensions, not ${DIMS}`);
  const unit = normalise(raw);
  let scale = 0;
  for (let i = 0; i < DIMS; i++) scale = Math.max(scale, Math.abs(unit[i] as number));
  const bytes = new Uint8Array(EMBEDDING_BYTES);
  new DataView(bytes.buffer).setFloat32(0, scale, true);
  if (scale > 0) {
    const q = new Int8Array(bytes.buffer, 4, DIMS);
    for (let i = 0; i < DIMS; i++) q[i] = Math.round(((unit[i] as number) / scale) * 127);
  }
  return toBase64(bytes);
}

/** The dequantised vector (about unit length), or null for text that is not a valid embedding. */
export function decodeEmbedding(text: string | null | undefined): Float32Array | null {
  if (!text) return null;
  const bytes = fromBase64(text);
  if (!bytes || bytes.length !== EMBEDDING_BYTES) return null;
  const scale = new DataView(bytes.buffer).getFloat32(0, true);
  const q = new Int8Array(bytes.buffer, 4, DIMS);
  const out = new Float32Array(DIMS);
  const k = scale / 127;
  for (let i = 0; i < DIMS; i++) out[i] = (q[i] as number) * k;
  return out;
}

/**
 * `profile . embedding` straight from the stored text, without allocating a vector: the hot loop of
 * ranking. Null for text that is not a valid embedding. Both are unit length, so this is the cosine
 * (to within the int8 rounding, about 0.5%).
 */
export function dotEncoded(profile: Float32Array, text: string): number | null {
  if (text.length !== 520) return null;
  let bin: string;
  try {
    bin = atob(text);
  } catch {
    return null;
  }
  if (bin.length !== EMBEDDING_BYTES) return null;
  const head = new Uint8Array(4);
  for (let i = 0; i < 4; i++) head[i] = bin.charCodeAt(i);
  const scale = new DataView(head.buffer).getFloat32(0, true);
  let sum = 0;
  for (let i = 0; i < DIMS; i++) {
    // (c << 24) >> 24 turns an unsigned byte into its signed int8 value.
    sum += (profile[i] as number) * ((bin.charCodeAt(i + 4) << 24) >> 24);
  }
  return (sum * scale) / 127;
}

export function encodeProfile(v: Float32Array): string {
  return toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
}

export function decodeProfile(text: string | null | undefined): Float32Array | null {
  if (!text) return null;
  const bytes = fromBase64(text);
  if (!bytes || bytes.length !== DIMS * 4) return null;
  return new Float32Array(bytes.buffer, 0, DIMS);
}
