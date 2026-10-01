// Weak-PIN easter egg (DESIGN §1.11, ui-inventory §1.13; copy verbatim).
// Only fields that SET a secret trigger it (create vault, change passphrase, Send "Use my own",
// Text in Encrypt mode) — never unlock/open/decrypt/legacy fields. Debounced so typing "12345678"
// doesn't fire at "123"; passphraseField also limits it to once per focus.

import { TIMES } from '../config.js';
import { h, modal } from '../util/dom.js';
import * as state from '../state.js';
import * as passphrase from '../crypto/passphrase.js';

/** Purposes whose fields set a new secret. */
export const EGG_PURPOSES = Object.freeze(['vault', 'send', 'text', 'change']);
const EGG_PINS = new Set(['123', '1234', '12345']);
const TEXT = 'I knew you were stupid enough to use a short password, but not so much that you used the most common ones in the planet.';

let pending = null; // {timer, resolve}
let open = null; // promise of the skull modal while it is shown

function cancelPending() {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.resolve(false);
  pending = null;
}
// A lock inside the debounce window must not pop the skull over the lock screen.
state.onPurge(cancelPending);

function isEggPin(value) {
  try {
    return passphrase.isEasterEggPin(value) === true;
  } catch {
    return typeof value === 'string' && EGG_PINS.has(value); // exactly, like passphrase.isEasterEggPin
  }
}

/**
 * Debounced check (TIMES.easterDebounceMs): when the latest value is exactly 123/1234/12345 and the
 * purpose sets a secret, shows the skull. Each call replaces the previous pending check; a purge cancels it.
 * Extra over §10: opts.isCurrent() is asked when the debounce ends — false (field cleared, removed,
 * switched to an enter-mode field, value changed) drops the skull.
 * @param {string} value
 * @param {string} purpose
 * @param {{isCurrent?: () => boolean}} [opts]
 * @returns {Promise<boolean>} true when the skull was shown for this call
 */
export function maybeEasterEgg(value, purpose, { isCurrent } = {}) {
  cancelPending();
  if (!EGG_PURPOSES.includes(purpose) || !isEggPin(value)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const p = {
      resolve,
      timer: setTimeout(() => {
        if (pending === p) pending = null;
        let current = true;
        try {
          current = typeof isCurrent !== 'function' || isCurrent() === true;
        } catch {
          current = false;
        }
        if (open || !current) {
          resolve(false);
          return;
        }
        showSkull();
        resolve(true);
      }, TIMES.easterDebounceMs),
    };
    pending = p;
  });
}

/**
 * The weak-PIN modal itself (💀, verbatim text, "ok fine").
 * @returns {Promise<any>} resolves when it is closed
 */
export function showSkull() {
  if (open) return open;
  const p = modal({
    className: 'eg-modal',
    body: h('div', { class: 'eg-box' },
      h('div', { class: 'eg-skull', aria: { hidden: 'true' }, text: '💀' }),
      h('p', { class: 'eg-text', text: TEXT })),
    actions: [{ label: 'ok fine', kind: 'ghost', value: true, autofocus: true }],
  });
  open = p;
  p.then(() => {
    open = null;
  });
  return p;
}
