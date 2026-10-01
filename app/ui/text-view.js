// Text screen (route 'text'; DESIGN §1.8, §3.4, §1.11). Owner: V2a.
// One message box. The mode follows what was typed or pasted (textfmt.detectText: the ჶ marker or v4-looking
// stealth text → Decrypt, else Encrypt) unless the Auto · Encrypt · Decrypt control overrides it. One action
// button (Enter in the passphrase field, or Ctrl/⌘+Enter in the message) encrypts into the camouflage script
// (text v2: Argon2id + AES-GCM + key commitment) or decrypts v2 / old v4 messages. Old Mixed Script (v1–v3) is
// pointed to Legacy. The weak-PIN skull and strength meter only show while encrypting. "codzilla" + Encrypt opens
// the Codzilla page. An output belongs to the message and passphrase it came from (editing either drops it).
// Locking clears the message, the output and the passphrase.
// Node-importable: the DOM is only touched inside functions.

import { isCancel, toCzdError, userMessage } from '../errors.js';
import * as state from '../state.js';
import * as platform from '../platform.js';
import * as router from '../router.js';
import { FLOOR } from '../crypto/kdf.js';
import { TEXT_MARKER, decryptText, detectText, encryptText } from '../crypto/textfmt.js';
import { stripWs } from '../crypto/stealth.js';
import { decryptV4Text } from '../legacy/v4.js';
import { announce, confirmDialog, h, icon, toast } from '../util/dom.js';
import { fmtSize } from '../util/format.js';
import { banner, copyButton, passphraseField, segmented, stealthText } from './components.js';

/** Largest message encrypted (UTF-8 bytes) — Text is for messages; files and long texts go through Send. */
const MAX_PLAIN = 2 ** 20;
/** Largest ciphertext decrypted (characters): a MAX_PLAIN message is about 1.4 M stealth characters. */
const MAX_CIPHER = 2 * 2 ** 20;
const DETECT_MS = 120;
const NOTE_TITLE_MAX = 60;

const MODE_LABEL = { encrypt: '▶ Encrypting', decrypt: '◀ Decrypting' };
const DETECT_LABEL = { v2: 'cZEROde message', v4: 'Old v4 message', mixed: 'Old Mixed Script' };

// 'legacy.text' hands an old Mixed Script message to the Legacy screen; it is plaintext in all but name, so a lock
// drops it when Legacy hasn't taken it yet.
state.onPurge(() => {
  if (state.get('legacy.text') != null) state.set('legacy.text', null);
});

function utf8Length(s) {
  if (s.length * 3 <= MAX_PLAIN) return s.length * 3; // cheap upper bound: certainly fits
  return new TextEncoder().encode(s).length;
}

const confirmKdf = (p) => confirmDialog({
  title: 'Heavy message',
  message: `This message needs ~${p.mib} MiB and ~${p.seconds} s to unlock. Continue?`,
  confirmLabel: 'Continue',
});

function withFk(el, key) {
  el.dataset.fk = key;
  return el;
}

function noteTitle(text) {
  const first = String(text).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  if (!first) return 'Decrypted message';
  return first.length > NOTE_TITLE_MAX ? `${first.slice(0, NOTE_TITLE_MAX - 1)}…` : first;
}

function unsupportedView(host) {
  host.append(h('section', { class: 'tx-unsupported' },
    h('div', { class: 'tx-emblem', aria: { hidden: 'true' } }, icon('warning')),
    h('h1', { class: 'tx-title', text: 'This browser is too old for cZEROde 2' }),
    h('p', { class: 'tx-lead', text: 'Update it or use the desktop app for new messages. Old cZEROde 1 messages still open in Legacy.' }),
    h('a', { class: 'btn btn-primary', href: '#/legacy' }, icon('key'), h('span', { text: 'Open Legacy' }))));
  return { destroy() {} };
}

function textPage(host, { getVault }) {
  let override = 'auto';
  let detected = null;
  let running = null; // {ctl, mode, stale}: stale = the input changed meanwhile, the result is not shown
  let output = null; // {kind: 'cipher'|'plain', text, version?}
  let noteSaved = false;
  let noteSaving = false;
  let detectTimer = null;
  let seq = 0;

  const msgId = 'tx-msg';
  const ta = h('textarea', {
    class: 'input tx-msg',
    id: msgId,
    rows: 7,
    placeholder: 'Type a message to encrypt — or paste a cZEROde message to decrypt it.',
    autocomplete: 'off',
    spellcheck: false,
    attrs: { autocapitalize: 'sentences', autocorrect: 'off', 'data-gramm': 'false', 'data-enable-grammarly': 'false' },
    aria: { describedby: 'tx-count' },
  });
  const chip = h('span', { class: 'tx-chip', aria: { live: 'polite' } });
  const seg = segmented({
    label: 'Mode',
    value: 'auto',
    options: [{ value: 'auto', label: 'Auto' }, { value: 'encrypt', label: 'Encrypt' }, { value: 'decrypt', label: 'Decrypt' }],
    onChange: (v) => {
      override = v;
      paint();
    },
  });
  const count = h('p', { class: 'tx-count', id: 'tx-count' });
  const mixedSlot = h('div', { class: 'tx-mixed' });
  const pf = passphraseField({ label: 'Passphrase', mode: 'new', purpose: 'text', generateWords: 6, autocomplete: 'off', onSubmit: () => run(), onChange: () => dropStale() });
  const goLabel = h('span');
  const goIcon = h('span', { class: 'tx-go-icon' });
  const go = h('button', { type: 'button', class: 'btn btn-primary tx-go', on: { click: () => run() } }, goIcon, goLabel);
  const status = h('p', { class: 'tx-status', role: 'status' });
  const errLine = h('p', { class: 'hint hint-err tx-error', role: 'alert', hidden: true });
  const outSlot = h('div', { class: 'tx-out-slot' });
  const clearBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost tx-clear', on: { click: () => clearAll(true) } }, icon('close'), h('span', { text: 'Clear' }));

  const card = h('section', { class: 'card tx-card', aria: { label: 'Message' } },
    h('div', { class: 'tx-bar' },
      h('label', { class: 'label tx-label', for: msgId, text: 'Message' }),
      chip,
      h('span', { class: 'tx-bar-gap' }),
      seg.el),
    ta,
    h('div', { class: 'tx-under' }, count, clearBtn),
    mixedSlot,
    pf.el,
    h('div', { class: 'tx-actions' }, go, status),
    errLine);

  const el = h('div', { class: 'tx-page' },
    h('header', { class: 'tx-head' },
      h('p', { class: 'tx-eyebrow', text: 'Camouflage messages' }),
      h('h1', { class: 'tx-title', text: 'Text' }),
      h('p', { class: 'tx-lead', text: 'Turn a message into Georgian/Cyrillic-looking script that only your passphrase opens. Paste one you got to read it.' })),
    card,
    outSlot,
    h('p', { class: 'tx-fine' }, icon('info'), h('span', { text: 'The script is camouflage; the protection is the passphrase (Argon2id + AES-256-GCM). Old cZEROde v4 messages decrypt here too.' })));
  host.append(el);

  const mode = () => {
    if (override !== 'auto') return override;
    return detected === 'v2' || detected === 'v4' ? 'decrypt' : 'encrypt';
  };

  function setError(msg) {
    errLine.replaceChildren(...(msg ? [icon('warning'), h('span', { text: msg })] : []));
    errLine.hidden = !msg;
  }

  function sizeProblem(m, s) {
    if (m === 'encrypt' && utf8Length(s) > MAX_PLAIN) return `That’s too long — Text works up to ${fmtSize(MAX_PLAIN)}. Use Send for long texts and files.`;
    if (m === 'decrypt' && s.length > MAX_CIPHER) return `That’s too long for a cZEROde message (over ${fmtSize(MAX_CIPHER)} characters).`;
    return null;
  }

  const painted = { chip: null, status: null, mixed: null };

  /** Repaints what depends on the mode; live regions and the banner only change when their content does. */
  function paint() {
    const m = mode();
    el.dataset.mode = m;
    pf.setMode(m === 'encrypt' ? 'new' : 'enter');
    const auto = override === 'auto';
    const chipKey = `${m}|${auto}|${detected}`;
    if (painted.chip !== chipKey) {
      painted.chip = chipKey;
      chip.dataset.mode = m;
      chip.replaceChildren(...[
        h('span', { class: 'tx-chip-mode', text: m === 'encrypt' ? 'Encrypt' : 'Decrypt' }),
        auto && detected && detected !== 'mixed' ? h('span', { class: 'tx-chip-det', text: DETECT_LABEL[detected] }) : null,
        auto ? h('span', { class: 'tx-chip-auto', text: 'Auto' }) : null,
      ].filter(Boolean));
      goIcon.replaceChildren(icon(m === 'encrypt' ? 'lock' : 'unlock'));
    }
    goLabel.textContent = running ? (running.mode === 'encrypt' ? 'Encrypting…' : 'Decrypting…') : m === 'encrypt' ? 'Encrypt' : 'Decrypt';
    go.disabled = Boolean(running);
    const statusKey = `${running?.mode ?? m}|${Boolean(running)}`;
    if (painted.status !== statusKey) {
      painted.status = statusKey;
      status.dataset.mode = running?.mode ?? m;
      status.classList.toggle('tx-status-busy', Boolean(running));
      status.replaceChildren(...[
        running ? h('span', { class: 'tx-spin', aria: { hidden: 'true' } }) : null,
        h('span', { class: 'tx-status-text', text: MODE_LABEL[running?.mode ?? m] + (running ? '…' : '') }),
      ].filter(Boolean));
    }
    const s = ta.value;
    const problem = s ? sizeProblem(m, s) : null;
    count.textContent = problem ?? (s ? `${s.length.toLocaleString()} ${s.length === 1 ? 'character' : 'characters'}` : '');
    count.classList.toggle('tx-count-err', Boolean(problem));
    clearBtn.hidden = !s && !output;
    const showMixed = detected === 'mixed';
    if (painted.mixed === showMixed) return;
    painted.mixed = showMixed;
    mixedSlot.replaceChildren(...(showMixed ? [banner({
      kind: 'warn',
      text: 'This looks like old Mixed Script — open in Legacy →',
      actions: [{ label: 'Open in Legacy', kind: 'primary', onClick: () => {
        state.set('legacy.text', ta.value);
        router.navigate('#/legacy');
      } }],
    })] : []));
  }

  function detectNow() {
    clearTimeout(detectTimer);
    detectTimer = null;
    const s = ta.value;
    let d = null;
    if (s && s.length <= MAX_CIPHER) {
      try {
        d = detectText(s);
      } catch {
        d = null;
      }
    }
    detected = d;
    paint();
  }

  /**
   * An output belongs to the message and passphrase it was made from: editing either drops it (no stale
   * ciphertext to copy by mistake, no decrypted text left next to a different message).
   */
  function dropStale() {
    if (running) running.stale = true; // its result is for the old message: not shown
    if (!output) return;
    output = null;
    noteSaved = false;
    noteSaving = false;
    showOutput();
    paint();
  }

  ta.addEventListener('input', () => {
    setError(null);
    dropStale();
    clearTimeout(detectTimer);
    detectTimer = setTimeout(detectNow, DETECT_MS);
    paint();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      run();
    }
  });

  // ── output

  /** Rebuilds the output card; keyboard focus inside it stays on the same control. */
  function showOutput() {
    const d = globalThis.document;
    const prev = d?.activeElement && outSlot.contains(d.activeElement) ? d.activeElement : null;
    const key = prev?.closest?.('[data-fk]')?.dataset.fk ?? null;
    buildOutput();
    if (!prev || outSlot.contains(d.activeElement)) return;
    const t = (key && outSlot.querySelector(`[data-fk="${key}"]:not([disabled])`)) || outSlot.querySelector('.tx-cipher, .tx-plain');
    t?.focus({ preventScroll: true });
  }

  function buildOutput() {
    if (!output) {
      outSlot.replaceChildren();
      return;
    }
    const v = getVault();
    const unlocked = v && v.status === 'unlocked';
    if (output.kind === 'cipher') {
      const share = typeof globalThis.navigator?.share === 'function' ? h('button', {
        type: 'button',
        class: 'btn btn-sm tx-share',
        dataset: { fk: 'share' },
        on: {
          click: async () => {
            try {
              await platform.shareText(output.text);
            } catch (e) {
              if (!isCancel(e)) toast(userMessage(e), { kind: 'err' });
            }
          },
        },
      }, icon('share'), h('span', { text: 'Share' })) : null;
      outSlot.replaceChildren(h('section', { class: 'card tx-out tx-out-cipher', aria: { label: 'Encrypted message' } },
        h('div', { class: 'tx-out-head' },
          h('span', { class: 'tx-out-icon', aria: { hidden: 'true' } }, icon('lock')),
          h('h2', { class: 'tx-out-title', text: 'Encrypted message' }),
          h('span', { class: 'tx-out-meta', text: `${output.text.length.toLocaleString()} characters` })),
        h('div', { class: 'tx-cipher', tabIndex: 0, aria: { label: 'Ciphertext' } }, stealthText(output.text)),
        h('div', { class: 'tx-out-tools' },
          withFk(copyButton(() => output?.text ?? '', { label: 'Copy' }), 'copy'),
          share,
          h('span', { class: 'tx-out-tip', text: 'Send the passphrase some other way.' }))));
      return;
    }
    const noteBtn = unlocked ? h('button', {
      type: 'button',
      class: 'btn btn-sm tx-note',
      dataset: { fk: 'note' },
      disabled: noteSaved || noteSaving,
      on: { click: () => saveNote() },
    }, icon(noteSaved ? 'check' : 'note'), h('span', { text: noteSaved ? 'Saved to your vault' : noteSaving ? 'Saving…' : 'Save to vault as note' })) : null;
    outSlot.replaceChildren(h('section', { class: 'card tx-out tx-out-plain', aria: { label: 'Decrypted message' } },
      h('div', { class: 'tx-out-head' },
        h('span', { class: 'tx-out-icon', aria: { hidden: 'true' } }, icon('unlock')),
        h('h2', { class: 'tx-out-title', text: 'Decrypted message' }),
        output.version === 'v4' ? h('span', { class: 'badge badge-gold', text: 'old v4' }) : null),
      h('pre', { class: 'tx-plain', tabIndex: 0, text: output.text }),
      output.version === 'v4' ? h('p', { class: 'hint' }, icon('info'), h('span', { text: 'v4 used a weak PIN key. Re-encrypt anything important here.' })) : null,
      h('div', { class: 'tx-out-tools' },
        withFk(copyButton(() => output?.text ?? '', { secret: true, label: 'Copy' }), 'copy'),
        noteBtn)));
  }

  async function saveNote() {
    const v = getVault();
    const out = output;
    if (!out || out.kind !== 'plain' || !v || v.status !== 'unlocked' || noteSaving || noteSaved) return;
    noteSaving = true;
    showOutput();
    try {
      await v.addNote({ title: noteTitle(out.text), body: out.text });
      if (output !== out) return; // cleared or locked meanwhile
      noteSaving = false;
      noteSaved = true;
      showOutput();
      toast('Saved to your vault as a note', { kind: 'ok', action: { label: 'Open vault', onClick: () => router.navigate('#/vault') } });
    } catch (e) {
      if (output !== out) return;
      noteSaving = false;
      showOutput();
      if (!isCancel(e)) toast(userMessage(e), { kind: 'err' });
    }
  }

  // ── the action

  async function run() {
    if (running) return;
    if (detectTimer) detectNow();
    const m = mode();
    const msg = ta.value;
    setError(null);
    if (m === 'encrypt' && msg.trim().toLowerCase() === 'codzilla') {
      router.navigate('#/codzilla');
      return;
    }
    if (!msg.trim()) {
      setError(m === 'encrypt' ? 'Type a message first.' : 'Paste the message first.');
      ta.focus();
      return;
    }
    const problem = sizeProblem(m, msg);
    if (problem) {
      setError(problem);
      return;
    }
    const pass = pf.value;
    if (!pass.trim()) {
      pf.setError(m === 'encrypt' ? 'Type a passphrase (or Generate one).' : 'Type the passphrase.');
      return;
    }
    const my = ++seq;
    const ctl = new AbortController();
    const job = { ctl, mode: m, stale: false };
    running = job;
    paint();
    try {
      let result;
      if (m === 'encrypt') {
        let text;
        try {
          text = await encryptText(msg, pass, { signal: ctl.signal });
        } catch (e) {
          if (toCzdError(e).code !== 'kdf-out-of-memory' || my !== seq) throw e;
          const ok = await confirmDialog({ title: 'Low memory', message: 'Low memory: use lighter protection? The message still needs the passphrase, but guessing it gets cheaper.', confirmLabel: 'Use lighter protection' });
          if (!ok || my !== seq) return;
          text = await encryptText(msg, pass, { params: FLOOR, signal: ctl.signal });
        }
        result = { kind: 'cipher', text };
      } else if (stripWs(msg).startsWith(TEXT_MARKER)) {
        result = { kind: 'plain', text: await decryptText(msg, pass, { confirmKdf, signal: ctl.signal }), version: 'v2' };
      } else {
        result = { kind: 'plain', text: await decryptV4Text(msg, pass), version: 'v4' };
      }
      if (my !== seq || job.stale) return;
      output = result;
      noteSaved = false;
      noteSaving = false;
      showOutput();
      announce(result.kind === 'cipher' ? 'Message encrypted' : 'Message decrypted');
      outSlot.firstElementChild?.scrollIntoView?.({ block: 'nearest' });
    } catch (e) {
      if (my !== seq || job.stale || isCancel(e)) return;
      const code = toCzdError(e).code;
      if (code === 'wrong-passphrase') pf.setError(userMessage(code));
      else if (code === 'legacy-wrong-pin') pf.setError('Wrong passphrase or PIN. Old v4 messages use the PIN they were made with.');
      else if (code === 'legacy-not-ciphertext' || code === 'not-cz-text') setError(override === 'decrypt' && code === 'legacy-not-ciphertext' ? "That doesn't look like a cZEROde message." : userMessage(code));
      else {
        if (code === 'internal') globalThis.console?.error?.('[text]', e);
        setError(userMessage(e));
      }
    } finally {
      if (my === seq) {
        running = null;
        paint();
      }
    }
  }

  /** Clears the message and the output (and, on lock, everything else). */
  function clearAll(focus) {
    seq++;
    running?.ctl.abort();
    running = null;
    clearTimeout(detectTimer);
    detectTimer = null;
    ta.value = '';
    detected = null;
    output = null;
    noteSaved = false;
    noteSaving = false;
    setError(null);
    showOutput();
    paint();
    if (focus) ta.focus();
  }

  const offs = [
    state.onPurge(() => {
      clearAll(false);
      pf.clear();
      override = 'auto';
      seg.set('auto');
      paint();
    }),
    // Only the decrypted output has a vault action ("Save to vault as note").
    state.on('vault.status', () => {
      if (output?.kind === 'plain') showOutput();
    }),
  ];
  paint();

  return {
    destroy() {
      for (const off of offs.splice(0)) off();
      clearAll(false);
      pf.clear();
    },
  };
}

/** ViewModule.mount (top 'text'). */
export function mount(root, route, ctx) {
  const getVault = () => ctx?.vault ?? null;
  const el = h('div', { class: 'tx' });
  root.append(el);
  let page = null;
  let unsupported = null;

  function build() {
    const bad = state.get('browser.ok') === false;
    if (page && unsupported === bad) return;
    page?.destroy();
    el.replaceChildren();
    unsupported = bad;
    page = bad ? unsupportedView(el) : textPage(el, { getVault });
  }
  const offBrowser = state.on('browser.ok', () => build());
  build();

  return {
    update() {},
    unmount() {
      offBrowser();
      page?.destroy();
      page = null;
      el.remove();
    },
  };
}
