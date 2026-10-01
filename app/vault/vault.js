// Vault: the only module UI code uses for vault data (DESIGN §3.5, §4, §10).
// Owner: E (phase 2). Phase-0 stub: exports match DESIGN §10 (+ setVault); methods throw CzdError('not-implemented').

import { CzdError } from '../errors.js';
import { POLICY } from '../crypto/kdf.js';

/**
 * The app's Vault singleton (created by vault/boot.js via setVault). null until boot.
 * Importers see updates through the live binding.
 * @type {Vault|null}
 */
export let vault = null;

/**
 * Sets the singleton (boot.js; tests).
 * @param {Vault|null} v
 */
export function setVault(v) {
  vault = v;
}

/**
 * Events (CustomEvent.detail): 'status' {status} | 'items' {added:[], removed:[], updated:[]} | 'lists' {} | 'job' {running:boolean}.
 */
export class Vault extends EventTarget {
  /**
   * @param {{db: import('../types.js').VaultDb, openStore: Function, policy?: {m:number,t:number,p:number}, thumbnailer?: Function, now?: () => number, isHolder?: () => boolean}} deps
   */
  constructor({ db, openStore, policy = POLICY, thumbnailer, now = () => Date.now(), isHolder = () => true }) {
    super();
    /** @type {'loading'|'none'|'locked'|'unlocked'|'other-tab'|'unavailable'} */
    this.status = 'loading';
    this.kdfParams = null;
    this.lastUnlockMs = null;
    this.lastBackupAt = null;
    this.hasRecovery = false;
    this.storeKind = null;
    this.floor = false;
  }

  /** Reads meta.vault and sets status. */
  async init() {
    throw new CzdError('not-implemented');
  }

  /** -> {ms, recoveryCode|null}. */
  async create(pass, { params, recovery = true } = {}) {
    throw new CzdError('not-implemented');
  }

  /** -> {ms}. Throws wrong-passphrase, other-tab. */
  async unlock(pass, { confirmKdf } = {}) {
    throw new CzdError('not-implemented');
  }

  /** Unlocks with the recovery code and re-wraps with newPass. */
  async unlockWithRecovery(code, newPass) {
    throw new CzdError('not-implemented');
  }

  /** Synchronous: vault.lock(reason) → state.purge(reason). */
  lock(reason) {
    throw new CzdError('not-implemented');
  }

  async changePassphrase(oldPass, newPass) {
    throw new CzdError('not-implemented');
  }

  /** -> code. */
  async setRecovery(pass) {
    throw new CzdError('not-implemented');
  }

  async removeRecovery(pass) {
    throw new CzdError('not-implemented');
  }

  async destroy() {
    throw new CzdError('not-implemented');
  }

  /** Sync; throws vault-locked. -> ItemInfo[]. */
  items() {
    throw new CzdError('not-implemented');
  }

  /** Sync; throws vault-locked. -> ItemInfo. */
  item(id) {
    throw new CzdError('not-implemented');
  }

  /** Sync; throws vault-locked. -> ListInfo[]. */
  lists() {
    throw new CzdError('not-implemented');
  }

  /** Sync; throws vault-locked. -> ListInfo. */
  list(id) {
    throw new CzdError('not-implemented');
  }

  /** Object URL or null; revoked on purge. */
  async thumbUrl(id) {
    throw new CzdError('not-implemented');
  }

  /** -> ItemInfo; thumbnails/posters via thumbnailer. */
  async addFile(file, { name, album, signal, onProgress } = {}) {
    throw new CzdError('not-implemented');
  }

  /** thumbFrom: Blob. -> ItemInfo. */
  async addStream({ name, type, size, mtime }, source, { album, signal, onProgress, thumbFrom } = {}) {
    throw new CzdError('not-implemented');
  }

  async addNote({ title, body }) {
    throw new CzdError('not-implemented');
  }

  /** -> ItemInfo (new id). */
  async saveNote(id, { title, body }) {
    throw new CzdError('not-implemented');
  }

  /** -> {title, body}. */
  async readNote(id) {
    throw new CzdError('not-implemented');
  }

  async rename(id, name) {
    throw new CzdError('not-implemented');
  }

  async setFavorite(id, fav) {
    throw new CzdError('not-implemented');
  }

  async remove(ids) {
    throw new CzdError('not-implemented');
  }

  /** -> {src: ByteSource, opened: Opened, info: ItemInfo}; checks hmac; caller release(opened). */
  async open(id) {
    throw new CzdError('not-implemented');
  }

  /** -> DecryptSource. */
  async sourceFor(id) {
    throw new CzdError('not-implemented');
  }

  /** -> [{name, size, stream: AsyncIterable<Uint8Array>}]; name = real (sanitized) name or '<N> files'. */
  async exportCzd(ids, passKek, { bundle = true, keepDates = false, signal, onProgress }) {
    throw new CzdError('not-implemented');
  }

  async createList({ name, itemIds = [] }) {
    throw new CzdError('not-implemented');
  }

  async updateList(id, { name, itemIds, cover }) {
    throw new CzdError('not-implemented');
  }

  async removeList(id) {
    throw new CzdError('not-implemented');
  }

  /** -> {name, size, stream}. */
  async exportBackup({ signal, onProgress }) {
    throw new CzdError('not-implemented');
  }

  /** -> {sameVault, items, lists, createdAt, hasRecovery}. */
  async inspectBackup(src) {
    throw new CzdError('not-implemented');
  }

  /** secret {pass}|{code}; mode 'replace'|'merge'; -> {added, skipped}. */
  async restoreBackup(src, secret, { mode, signal, onProgress }) {
    throw new CzdError('not-implemented');
  }

  /** -> {count, itemBytes, usage, quota, persisted} (nulls when unknown). */
  async storage() {
    throw new CzdError('not-implemented');
  }

  /** Tab-lock handoff. */
  async useHere() {
    throw new CzdError('not-implemented');
  }
}
