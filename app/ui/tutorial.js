// Quick tour (DESIGN §1.1, §1.3, §1.10): 5 short steps in a modal. It never opens by itself —
// the first-run hero and More → "Quick tour" call openTutorial(). Closing it marks it done.

import { h, icon, modal } from '../util/dom.js';
import * as settings from '../settings.js';

const logo = () => h('span', { class: 'logo' }, h('span', { class: 'logo-c', text: 'c' }), 'ZER', h('span', { class: 'logo-o', text: 'O' }), 'de');
const b = (text) => h('strong', { text });

/** Step content: icon id, title (string or () => nodes), body: () => paragraphs (arrays of strings/nodes). */
export const STEPS = Object.freeze([
  {
    icon: 'lock',
    title: () => [logo(), ' 2'],
    body: () => [
      ['Welcome. cZEROde locks your photos, videos, music, files and notes with a passphrase only you know.'],
      ['No accounts, no servers, no tracking. Everything is encrypted ', b('on this device'), ' and never leaves it unless you send it.'],
    ],
  },
  {
    icon: 'key',
    title: 'Your vault',
    body: () => [
      ['Drop stuff into the ', b('Vault'), ' and view or play it right here — no unlocked copies end up in your downloads.'],
      ['Pick a strong passphrase and ', b('save your recovery code'), '. Lose both and your files are gone for good. Not even we can open them.'],
    ],
  },
  {
    icon: 'send',
    title: 'Send & open files',
    body: () => [
      ['Lock files into one ', b('.czd'), ' and send it over WhatsApp, Discord, email or USB. Your friend opens it in cZEROde with the passphrase.'],
      ['Send the passphrase ', b('through a different app'), ' than the file. Got a .czd? Go to ', b('Send · Open'), ' → Open.'],
    ],
  },
  {
    icon: 'note',
    title: 'Secret messages',
    body: () => [
      [b('Text'), ' turns a message into Georgian- and Cyrillic-looking script you can paste anywhere. Only someone with the passphrase can read it.'],
      ['The funky script is just camouflage — the passphrase is the real lock.'],
    ],
  },
  {
    icon: 'download',
    title: 'Keep it safe',
    body: () => [
      ['Each browser and each app has its ', b('own vault'), ' — they don\'t sync. To move things, back up and restore, or send them to yourself as a .czd.'],
      ['Clearing site data or uninstalling deletes the vault; only a ', b('.czb backup'), ' survives. Install the app and back up now and then.'],
    ],
  },
]);

let current = null;

/**
 * Opens the quick tour (no-op when it is already open).
 * @returns {Promise<any>} resolves when it closes
 */
export function openTutorial() {
  if (current) return current;
  let step = 0;
  const n = STEPS.length;
  const iconBox = h('div', { class: 'tu-icon' });
  const counter = h('p', { class: 'tu-count' });
  const title = h('h2', { class: 'tu-title', id: 'tu-title' });
  const body = h('div', { class: 'tu-body' });
  const dots = h('div', { class: 'tu-dots', aria: { hidden: 'true' } }, STEPS.map(() => h('span', { class: 'tu-dot' })));
  const back = h('button', { type: 'button', class: 'btn btn-ghost tu-back', on: { click: () => go(step - 1) } }, icon('back'), h('span', { text: 'Back' }));
  const skip = h('button', { type: 'button', class: 'tu-skip', text: 'Skip', on: { click: () => p.close('skip') } });
  const next = h('button', { type: 'button', class: 'btn btn-primary tu-next', on: { click: () => (step === n - 1 ? p.close('done') : go(step + 1)) } });
  const box = h('div', { class: 'tu-box', aria: { live: 'polite' } }, iconBox, counter, title, body,
    h('div', { class: 'tu-nav' }, h('div', { class: 'tu-left' }, skip, back), dots, next));

  function go(i) {
    step = Math.max(0, Math.min(n - 1, i));
    const s = STEPS[step];
    iconBox.replaceChildren(icon(s.icon));
    counter.textContent = `${step + 1} of ${n}`;
    title.replaceChildren(...[].concat(typeof s.title === 'function' ? s.title() : s.title));
    body.replaceChildren(...s.body().map((para) => h('p', null, para)));
    [...dots.children].forEach((d, k) => d.classList.toggle('on', k === step));
    back.hidden = step === 0;
    skip.hidden = step === n - 1;
    next.textContent = step === n - 1 ? "Let's go →" : 'Next →';
    next.focus({ preventScroll: true });
  }

  const p = modal({ className: 'tu-modal', body: box, dismissible: true });
  p.el.setAttribute('aria-labelledby', 'tu-title');
  box.addEventListener('keydown', (e) => {
    if (e.target.closest('button') && (e.key === 'Enter' || e.key === ' ')) return;
    if (e.key === 'ArrowRight' && step < n - 1) go(step + 1);
    else if (e.key === 'ArrowLeft' && step > 0) go(step - 1);
  });
  go(0);
  current = p;
  p.then(() => {
    current = null;
    try {
      settings.set('tutorialDone', true);
    } catch {
      // storage unavailable: fine
    }
  });
  return p;
}
