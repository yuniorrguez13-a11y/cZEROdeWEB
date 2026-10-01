// Shared helpers for the czd2 container tests: sealing/opening shortcuts and an INDEPENDENT header/payload
// builder (written from DESIGN §3.3, not from container.js) used to craft valid-MAC hostile containers.
import * as C from '../../app/crypto/container.js';
import { collect } from '../../app/util/stream.js';
import { ascii, concat, randomBytes, u16, u32, utf8 } from '../../app/util/bytes.js';

export const FAST = Object.freeze({ m: 64, t: 1, p: 1 });
export const rnd = randomBytes;
const subtle = globalThis.crypto.subtle;

/** Yields `u` in pieces of `sz` bytes. */
export async function* pieces(u, sz = 70001) {
  for (let o = 0; o < u.length; o += sz) yield u.subarray(o, o + sz);
}

export const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;

const kekCache = new Map();
/** One PassKek per passphrase (FAST params) so tests don't re-run Argon2 for every seal. */
export async function passKekFor(pass) {
  if (!kekCache.has(pass)) kekCache.set(pass, await C.makePassKek(pass, FAST));
  return kekCache.get(pass);
}

/** Encrypts `data` with a passphrase stanza (chunkExp 12 = 4 KiB chunks unless given). */
export async function seal(data, { pass = 'pw', chunkExp = 12, meta = { name: 'x.bin', type: 'application/octet-stream' }, stanzasFor } = {}) {
  const pk = stanzasFor ? null : await passKekFor(pass);
  return collect(C.encryptStream(pieces(data), {
    size: data.length, meta, chunkExp, stanzasFor: stanzasFor ?? (async (fk) => [await C.passStanza(fk, pk)]),
  }));
}

/** openHeader + decryptStream over the bytes after the header (5000-byte pieces). */
export async function open(file, opts = { passphrase: 'pw' }) {
  const opened = await C.openHeader(file, opts);
  const pt = await collect(C.decryptStream(pieces(file.subarray(opened.headerLen), 5000), opened));
  return { opened, pt };
}

/** Independent HKDF subkeys (raw HMAC key bytes are 32, as in FORMAT v2). */
export async function subkeys(fileKey, streamSalt) {
  const hk = await subtle.importKey('raw', fileKey, 'HKDF', false, ['deriveBits']);
  const bits = async (label) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: streamSalt, info: ascii(`cZEROde czd2 ${label}`) }, hk, 256));
  const [macRaw, metaRaw, payRaw] = await Promise.all([bits('header mac'), bits('meta'), bits('payload')]);
  return {
    macRaw,
    mac: await subtle.importKey('raw', macRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
    meta: await subtle.importKey('raw', metaRaw, 'AES-GCM', false, ['encrypt', 'decrypt']),
    pay: await subtle.importKey('raw', payRaw, 'AES-GCM', false, ['encrypt', 'decrypt']),
  };
}

export function nonce(i, last) {
  const n = new Uint8Array(12);
  const dv = new DataView(n.buffer);
  dv.setUint32(3, Math.floor(i / 2 ** 32));
  dv.setUint32(7, i >>> 0);
  n[11] = last ? 1 : 0;
  return n;
}

/** Plain padmé from the spec text, for cross-checks. */
export function padmeRef(L) {
  if (L < 2) return L;
  const E = Math.floor(Math.log2(L));
  const S = Math.floor(Math.log2(E)) + 1;
  const m = 2 ** (E - S) - 1;
  return Math.ceil(L / (m + 1)) * (m + 1);
}

/** metaPT = u32 jsonLen | JSON bytes | zeros to a multiple of 256. */
export function metaPT(jsonBytes, total) {
  const len = total ?? Math.ceil((4 + jsonBytes.length) / 256) * 256;
  const out = new Uint8Array(len);
  out.set(u32(jsonBytes.length));
  out.set(jsonBytes, 4);
  return out;
}

/**
 * Builds a container from parts with a known fileKey. Every field can be overridden, and the MAC is
 * always recomputed with the real key, so readers must catch the problem by validation alone.
 * opts: data, size, meta (object) | json (string) | metaPT (bytes), stanzas | pass, chunkExp, version, flags, k,
 *       metaLen, metaNonce, tamperMetaCT, paddedPT (full padded payload), chunkFlags (fn i,n → final flag), extraPayload, macOverride
 */
export async function craft(opts = {}) {
  const fileKey = opts.fileKey ?? rnd(32);
  const streamSalt = opts.streamSalt ?? rnd(16);
  const chunkExp = opts.chunkExp ?? 12;
  const data = opts.data ?? new Uint8Array(0);
  const size = opts.size ?? data.length;
  const keys = await subkeys(fileKey, streamSalt);
  const stanzas = opts.stanzas ?? [await C.passStanza(fileKey, await passKekFor(opts.pass ?? 'pw'))];
  let pt;
  if (opts.metaPT) pt = opts.metaPT;
  else {
    const json = opts.json ?? JSON.stringify(opts.meta ?? { v: 1, name: 'x.bin', type: 'application/octet-stream', size });
    pt = metaPT(utf8(json));
  }
  const metaNonce = opts.metaNonce ?? rnd(12);
  const metaCT = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: metaNonce }, keys.meta, pt));
  if (opts.tamperMetaCT) metaCT[0] ^= 1;
  const parts = [C.MAGIC, new Uint8Array([opts.version ?? 2, opts.flags ?? 0, chunkExp, opts.k ?? stanzas.length]), streamSalt];
  for (const s of stanzas) parts.push(new Uint8Array([s.type]), u16(s.bodyLen ?? s.body.length), s.body);
  parts.push(metaNonce, u32(opts.metaLen ?? metaCT.length), metaCT);
  const body = concat(...parts);
  const mac = opts.macOverride ?? new Uint8Array(await subtle.sign('HMAC', keys.mac, body));
  const CS = 2 ** chunkExp;
  const padded = opts.paddedPT ?? (() => {
    const u = new Uint8Array(padmeRef(Math.max(0, Math.min(size, 2 ** 31))));
    u.set(data.subarray(0, u.length));
    return u;
  })();
  const n = Math.max(1, Math.ceil(padded.length / CS));
  const chunks = [];
  for (let i = 0; i < n; i++) {
    const flag = opts.chunkFlags ? opts.chunkFlags(i, n) : i === n - 1;
    chunks.push(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce(i, flag) }, keys.pay, padded.subarray(i * CS, Math.min(padded.length, (i + 1) * CS)))));
  }
  return { file: concat(body, mac, ...chunks, opts.extraPayload ?? new Uint8Array(0)), fileKey, streamSalt, keys, headerLen: body.length + 32 };
}

/** A passphrase stanza built by hand (any kdfId/params), wrapping fileKey under `kek`. */
export async function rawPassStanza({ fileKey, kek, kdfId = 1, m = FAST.m, t = FAST.t, p = FAST.p, salt = rnd(16) }) {
  const iv = rnd(12);
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ascii('cZEROde czd2 pass') }, kek, fileKey));
  return { type: 1, body: concat(new Uint8Array([kdfId]), u32(m), u32(t), new Uint8Array([p]), salt, iv, wrapped) };
}
