// Codzilla page (route 'codzilla'): the prank "encoder", copy and timing verbatim from the
// original app (ui-inventory §1.6). unmount() cancels every timer/frame — the old app left the
// page half-alive, which is what blanked the Encode page (bug B-18).

import { h, clear } from '../util/dom.js';

const DURATION = 30000;
const REVEAL_DELAY = 500;
const STATUS = Object.freeze([
  'Booting quantum processors...',
  'Aligning neural matrices...',
  'Calibrating Codzilla cores v9.4.2...',
  'Injecting chaos entropy seed...',
  'Parsing your entire vibe...',
  'Consulting the ancient scripts...',
  'Cross-referencing 47 encrypted databases...',
  'Warming up the encode reactors...',
  'Stabilizing the warp field...',
  'Compressing temporal buffers...',
  'This is definitely working, trust...',
  'Summoning the algorithm from the void...',
  'Applying 9-layer quantum obfuscation...',
  'Almost there... (not really)...',
  'Final verification phase initiating...',
]);
const PUNCHLINE = 'bro the fuck did you just type there, twin not even me can encode that shit 😭🥀✌\ufe0f';

/** Percentage text exactly like the original: <1% 4 decimals, <10% 3, <50% 2, else 1; end "99.99999%". */
export function fmtPct(pct) {
  if (pct >= 99.99999) return '99.99999%';
  if (pct < 1) return `${pct.toFixed(4)}%`;
  if (pct < 10) return `${pct.toFixed(3)}%`;
  if (pct < 50) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(1)}%`;
}

/** Status line for progress t in [0, 1]. */
export function statusAt(t) {
  return STATUS[Math.min(Math.floor(t * STATUS.length), STATUS.length - 1)];
}

/**
 * ViewModule.mount for '#/codzilla'.
 * @param {HTMLElement} root
 * @param {import('../types.js').Route} route
 * @param {object} ctx
 * @returns {{unmount(): void}}
 */
export function mount(root, route, ctx) {
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const raf = globalThis.requestAnimationFrame?.bind(globalThis) ?? ((f) => setTimeout(() => f(now()), 16));
  const caf = globalThis.cancelAnimationFrame?.bind(globalThis) ?? clearTimeout;
  let frame = null;
  let reveal = null;
  let startedAt = 0;
  let alive = true;

  const inputId = 'cz-input';
  const textarea = h('textarea', { class: 'cz-textarea', id: inputId, rows: 4, placeholder: 'type your super secret message...', spellcheck: false });
  const go = h('button', { type: 'button', class: 'cz-btn', text: '⚡ Encode with Codzilla', on: { click: () => start() } });
  const inputWrap = h('div', { class: 'cz-input' }, h('label', { class: 'cz-label', for: inputId, text: 'Enter your message' }), textarea, go);

  const fill = h('div', { class: 'cz-fill' });
  const pct = h('span', { class: 'cz-pct', text: '0%' });
  const status = h('p', { class: 'cz-status', text: STATUS[0], aria: { live: 'off' } });
  const bar = h('div', { class: 'cz-bar', role: 'progressbar', aria: { valuemin: '0', valuemax: '100', valuenow: '0', label: 'Codzilla progress' } }, fill, pct);
  const loading = h('div', { class: 'cz-loading', hidden: true }, h('p', { class: 'cz-label', text: '⚙ Initializing Codzilla Engine v9.4.2...' }), bar, status);

  const msg = h('p', { class: 'cz-msg', aria: { live: 'polite' } });
  const again = h('button', { type: 'button', class: 'cz-again', text: '↺ Try Again', on: { click: () => reset() } });
  const result = h('div', { class: 'cz-result', hidden: true }, msg, again);

  const page = h('section', { class: 'cz-page', aria: { labelledby: 'cz-title' } },
    h('div', { class: 'cz-inner' },
      h('h1', { class: 'cz-title', id: 'cz-title' }, h('span', { class: 'cz-g', text: 'pro' }), 'jerct ', h('span', { class: 'cz-g', text: 'c' }), 'odzilla'),
      h('p', { class: 'cz-tag', text: 'next-gen · quantum-resistant · 100% real · definitely not a prank' }),
      inputWrap,
      loading,
      result));

  function stopTimers() {
    if (frame !== null) caf(frame);
    frame = null;
    clearTimeout(reveal);
    reveal = null;
  }

  function paint(p) {
    fill.style.width = `${p}%`;
    pct.textContent = fmtPct(p);
    bar.setAttribute('aria-valuenow', String(Math.floor(p)));
  }

  function tick(t0) {
    if (!alive) return;
    const t = Math.min((now() - startedAt) / DURATION, 1);
    paint(t >= 1 ? 99.99999 : t * 99.99999);
    status.textContent = statusAt(t);
    if (t < 1) {
      frame = raf(tick);
      return;
    }
    frame = null;
    reveal = setTimeout(() => {
      reveal = null;
      if (!alive) return;
      loading.hidden = true;
      result.hidden = false;
      msg.textContent = PUNCHLINE;
      again.focus();
    }, REVEAL_DELAY);
  }

  function start() {
    if (!textarea.value.trim()) return;
    stopTimers();
    inputWrap.hidden = true;
    result.hidden = true;
    loading.hidden = false;
    paint(0);
    status.textContent = STATUS[0];
    startedAt = now();
    frame = raf(tick);
  }

  function reset() {
    stopTimers();
    textarea.value = '';
    paint(0);
    msg.textContent = '';
    result.hidden = true;
    loading.hidden = true;
    inputWrap.hidden = false;
    textarea.focus();
  }

  root.append(page);
  return {
    unmount() {
      alive = false;
      stopTimers();
      textarea.value = '';
      page.remove();
      if (root.childElementCount === 0) clear(root);
    },
  };
}
