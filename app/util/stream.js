// ByteSource constructors and async-iterable helpers for streaming byte pipelines.
// Pieces yielded by rechunk/fileChunks are fresh buffers (safe to transfer to a worker).

import { CzdError } from '../errors.js';

const DEFAULT_PIECE = 1 << 18;

/** @param {unknown} x @returns {Uint8Array} */
function asU8(x) {
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  throw new TypeError('expected byte chunks');
}

function checkRange(off, len, size) {
  if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || off < 0 || len < 0) throw new TypeError('readAt(): bad range');
  if (off + len > size) throw new CzdError('truncated');
}

function streamBounds(start, end, size) {
  const a = start ?? 0;
  const b = end ?? size;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < a) throw new TypeError('stream(): bad range');
  if (b > size) throw new CzdError('truncated');
  return [a, b];
}

/**
 * ByteSource over a Blob/File (zero-copy slicing; `.blob` is the original Blob).
 * @param {Blob} blob
 * @returns {import('../types.js').ByteSource}
 */
export function blobSource(blob) {
  const size = blob.size;
  return {
    size,
    blob,
    async readAt(off, len) {
      checkRange(off, len, size);
      if (len === 0) return new Uint8Array(0);
      const out = new Uint8Array(await blob.slice(off, off + len).arrayBuffer());
      if (out.length !== len) throw new CzdError('truncated');
      return out;
    },
    async *stream(start, end) {
      const [a, b] = streamBounds(start, end, size);
      if (a === b) return;
      yield* readerChunks(blob.slice(a, b));
    },
  };
}

/**
 * ByteSource over bytes in memory (the input is not copied; reads return copies).
 * @param {Uint8Array} u8
 * @returns {import('../types.js').ByteSource}
 */
export function bytesSource(u8) {
  const bytes = asU8(u8);
  const size = bytes.length;
  return {
    size,
    async readAt(off, len) {
      checkRange(off, len, size);
      return bytes.slice(off, off + len);
    },
    async *stream(start, end) {
      const [a, b] = streamBounds(start, end, size);
      for (let p = a; p < b; p += DEFAULT_PIECE) yield bytes.slice(p, Math.min(b, p + DEFAULT_PIECE));
    },
  };
}

/**
 * Re-cuts a byte stream into pieces of exactly `size` bytes (the last one may be shorter;
 * an empty input yields nothing). Accepts sync or async iterables of byte chunks.
 * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} iterable
 * @param {number} size
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* rechunk(iterable, size) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new TypeError('rechunk(): size must be a positive integer');
  let buf = null;
  let fill = 0;
  for await (const raw of iterable) {
    const chunk = asU8(raw);
    let p = 0;
    while (p < chunk.length) {
      if (buf === null) buf = new Uint8Array(size);
      const n = Math.min(size - fill, chunk.length - p);
      buf.set(chunk.subarray(p, p + n), fill);
      fill += n;
      p += n;
      if (fill === size) {
        const out = buf;
        buf = null;
        fill = 0;
        yield out;
      }
    }
  }
  if (fill > 0) yield buf.slice(0, fill);
}

async function* readerChunks(blob) {
  const reader = blob.stream().getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { finished = true; return; }
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Reads a Blob as exact-size pieces (blob.stream() + getReader + rechunk).
 * @param {Blob} blob
 * @param {number} [size]
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* fileChunks(blob, size = 1 << 18) {
  yield* rechunk(readerChunks(blob), size);
}

/**
 * Concatenates a byte stream. Throws CzdError('too-big-to-preview') as soon as more than `max`
 * bytes arrive (the source is closed).
 * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} iterable
 * @param {{max?: number}} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function collect(iterable, { max } = {}) {
  const parts = [];
  let total = 0;
  for await (const raw of iterable) {
    const chunk = asU8(raw);
    total += chunk.length;
    if (max !== undefined && total > max) throw new CzdError('too-big-to-preview');
    parts.push(chunk);
  }
  if (parts.length === 1 && parts[0].byteOffset === 0 && parts[0].buffer.byteLength === total) return parts[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Yields the first `n` bytes of a stream, then closes the source.
 * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} iterable
 * @param {number} n
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* take(iterable, n) {
  let left = n;
  if (!(left > 0)) return;
  for await (const raw of iterable) {
    const chunk = asU8(raw);
    if (chunk.length >= left) {
      yield chunk.subarray(0, left);
      return;
    }
    left -= chunk.length;
    yield chunk;
  }
}

/**
 * Passes chunks through unchanged and calls onProgress(doneBytes, total) after the consumer
 * has taken each chunk.
 * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} iterable
 * @param {(done:number, total:number|undefined) => void} onProgress
 * @param {number} [total]
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* withProgress(iterable, onProgress, total) {
  let done = 0;
  for await (const chunk of iterable) {
    done += chunk.byteLength;
    yield chunk;
    if (onProgress) onProgress(done, total);
  }
}

/**
 * Cancellation checkpoints for long loops: `checkpoint()` throws CzdError('aborted')
 * (cause = signal.reason) once `signal` has aborted. A missing signal never aborts.
 * @param {AbortSignal} [signal]
 * @returns {{checkpoint(): void, readonly aborted: boolean}}
 */
export function abortable(signal) {
  return {
    get aborted() {
      return Boolean(signal && signal.aborted);
    },
    checkpoint() {
      if (signal && signal.aborted) throw new CzdError('aborted', { cause: signal.reason });
    },
  };
}
