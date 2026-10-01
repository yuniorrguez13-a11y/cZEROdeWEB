// Read-only access to the old web vault (IndexedDB czeroode_db); never creates it.
// Owner: B (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** Injects an IDBFactory (tests). */
export function setIdb(factory) {
  throw new CzdError('not-implemented');
}

/** -> null|{notes, files, playlists}. */
export async function probeOldVault() {
  throw new CzdError('not-implemented');
}

/** -> [{store:'vault'|'files', id, name, kind, size, date, chunked, unlocked}]. */
export async function listOldItems() {
  throw new CzdError('not-implemented');
}

/** -> ids newly unlocked. */
export async function tryPin(pin) {
  throw new CzdError('not-implemented');
}

/** Drops every remembered old PIN/key. */
export function forgetPins() {
  throw new CzdError('not-implemented');
}

/** -> {name, type, mtime, blob} | {note:{title, body}, plaintextNote?:boolean}. */
export async function decodeOldItem(id) {
  throw new CzdError('not-implemented');
}

/** -> [{id, name, itemIds}]. */
export async function listOldPlaylists() {
  throw new CzdError('not-implemented');
}

/** Deletes czeroode_db (only after the user confirms). */
export async function deleteOldDb() {
  throw new CzdError('not-implemented');
}
