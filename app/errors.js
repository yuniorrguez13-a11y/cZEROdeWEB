// Error catalogue for cZEROde 2. Every module throws CzdError with a code from CODES;
// the UI turns codes into short, honest copy with userMessage().

/** Every error code the app may throw. Adding a code requires updating DESIGN §10. */
export const CODES = Object.freeze([
  'not-czd2', 'short-header', 'unsupported-version', 'unknown-flags', 'bad-chunk-size', 'bad-stanza-count', 'too-many-stanzas', 'bad-stanza', 'bad-meta',
  'unsupported-kdf', 'kdf-params-out-of-range', 'kdf-declined', 'kdf-out-of-memory', 'wrong-passphrase', 'no-usable-stanza', 'other-vault', 'item-mismatch',
  'vault-unwrap-failed', 'header-mac', 'meta-auth', 'size-mismatch', 'truncated', 'truncated-or-corrupt', 'chunk-auth', 'bad-padding', 'trailing-data',
  'source-size-mismatch', 'source-larger-than-size', 'aborted',
  'text-preset-unknown', 'not-cz-text',
  'no-vault', 'vault-exists', 'vault-locked', 'vault-changed', 'framed', 'other-tab', 'item-not-found', 'item-file-missing', 'item-tampered', 'quota-exceeded', 'store-unavailable', 'recovery-wrong',
  'not-czb', 'czb-version', 'czb-mac', 'czb-truncated',
  'legacy-not-ciphertext', 'legacy-wrong-pin', 'legacy-missing-chunks', 'legacy-bad-record', 'legacy-no-db',
  'too-big-to-preview', 'unsupported-media', 'picker-needs-gesture', 'share-unavailable', 'interrupted', 'browser-too-old',
  'not-implemented', 'internal',
]);

const CODE_SET = new Set(CODES);

/**
 * The only error type modules throw on purpose.
 * `message` is the bare code (never user copy, never secrets); `detail` is optional debug data.
 */
export class CzdError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {{cause?: unknown, detail?: unknown}} [opts]
   */
  constructor(code, { cause, detail } = {}) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'CzdError';
    this.code = code;
    this.detail = detail;
  }
}

const DAMAGED = 'This file is damaged or incomplete — ask for it again.';
const NOT_CZD = "That's not a cZEROde file (or it's damaged).";
const BAD_BACKUP = 'That backup file is damaged or not a cZEROde backup.';
const CANCELLED = 'Cancelled.';
const GENERIC = 'Something went wrong.';

// §7.1 copy first; the entries after the blank line reuse copy from elsewhere in the spec
// (§1.3, §3.5) or give a plain-language line for codes §7.1 leaves to "unknown".
const MESSAGES = Object.freeze({
  'wrong-passphrase': 'Wrong passphrase. Capital letters matter; spaces at the ends are ignored.',
  'not-czd2': NOT_CZD,
  'short-header': NOT_CZD,
  'truncated': DAMAGED,
  'truncated-or-corrupt': DAMAGED,
  'chunk-auth': DAMAGED,
  'bad-padding': DAMAGED,
  'trailing-data': DAMAGED,
  'header-mac': DAMAGED,
  'meta-auth': DAMAGED,
  'size-mismatch': DAMAGED,
  'item-tampered': "This vault item was changed outside cZEROde and can't be trusted.",
  'quota-exceeded': 'Not enough storage space.',
  'too-big-to-preview': 'Too big to preview on this device — save it instead.',
  'unsupported-media': "This device can't show/play this file type.",
  'kdf-params-out-of-range': 'This file asks for more memory than is safe to use.',
  'kdf-declined': CANCELLED,
  'kdf-out-of-memory': 'Not enough memory on this device.',
  'vault-locked': 'Unlock your vault first.',
  'other-tab': 'cZEROde is open in another tab.',
  'store-unavailable': "This browser can't reach your vault storage (private window?).",
  'legacy-wrong-pin': 'Wrong PIN.',
  'legacy-missing-chunks': 'Parts of this old file are missing.',
  'legacy-bad-record': "This old item is damaged and can't be opened.",
  'legacy-no-db': 'No old cZEROde data was found.',
  'not-czb': BAD_BACKUP,
  'czb-version': BAD_BACKUP,
  'czb-mac': BAD_BACKUP,
  'czb-truncated': BAD_BACKUP,
  'interrupted': 'Interrupted — retry after unlock.',

  'aborted': CANCELLED,
  'vault-changed': 'Vault changed in another tab, try again.',
  'browser-too-old': 'This browser is too old for cZEROde 2.',
  'recovery-wrong': "That recovery code doesn't open this vault.",
  'unsupported-version': 'This file was made by a newer cZEROde — update the app.',
  'unknown-flags': 'This file was made by a newer cZEROde — update the app.',
  'text-preset-unknown': 'This message was made by a newer cZEROde — update the app.',
  'not-cz-text': "That's not a cZEROde message.",
  'legacy-not-ciphertext': "That doesn't look like an old cZEROde message.",
  'share-unavailable': "Sharing isn't available here — save it instead.",
});

/**
 * Plain-language copy for an error or a code (§7.1). Unknown errors → "Something went wrong."
 * @param {unknown} errOrCode a CzdError, any thrown value, or a code string
 * @returns {string}
 */
export function userMessage(errOrCode) {
  const code = typeof errOrCode === 'string' ? errOrCode : toCzdError(errOrCode).code;
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : GENERIC;
}

/**
 * True for user cancellations that the UI should swallow silently:
 * AbortError, CzdError 'aborted' and 'kdf-declined'.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isCancel(e) {
  if (typeof e === 'string') return e === 'aborted' || e === 'kdf-declined';
  if (!e || typeof e !== 'object') return false;
  if (e.name === 'AbortError') return true;
  return e instanceof CzdError && (e.code === 'aborted' || e.code === 'kdf-declined');
}

/**
 * Normalizes anything thrown into a CzdError. CzdErrors pass through unchanged;
 * QuotaExceededError → 'quota-exceeded'; AbortError → 'aborted'; a serialized CzdError
 * (e.g. from a worker: {name:'CzdError', code}) keeps its code; everything else → 'internal'.
 * @param {unknown} e
 * @returns {CzdError}
 */
export function toCzdError(e) {
  if (e instanceof CzdError) return e;
  if (typeof e === 'string' && CODE_SET.has(e)) return new CzdError(e);
  const name = e && typeof e === 'object' ? e.name : undefined;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return new CzdError('quota-exceeded', { cause: e });
  if (name === 'AbortError') return new CzdError('aborted', { cause: e });
  if (name === 'CzdError' && typeof e.code === 'string' && CODE_SET.has(e.code)) return new CzdError(e.code, { cause: e });
  return new CzdError('internal', { cause: e });
}
