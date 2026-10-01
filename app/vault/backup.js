// Backup .czb v1 (DESIGN §3.7, normative):
//   magic 89 43 5A 42 0D 0A 1A 0A | ver u8 = 1 | flags u8 = 0
//   vaultRec  vaultId16 | kdfId u8 | m u32 | t u32 | p u8 | salt16 | iv12 | ct48 | hasRecovery u8 | [riv12 | rct48] | floor u8
//   createdAt u64 (ms) | count u32 (≤ 2,000,000)
//   count × entry (93 B): kind u8 (1 item, 2 list, 3 thumb) | id16 | containerLen u64 | headerMAC32 | recLen u32 | recSHA256[32]
//   entriesMAC[32] = HMAC-SHA256(backupKey, every byte from the magic through the last entry)
//   records (entry order; each the IDB record's iv12 ‖ enc verbatim), then the item containers (item-entry order, verbatim)
// Readers check every bound before allocating, verify entriesMAC before using anything, each record against its hash
// and each container's header MAC against its entry. The vault's key model (VMK unwrap, index records) comes from
// vault.js through ctx.km, so this module has no import cycle.

import { CzdError, toCzdError } from '../errors.js';
import { KDF_ARGON2ID, checkParams, passphraseBytes } from '../crypto/kdf.js';
import { containerSize, decryptSource, encryptStream, openHeader, openSource, parseHeader, readHeaderBytes, release, vaultStanza } from '../crypto/container.js';
import { concat, ctEqual, fromB64, randomBytes, readU32, toB64, toHex, u32, u64, utf8, zeroize } from '../util/bytes.js';
import { abortable } from '../util/stream.js';

/** .czb magic ("\x89CZB\r\n\x1a\n"). Extra over §10 (file sniffing). */
export const CZB_MAGIC = new Uint8Array([0x89, 0x43, 0x5a, 0x42, 0x0d, 0x0a, 0x1a, 0x0a]);

const VERSION = 1;
const ITEM = 1;
const LIST = 2;
const THUMB = 3;
const STORE_OF = Object.freeze({ [ITEM]: 'items', [LIST]: 'lists', [THUMB]: 'thumbs' });
const ENTRY_LEN = 93;
const MAX_COUNT = 2_000_000;
const MAX_REC = 2 ** 20;
const MIN_REC = 12 + 16; // iv + GCM tag
/** Smallest possible czd2 container (empty payload, one stanza, minimum metadata). */
const MIN_CONTAINER = 28 + 3 + 16 + 272 + 32 + 16;
/** Fixed header bytes before the entries (with the recovery wrap). */
const HEAD_MAX = 8 + 2 + 16 + 1 + 4 + 4 + 1 + 16 + 12 + 48 + 1 + 60 + 1 + 8 + 4;
const BATCH = 64;
const RECORD_WINDOW = 4 * 2 ** 20;
const ZERO32 = new Uint8Array(32);
// Container errors that mean the backup's container is not the one its entry describes.
const FORMAT = new Set(['not-czd2', 'short-header', 'unsupported-version', 'unknown-flags', 'bad-chunk-size', 'bad-stanza-count', 'too-many-stanzas',
  'bad-stanza', 'bad-meta', 'no-usable-stanza', 'other-vault', 'item-mismatch', 'vault-unwrap-failed', 'header-mac', 'meta-auth', 'size-mismatch',
  'truncated', 'truncated-or-corrupt', 'chunk-auth', 'bad-padding', 'trailing-data', 'unsupported-kdf', 'kdf-params-out-of-range']);

const subtle = () => globalThis.crypto.subtle;

/**
 * True when the first 8 bytes are the .czb magic. Extra over §10.
 * @param {Uint8Array} first8
 * @returns {boolean}
 */
export function isCzb(first8) {
  if (!(first8 instanceof Uint8Array) || first8.length < 8) return false;
  for (let i = 0; i < 8; i++) if (first8[i] !== CZB_MAGIC[i]) return false;
  return true;
}

async function sha256(bytes) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

function report(onProgress, done, total) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(done, total);
  } catch (e) {
    globalThis.console?.warn?.('[backup] onProgress failed', e);
  }
}

function* batches(list, n) {
  for (let i = 0; i < list.length; i += n) yield list.slice(i, i + n);
}

/** Every key of a vault db store (one readonly transaction). */
function keysOf(db, store) {
  return db.tx([store], 'readonly', (tx) => {
    const r = tx.objectStore(store).getAllKeys();
    return () => r.result;
  });
}

/** Several records of one store in one readonly transaction (undefined for missing keys). */
function getBatch(db, store, keys) {
  return db.tx([store], 'readonly', (tx) => {
    const os = tx.objectStore(store);
    const reqs = keys.map((k) => os.get(k));
    return () => reqs.map((r) => r.result);
  });
}

/** IDB record → its backup bytes (iv12 ‖ enc). */
function recordBytes(rec) {
  if (!(rec?.iv instanceof Uint8Array) || rec.iv.length !== 12 || !(rec.enc instanceof Uint8Array)) {
    throw new CzdError('internal', { detail: `malformed index record ${rec?.id}` });
  }
  return concat(rec.iv, rec.enc);
}

/** Backup bytes → {id, iv, enc}. */
function recordOf(id, bytes) {
  return { id, iv: bytes.slice(0, 12), enc: bytes.slice(12) };
}

function encodeVaultRec(meta) {
  const ok = (x, n) => x instanceof Uint8Array && x.length === n;
  if (!ok(meta.vaultId, 16) || !ok(meta.kdf?.salt, 16) || !ok(meta.wrap?.iv, 12) || !ok(meta.wrap?.ct, 48)
    || (meta.rwrap && (!ok(meta.rwrap.iv, 12) || !ok(meta.rwrap.ct, 48)))) {
    throw new CzdError('internal', { detail: 'malformed vault record' });
  }
  const parts = [meta.vaultId, Uint8Array.of(meta.kdf.id), u32(meta.kdf.m), u32(meta.kdf.t), Uint8Array.of(meta.kdf.p), meta.kdf.salt,
    meta.wrap.iv, meta.wrap.ct, Uint8Array.of(meta.rwrap ? 1 : 0)];
  if (meta.rwrap) parts.push(meta.rwrap.iv, meta.rwrap.ct);
  parts.push(Uint8Array.of(meta.floor ? 1 : 0));
  return concat(...parts);
}

/** magic … last entry (no MAC), written into one buffer (entries can number millions: no spread). */
function encodeHead(vaultRec, createdAt, entries) {
  const out = new Uint8Array(10 + vaultRec.length + 12 + entries.length * ENTRY_LEN);
  out.set(CZB_MAGIC, 0);
  out[8] = VERSION;
  out[9] = 0;
  let o = 10;
  out.set(vaultRec, o);
  o += vaultRec.length;
  out.set(u64(createdAt), o);
  o += 8;
  out.set(u32(entries.length), o);
  o += 4;
  for (const e of entries) {
    out[o] = e.kind;
    out.set(e.id16, o + 1);
    out.set(u64(e.containerLen), o + 17);
    out.set(e.headerMAC, o + 25);
    out.set(u32(e.recLen), o + 57);
    out.set(e.sha, o + 61);
    o += ENTRY_LEN;
  }
  return out;
}

const hexToBytes = (id) => {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(id.slice(2 * i, 2 * i + 2), 16);
  return out;
};

/**
 * Header MAC of a stored item container. With the vault's itemWrapKey the header is fully opened (stanza, MAC,
 * metadata, total length) exactly like a restore will check it; without it only its structure is parsed.
 */
async function storedMac(store, id, id16, itemWrapKey, vaultId, signal) {
  const src = await store.source(id);
  if (!itemWrapKey) return { size: src.size, mac: parseHeader(await readHeaderBytes(src)).mac };
  const opened = await openSource(src, { vault: { wrapKey: itemWrapKey, vaultId, itemId: id16 }, signal });
  release(opened);
  return { size: src.size, mac: opened.mac };
}

/**
 * Pass 1 of an export (extra over §10; vault.exportBackup uses it to know the exact size first): reads every
 * index record in batches, hashes it, finds each item container's length and header MAC, and builds the signed
 * header. Items whose container is missing or damaged are left out (listed in `skipped`): with `itemWrapKey` and
 * `vaultId` every header is opened and its total length checked, so the backup never carries a container that
 * the restore would refuse (which would make the WHOLE backup unrestorable).
 * @param {{db: object, store: object, backupKey: CryptoKey, itemWrapKey?: CryptoKey, vaultId?: Uint8Array, now?: () => number,
 *   signal?: AbortSignal}} ctx
 * @returns {Promise<{prefix: Uint8Array, entries: object[], size: number, createdAt: number, skipped: string[]}>}
 */
export async function planBackup({ db, store, backupKey, itemWrapKey, vaultId, now = () => Date.now(), signal } = {}) {
  const ab = abortable(signal);
  const meta = await db.getMeta();
  if (!meta) throw new CzdError('no-vault');
  const vaultRec = encodeVaultRec(meta);
  const entries = [];
  const skipped = [];
  const items = new Set();
  const add = async (kind, rec, extra) => {
    const bytes = recordBytes(rec);
    if (bytes.length > MAX_REC) throw new CzdError('internal', { detail: `index record ${rec.id} is larger than 1 MiB` });
    entries.push({ kind, id: rec.id, id16: hexToBytes(rec.id), containerLen: 0, headerMAC: ZERO32, recLen: bytes.length, sha: await sha256(bytes), ...extra });
  };
  for (const keys of batches(await keysOf(db, 'items'), BATCH)) {
    ab.checkpoint();
    for (const rec of await getBatch(db, 'items', keys)) {
      if (!rec) continue;
      let found;
      try {
        found = await storedMac(store, rec.id, hexToBytes(rec.id), itemWrapKey, vaultId, signal);
      } catch (e) {
        if (e instanceof CzdError && (e.code === 'item-file-missing' || FORMAT.has(e.code))) {
          skipped.push(rec.id);
          continue;
        }
        throw e;
      }
      await add(ITEM, rec, { containerLen: found.size, headerMAC: found.mac });
      items.add(rec.id);
    }
  }
  for (const keys of batches(await keysOf(db, 'lists'), BATCH)) {
    ab.checkpoint();
    for (const rec of await getBatch(db, 'lists', keys)) if (rec) await add(LIST, rec);
  }
  for (const keys of batches((await keysOf(db, 'thumbs')).filter((k) => items.has(k)), BATCH)) {
    ab.checkpoint();
    for (const rec of await getBatch(db, 'thumbs', keys)) if (rec) await add(THUMB, rec);
  }
  if (entries.length > MAX_COUNT) throw new CzdError('internal', { detail: 'too many records for one backup' });
  const createdAt = now();
  const head = encodeHead(vaultRec, createdAt, entries);
  const mac = new Uint8Array(await subtle().sign('HMAC', backupKey, head));
  const prefix = concat(head, mac);
  let size = prefix.length;
  for (const e of entries) size += e.recLen + e.containerLen;
  return { prefix, entries, size, createdAt, skipped };
}

/**
 * Yields the .czb bytes (pass 2): the signed header, every record re-read and checked against its pass-1 hash
 * (a change in between → 'vault-changed'), then the containers verbatim.
 * ctx: {db, store, plan?, backupKey (when no plan), now?, signal?, onProgress?(done, total)}.
 * @param {object} ctx
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* writeBackup(ctx) {
  const plan = ctx.plan ?? (await planBackup(ctx));
  const ab = abortable(ctx.signal);
  let done = 0;
  const step = (n) => {
    done += n;
    report(ctx.onProgress, done, plan.size);
  };
  yield plan.prefix.slice();
  step(plan.prefix.length);
  const list = plan.entries;
  for (let i = 0; i < list.length;) {
    const kind = list[i].kind;
    const group = [];
    while (i < list.length && list[i].kind === kind && group.length < BATCH) group.push(list[i++]);
    ab.checkpoint();
    const recs = await getBatch(ctx.db, STORE_OF[kind], group.map((e) => e.id));
    for (let j = 0; j < group.length; j++) {
      const e = group[j];
      const bytes = recs[j] ? recordBytes(recs[j]) : null;
      if (!bytes || bytes.length !== e.recLen || !ctEqual(await sha256(bytes), e.sha)) throw new CzdError('vault-changed', { detail: `record ${e.id} changed` });
      yield bytes;
      step(bytes.length);
    }
  }
  for (const e of list) {
    if (e.kind !== ITEM) continue;
    ab.checkpoint();
    const src = await ctx.store.source(e.id);
    if (src.size !== e.containerLen) throw new CzdError('vault-changed', { detail: `container ${e.id} changed` });
    let n = 0;
    for await (const piece of src.stream()) {
      ab.checkpoint();
      n += piece.length;
      if (n > e.containerLen) throw new CzdError('vault-changed', { detail: `container ${e.id} changed` });
      yield piece;
      step(piece.length);
    }
    if (n !== e.containerLen) throw new CzdError('vault-changed', { detail: `container ${e.id} changed` });
  }
}

/**
 * Parses a .czb header and entry table with every bound checked (no keys, no KDF). The total length must equal
 * prefix + Σ recLen + Σ containerLen ('czb-truncated' / 'trailing-data').
 * @param {import('../types.js').ByteSource} src
 * @returns {Promise<{version:number, vaultId:Uint8Array, kdf:{id:number,m:number,t:number,p:number,salt:Uint8Array},
 *   wrap:{iv:Uint8Array,ct:Uint8Array}, rwrap:{iv:Uint8Array,ct:Uint8Array}|null, floor:boolean, createdAt:number, count:number,
 *   counts:{items:number,lists:number,thumbs:number}, entries:object[], signed:Uint8Array, entriesMAC:Uint8Array,
 *   prefixLen:number, recordsOffset:number, containersOffset:number, size:number}>}
 */
export async function readBackupHeader(src) {
  if (!src || typeof src.readAt !== 'function' || !Number.isSafeInteger(src.size) || src.size < 0) throw new TypeError('readBackupHeader(): expected a ByteSource');
  try {
    return await parseBackup(src);
  } catch (e) {
    throw e instanceof CzdError ? e : toCzdError(e);
  }
}

async function parseBackup(src) {
  const total = src.size;
  const head = await src.readAt(0, Math.min(total, HEAD_MAX));
  if (!isCzb(head)) throw new CzdError('not-czb');
  if (head.length < 10) throw new CzdError('czb-truncated');
  if (head[8] !== VERSION || head[9] !== 0) throw new CzdError('czb-version', { detail: { version: head[8], flags: head[9] } });
  let o = 10;
  const need = (n) => {
    if (head.length < o + n) throw new CzdError('czb-truncated');
  };
  const take = (n) => head.slice(o, (o += n));
  need(16 + 1 + 4 + 4 + 1 + 16 + 12 + 48 + 1);
  const vaultId = take(16);
  const kdfId = head[o++];
  const m = readU32(head, o);
  const t = readU32(head, o + 4);
  o += 8;
  const p = head[o++];
  const salt = take(16);
  const wrap = { iv: take(12), ct: take(48) };
  const hasRecovery = head[o++];
  if (hasRecovery > 1) throw new CzdError('not-czb', { detail: 'hasRecovery' });
  let rwrap = null;
  if (hasRecovery) {
    need(60);
    rwrap = { iv: take(12), ct: take(48) };
  }
  need(1 + 8 + 4);
  const floor = head[o++];
  if (floor > 1) throw new CzdError('not-czb', { detail: 'floor' });
  const hi = readU32(head, o);
  if (hi > 0x1fffff) throw new CzdError('not-czb', { detail: 'createdAt' });
  const createdAt = hi * 2 ** 32 + readU32(head, o + 4);
  o += 8;
  const count = readU32(head, o);
  o += 4;
  if (kdfId !== KDF_ARGON2ID) throw new CzdError('unsupported-kdf');
  checkParams({ m, t, p });
  if (count > MAX_COUNT) throw new CzdError('not-czb', { detail: 'count' });
  const entriesOff = o;
  const tableLen = count * ENTRY_LEN;
  const prefixLen = entriesOff + tableLen + 32;
  if (prefixLen > total) throw new CzdError('czb-truncated');
  const body = await src.readAt(entriesOff, tableLen + 32);
  const entries = new Array(count);
  const seen = new Set();
  const counts = { items: 0, lists: 0, thumbs: 0 };
  let recSum = 0;
  let contSum = 0;
  for (let i = 0; i < count; i++) {
    const b = i * ENTRY_LEN;
    const kind = body[b];
    if (kind !== ITEM && kind !== LIST && kind !== THUMB) throw new CzdError('not-czb', { detail: `entry ${i} kind` });
    const id16 = body.slice(b + 1, b + 17);
    const lhi = readU32(body, b + 17);
    if (lhi > 0x1fffff) throw new CzdError('not-czb', { detail: `entry ${i} containerLen` });
    const containerLen = lhi * 2 ** 32 + readU32(body, b + 21);
    const headerMAC = body.slice(b + 25, b + 57);
    const recLen = readU32(body, b + 57);
    const sha = body.slice(b + 61, b + 93);
    if (recLen < MIN_REC || recLen > MAX_REC) throw new CzdError('not-czb', { detail: `entry ${i} recLen` });
    if (kind === ITEM) {
      if (containerLen < MIN_CONTAINER) throw new CzdError('not-czb', { detail: `entry ${i} containerLen` });
    } else if (containerLen !== 0 || !ctEqual(headerMAC, ZERO32)) {
      throw new CzdError('not-czb', { detail: `entry ${i} has a container` });
    }
    const id = toHex(id16);
    const key = `${kind}:${id}`;
    if (seen.has(key)) throw new CzdError('not-czb', { detail: `entry ${i} duplicate` });
    seen.add(key);
    counts[kind === ITEM ? 'items' : kind === LIST ? 'lists' : 'thumbs']++;
    entries[i] = { kind, id, id16, containerLen, headerMAC, recLen, sha, recOff: prefixLen + recSum, contOff: 0 };
    recSum += recLen;
    contSum += containerLen;
    if (!Number.isSafeInteger(prefixLen + recSum + contSum)) throw new CzdError('not-czb', { detail: 'lengths' });
  }
  const expected = prefixLen + recSum + contSum;
  if (expected > total) throw new CzdError('czb-truncated');
  if (expected < total) throw new CzdError('trailing-data');
  let off = prefixLen + recSum;
  for (const e of entries) {
    if (e.kind !== ITEM) continue;
    e.contOff = off;
    off += e.containerLen;
  }
  return {
    version: VERSION,
    vaultId,
    kdf: { id: kdfId, m, t, p, salt },
    wrap,
    rwrap,
    floor: floor === 1,
    createdAt,
    count,
    counts,
    entries,
    signed: concat(head.subarray(0, entriesOff), body.subarray(0, tableLen)),
    entriesMAC: body.slice(tableLen),
    prefixLen,
    recordsOffset: prefixLen,
    containersOffset: prefixLen + recSum,
    size: total,
  };
}

/** A ByteSource view of [off, off + len) of another one. */
function subSource(src, off, len) {
  return {
    size: len,
    async readAt(o, n) {
      if (!Number.isSafeInteger(o) || !Number.isSafeInteger(n) || o < 0 || n < 0) throw new TypeError('readAt(): bad range');
      if (o + n > len) throw new CzdError('truncated');
      return src.readAt(off + o, n);
    },
    stream(start = 0, end = len) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new TypeError('stream(): bad range');
      if (end > len) throw new CzdError('truncated');
      return src.stream(off + start, off + end);
    },
  };
}

/** One record's bytes, checked against its entry hash. */
async function readRecord(src, e) {
  const bytes = await src.readAt(e.recOff, e.recLen);
  if (!ctEqual(await sha256(bytes), e.sha)) throw new CzdError('czb-mac', { detail: `record ${e.id} hash` });
  return bytes;
}

/** Every record whose entry passes `want`, read in windows and hash-checked. Map `${kind}:${id}` → bytes. */
async function readRecords(src, hdr, want, ab) {
  const out = new Map();
  let win = null;
  let winOff = 0;
  const end = hdr.containersOffset;
  for (const e of hdr.entries) {
    if (!want(e)) continue;
    ab.checkpoint();
    if (!win || e.recOff < winOff || e.recOff + e.recLen > winOff + win.length) {
      winOff = e.recOff;
      win = await src.readAt(winOff, Math.max(e.recLen, Math.min(RECORD_WINDOW, end - winOff)));
    }
    const bytes = win.slice(e.recOff - winOff, e.recOff - winOff + e.recLen);
    if (!ctEqual(await sha256(bytes), e.sha)) throw new CzdError('czb-mac', { detail: `record ${e.id} hash` });
    out.set(`${e.kind}:${e.id}`, bytes);
  }
  return out;
}

function asCzbMac(e, detail) {
  if (e instanceof CzdError && !FORMAT.has(e.code) && e.code !== 'czb-mac') return e;
  return e instanceof CzdError && e.code === 'czb-mac' ? e : new CzdError('czb-mac', { cause: e, detail });
}

/** Opens a backup container's header with the backup's itemWrapKey; MAC and total length must match the entry. */
async function checkContainer(sub, e, wrapKey, vaultId, signal) {
  let opened;
  try {
    opened = await openHeader(await readHeaderBytes(sub), { vault: { wrapKey, vaultId, itemId: e.id16 }, signal });
  } catch (err) {
    throw asCzbMac(err, `container ${e.id}`);
  }
  if (!ctEqual(opened.mac, e.headerMAC) || containerSize(opened.size, opened.chunkExp, opened.headerLen) !== e.containerLen) {
    release(opened);
    throw new CzdError('czb-mac', { detail: `container ${e.id}` });
  }
  return opened;
}

/**
 * Restores a backup. ctx: {db, store, km (vault.js key model), now, signal?, onProgress?, confirmKdf?, current?:
 * {vaultId, keys} (merge)}. secret: {pass} | {code} (| {code, newPass} for replace). opts.mode: 'replace' | 'merge'.
 * replace → ONE transaction writes meta.vault + every record after all containers are written (any failure deletes
 * them); resolves {added, skipped, addedIds, meta, vmk}. merge → per-item commits (repeatable), then lists;
 * resolves {added, skipped, addedIds}.
 * @returns {Promise<{added:number, skipped:number, addedIds:string[], meta?:object, vmk?:CryptoKey}>}
 */
export async function restore(ctx, src, secret, { mode } = {}) {
  if (mode !== 'replace' && mode !== 'merge') throw new TypeError("restore(): mode must be 'replace' or 'merge'");
  const ab = abortable(ctx.signal);
  const hdr = await readBackupHeader(src);
  let done = 0;
  const step = (n) => {
    done += n;
    report(ctx.onProgress, done, hdr.size);
  };
  const same = mode === 'merge' && Boolean(ctx.current) && ctEqual(hdr.vaultId, ctx.current.vaultId);
  if (mode === 'merge' && !ctx.current) throw new CzdError('vault-locked');
  const unlocked = same ? null : await ctx.km.unlockRecord(hdr, secret, { confirmKdf: ctx.confirmKdf, signal: ctx.signal });
  try {
    const keys = same ? ctx.current.keys : unlocked.keys;
    ab.checkpoint();
    if (!(await subtle().verify('HMAC', keys.backup, hdr.entriesMAC, hdr.signed))) throw new CzdError('czb-mac');
    step(hdr.prefixLen);
    if (mode === 'replace') return await replaceAll(ctx, src, hdr, unlocked, secret, step, ab);
    if (same) return await mergeSame(ctx, src, hdr, step, ab);
    return await mergeOther(ctx, src, hdr, unlocked.keys, step, ab);
  } finally {
    if (unlocked) zeroize(unlocked.raw);
  }
}

async function replaceAll(ctx, src, hdr, unlocked, secret, step, ab) {
  const recs = await readRecords(src, hdr, () => true, ab);
  step(hdr.containersOffset - hdr.recordsOffset);
  const itemIds = hdr.entries.filter((e) => e.kind === ITEM).map((e) => e.id);
  const written = [];
  try {
    for (const e of hdr.entries) {
      if (e.kind !== ITEM) continue;
      ab.checkpoint();
      const sub = subSource(src, e.contOff, e.containerLen);
      release(await checkContainer(sub, e, unlocked.keys.itemWrap, hdr.vaultId, ctx.signal));
      written.push(e.id);
      const n = await ctx.store.write(e.id, sub.stream(), { signal: ctx.signal });
      if (n !== e.containerLen) throw new CzdError('internal', { detail: `wrote ${n} of ${e.containerLen} bytes` });
      step(e.containerLen);
    }
    ab.checkpoint();
    let kdf = hdr.kdf;
    let wrap = hdr.wrap;
    if (secret && typeof secret.code === 'string' && typeof secret.newPass === 'string' && passphraseBytes(secret.newPass).length > 0) {
      ({ kdf, wrap } = await ctx.km.rewrap(unlocked.raw, hdr.vaultId, { m: hdr.kdf.m, t: hdr.kdf.t, p: hdr.kdf.p }, secret.newPass));
    }
    const meta = {
      v: 1,
      vaultId: hdr.vaultId,
      kdf: { id: kdf.id, m: kdf.m, t: kdf.t, p: kdf.p, salt: kdf.salt },
      floor: hdr.floor,
      wrap,
      rwrap: hdr.rwrap,
      storeKind: ctx.store.kind,
      createdAt: ctx.now(),
      lastBackupAt: hdr.createdAt,
    };
    const items = new Set(itemIds);
    const ops = [{ op: 'put', store: 'meta', key: 'vault', value: meta }];
    for (const e of hdr.entries) {
      const rec = recordOf(e.id, recs.get(`${e.kind}:${e.id}`));
      if (e.kind === ITEM) ops.push({ op: 'put', store: 'items', value: { ...rec, storedBytes: e.containerLen } });
      else if (e.kind === LIST) ops.push({ op: 'put', store: 'lists', value: rec });
      else if (items.has(e.id)) ops.push({ op: 'put', store: 'thumbs', value: rec });
    }
    ab.checkpoint();
    // §3.5: vault-record writes happen under navigator.locks 'czd-vault-record' (+ the "no vault yet" compare-and-swap).
    const recordLock = typeof ctx.km.withRecordLock === 'function' ? ctx.km.withRecordLock : (fn) => fn();
    await recordLock(() => ctx.db.commit(ops, { expectWrapCt: null }));
    return { added: itemIds.length, skipped: 0, addedIds: itemIds, meta, vmk: unlocked.vmk };
  } catch (e) {
    await Promise.all(written.map((id) => ctx.store.delete(id).catch(() => {})));
    throw e;
  }
}

async function mergeSame(ctx, src, hdr, step, ab) {
  const haveItems = new Set(await keysOf(ctx.db, 'items'));
  const haveLists = new Set(await keysOf(ctx.db, 'lists'));
  const addIds = new Set(hdr.entries.filter((e) => e.kind === ITEM && !haveItems.has(e.id)).map((e) => e.id));
  const recs = await readRecords(src, hdr, (e) => (e.kind === LIST ? !haveLists.has(e.id) : addIds.has(e.id)), ab);
  step(hdr.containersOffset - hdr.recordsOffset);
  const added = [];
  let skipped = 0;
  for (const e of hdr.entries) {
    if (e.kind !== ITEM) continue;
    if (!addIds.has(e.id)) {
      skipped++;
      step(e.containerLen);
      continue;
    }
    ab.checkpoint();
    const sub = subSource(src, e.contOff, e.containerLen);
    release(await checkContainer(sub, e, ctx.current.keys.itemWrap, hdr.vaultId, ctx.signal));
    let committed = false;
    try {
      const n = await ctx.store.write(e.id, sub.stream(), { signal: ctx.signal });
      if (n !== e.containerLen) throw new CzdError('internal', { detail: `wrote ${n} of ${e.containerLen} bytes` });
      const ops = [{ op: 'put', store: 'items', value: { ...recordOf(e.id, recs.get(`${ITEM}:${e.id}`)), storedBytes: n } }];
      const th = recs.get(`${THUMB}:${e.id}`);
      if (th) ops.push({ op: 'put', store: 'thumbs', value: recordOf(e.id, th) });
      ab.checkpoint();
      await ctx.db.commit(ops);
      committed = true;
      added.push(e.id);
    } finally {
      if (!committed) await ctx.store.delete(e.id).catch(() => {});
    }
    step(e.containerLen);
  }
  const ops = [];
  for (const e of hdr.entries) {
    if (e.kind === LIST && !haveLists.has(e.id)) ops.push({ op: 'put', store: 'lists', value: recordOf(e.id, recs.get(`${LIST}:${e.id}`)) });
  }
  if (ops.length) await ctx.db.commit(ops);
  return { added: added.length, skipped, addedIds: added };
}

/** Decrypts a backup index record (hash-checked) with the backup's indexKey; any problem → czb-mac. */
async function openBackupRecord(ctx, src, e, key, prefix) {
  try {
    return await ctx.km.openRecord(key, prefix, e.id16, recordOf(e.id, await readRecord(src, e)));
  } catch (err) {
    throw asCzbMac(err, `record ${e.id}`);
  }
}

async function mergeOther(ctx, src, hdr, bkeys, step, ab) {
  const { km, db, store } = ctx;
  const cur = ctx.current;
  const prefix = `merged:${toHex(hdr.vaultId)}:`;
  const thumbs = new Map(hdr.entries.filter((e) => e.kind === THUMB).map((e) => [e.id, e]));
  const mapping = new Map();
  const added = [];
  let skipped = 0;
  step(hdr.containersOffset - hdr.recordsOffset);
  for (const e of hdr.entries) {
    if (e.kind !== ITEM) continue;
    ab.checkpoint();
    const kvKey = prefix + e.id;
    const prev = await db.kvGet(kvKey);
    if (typeof prev === 'string') {
      mapping.set(e.id, prev);
      skipped++;
      step(e.containerLen);
      continue;
    }
    let ix;
    try {
      ix = km.sanitizeIndex(km.parseIndex(await openBackupRecord(ctx, src, e, bkeys.index, km.REC.item)));
    } catch (err) {
      throw asCzbMac(err, `record ${e.id}`);
    }
    const sub = subSource(src, e.contOff, e.containerLen);
    const opened = await checkContainer(sub, e, bkeys.itemWrap, hdr.vaultId, ctx.signal);
    const id16 = randomBytes(16);
    const newId = toHex(id16);
    let written = false;
    let committed = false;
    try {
      let expected = null;
      try {
        expected = fromB64(ix.hmac);
      } catch {
        expected = null;
      }
      if (!expected || !ctEqual(expected, e.headerMAC) || opened.size !== ix.size) throw new CzdError('czb-mac', { detail: `record ${e.id} does not match its container` });
      const meta = { name: opened.meta.name, type: opened.meta.type };
      if (opened.meta.mtime !== undefined) meta.mtime = opened.meta.mtime;
      let mac = null;
      const enc = encryptStream(decryptSource(sub, opened, { signal: ctx.signal }), {
        size: opened.size,
        meta,
        signal: ctx.signal,
        stanzasFor: async (fk) => [await vaultStanza(fk, cur.keys.itemWrap, cur.vaultId, id16)],
      });
      const tapped = (async function* tap() {
        for await (const piece of enc) {
          mac ??= piece.slice(piece.length - 32);
          yield piece;
        }
      })();
      written = true;
      let n;
      try {
        n = await store.write(newId, tapped, { signal: ctx.signal });
      } catch (err) {
        throw asCzbMac(err, `container ${e.id}`);
      }
      const hmac = await verifyWritten(store, newId, id16, mac, cur, ctx.signal);
      const nix = { ...ix, hmac };
      let thumbRec = null;
      const te = thumbs.get(e.id);
      if (te && ix.hasThumb) {
        const jpeg = await openBackupRecord(ctx, src, te, bkeys.index, km.REC.thumb);
        thumbRec = { id: newId, ...(await km.sealRecord(cur.keys.index, km.REC.thumb, id16, jpeg)) };
      }
      if (!thumbRec) delete nix.hasThumb;
      const itemRec = { id: newId, ...(await km.sealRecord(cur.keys.index, km.REC.item, id16, utf8(JSON.stringify(nix)))), storedBytes: n };
      const ops = [{ op: 'put', store: 'items', value: itemRec }];
      if (thumbRec) ops.push({ op: 'put', store: 'thumbs', value: thumbRec });
      ops.push({ op: 'put', store: 'kv', key: kvKey, value: newId });
      ab.checkpoint();
      await db.commit(ops);
      committed = true;
      mapping.set(e.id, newId);
      added.push(newId);
    } finally {
      release(opened);
      if (written && !committed) await store.delete(newId).catch(() => {});
    }
    step(e.containerLen);
  }
  const ops = [];
  for (const e of hdr.entries) {
    if (e.kind !== LIST) continue;
    ab.checkpoint();
    const kvKey = prefix + e.id;
    if (typeof (await db.kvGet(kvKey)) === 'string') continue;
    let l;
    try {
      l = km.parseList(await openBackupRecord(ctx, src, e, bkeys.index, km.REC.list));
    } catch (err) {
      throw asCzbMac(err, `record ${e.id}`);
    }
    const itemIds = [...new Set(l.itemIds.map((x) => mapping.get(x)).filter(Boolean))];
    const nl = { name: km.cleanLabel(l.name, 'Album'), itemIds, createdAt: l.createdAt };
    const cover = l.cover ? mapping.get(l.cover) : undefined;
    if (cover && itemIds.includes(cover)) nl.cover = cover;
    const id16 = randomBytes(16);
    const lid = toHex(id16);
    ops.push({ op: 'put', store: 'lists', value: { id: lid, ...(await km.sealRecord(cur.keys.index, km.REC.list, id16, utf8(JSON.stringify(nl)))) } });
    ops.push({ op: 'put', store: 'kv', key: kvKey, value: lid });
  }
  if (ops.length) await db.commit(ops);
  return { added: added.length, skipped, addedIds: added };
}

/** Reads a re-encrypted container back with the current vault keys; its header must be the one produced. -> hmac (base64). */
async function verifyWritten(store, id, id16, mac, cur, signal) {
  const opened = await openSource(await store.source(id), { vault: { wrapKey: cur.keys.itemWrap, vaultId: cur.vaultId, itemId: id16 }, signal });
  try {
    if (!(mac instanceof Uint8Array) || !ctEqual(opened.mac, mac)) throw new CzdError('item-tampered', { detail: 'stored header differs' });
    return toB64(opened.mac);
  } finally {
    release(opened);
  }
}
