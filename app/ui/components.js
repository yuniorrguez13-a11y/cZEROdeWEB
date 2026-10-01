// Shared UI components.
// Owner: C1 (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** The ONLY allowed secret input. mode 'new'|'enter'; purpose 'vault'|'send'|'text'|'unlock'|'open'|'legacy'|'change'. */
export function passphraseField({ label, mode, purpose, generateWords = 0, autocomplete, onChange, onSubmit }) {
  throw new CzdError('not-implemented');
}

/** -> off(). */
export function dropZone(target, { onFiles, multiple = true, folders = false }) {
  throw new CzdError('not-implemented');
}

/** -> {el, update(done), done(msg), fail(msg), onCancel(fn)}. */
export function progressRow({ name, total }) {
  throw new CzdError('not-implemented');
}

/** Icon element for a Kind. */
export function kindIcon(kind) {
  throw new CzdError('not-implemented');
}

/** Empty-state block. */
export function emptyState({ icon, title, text, action }) {
  throw new CzdError('not-implemented');
}

/** Storage usage bar for vault.storage() info. */
export function storageBar(info) {
  throw new CzdError('not-implemented');
}

/** -> {el, set(v)}. */
export function segmented({ options, value, onChange, label }) {
  throw new CzdError('not-implemented');
}

/** items: [{label, icon, onClick, danger, hidden}]; -> off(). */
export function menu(button, items) {
  throw new CzdError('not-implemented');
}

/** -> el. */
export function banner({ kind, text, actions, onDismiss }) {
  throw new CzdError('not-implemented');
}

/** -> {el, update(pass, {generated})}. */
export function strengthMeter() {
  throw new CzdError('not-implemented');
}

/** -> el. */
export function copyButton(getText, { secret = false, label }) {
  throw new CzdError('not-implemented');
}

/** -> el with per-char .geo/.cyr spans. */
export function stealthText(text) {
  throw new CzdError('not-implemented');
}
