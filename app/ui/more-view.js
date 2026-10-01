// More screen (route 'more'; DESIGN §1.10). Owner: V2b.
// Menu cards: Settings · Legacy · About & security · Quick tour · Install app (web only, hidden when installed or
// in the desktop app; the browser's prompt, or Add-to-Home-Screen steps on iOS) · Get the latest version (desktop:
// opens the releases page) · Codzilla. Footer with the version.
// Node-importable: the DOM is only touched inside functions.

import { RELEASES_URL, VERSION } from '../config.js';
import * as state from '../state.js';
import * as platform from '../platform.js';
import * as pwa from '../pwa.js';
import { userMessage } from '../errors.js';
import { h, icon, modal, toast } from '../util/dom.js';
import { openTutorial } from './tutorial.js';

function logo() {
  return h('span', { class: 'logo' }, h('span', { class: 'logo-c', text: 'c' }), 'ZER', h('span', { class: 'logo-o', text: 'O' }), 'de');
}

function step(n, ...text) {
  return h('li', { class: 'st-step' }, h('span', { class: 'st-step-n', text: String(n) }), h('span', { class: 'st-step-text' }, text));
}

/** Install steps for iPhone/iPad (no install prompt there). */
function iosSteps() {
  return modal({
    title: 'Install cZEROde',
    className: 'st-modal st-install-modal',
    body: h('div', { class: 'stack' },
      h('ol', { class: 'st-steps' },
        step(1, 'Tap ', h('strong', { text: 'Share' }), ' in Safari’s toolbar.'),
        step(2, 'Choose ', h('strong', { text: 'Add to Home Screen' }), '.'),
        step(3, 'Open cZEROde from your Home Screen.')),
      h('p', { class: 'st-lead-sm', text: 'Your vault lives inside the installed app. A vault made in a Safari tab can be erased after 7 days without use. Already have a vault here? Export a backup first and restore it in the installed app.' })),
    actions: [{ label: 'Got it', kind: 'primary', value: true, autofocus: true }],
  });
}

/** Browsers without a captured install prompt (Firefox, desktop Safari, a prompt already used). */
function otherSteps() {
  return modal({
    title: 'Install cZEROde',
    className: 'st-modal st-install-modal',
    body: h('div', { class: 'stack' },
      h('ol', { class: 'st-steps' },
        step(1, 'Chrome, Edge, Android: open the browser menu and pick ', h('strong', { text: 'Install app' }), ' or ', h('strong', { text: 'Add to Home screen' }), '.'),
        step(2, 'Safari on a Mac: ', h('strong', { text: 'File → Add to Dock' }), '.'),
        step(3, 'Firefox: no install — keep a backup, or get the desktop app.')),
      h('p', { class: 'st-lead-sm', text: 'Installed, cZEROde opens in its own window, works offline and the browser is less likely to clear your vault.' })),
    actions: [{ label: 'Desktop app', kind: 'ghost', value: 'desktop' }, { label: 'Got it', kind: 'primary', value: true, autofocus: true }],
  }).then((v) => {
    if (v === 'desktop') platform.openExternal(RELEASES_URL).catch(() => toast(userMessage('internal'), { kind: 'err' }));
  });
}

async function install() {
  if (state.get('install.prompt')) {
    const ok = await pwa.promptInstall();
    if (ok) {
      // §1.5: persist() may be asked from the install flow.
      platform.storage.persist().catch(() => {});
      toast('Installed. Open cZEROde from your apps.', { kind: 'ok' });
    }
    return;
  }
  if (pwa.isIOS()) iosSteps();
  else otherSteps();
}

/**
 * ViewModule.mount for 'more'.
 * @param {HTMLElement} root
 * @param {import('../types.js').Route} route
 * @param {{vault: any, state: any}} ctx
 */
export function mount(root, route, ctx) {
  void route;
  void ctx;
  const offs = [];
  const card = ({ id, iconId, title, text, href, onClick, badge, hidden, tone }) => {
    const inner = [
      h('span', { class: 'st-card-icon', aria: { hidden: 'true' } }, icon(iconId)),
      h('span', { class: 'st-card-text' },
        h('span', { class: 'st-card-title' }, h('span', { text: title }), badge ?? ''),
        h('span', { class: 'st-card-sub', text })),
      h('span', { class: 'st-card-go', aria: { hidden: 'true' } }, icon('back')),
    ];
    const cls = ['st-card', tone ? `st-card-${tone}` : null];
    const el = href
      ? h('a', { class: cls, href, dataset: { more: id } }, inner)
      : h('button', { type: 'button', class: cls, dataset: { more: id }, on: { click: onClick } }, inner);
    el.hidden = Boolean(hidden);
    return el;
  };

  const legacyBadge = h('span', { class: 'badge badge-gold st-card-badge', hidden: true, text: 'old data found' });
  const installable = !platform.isTauri && !pwa.isStandalone();
  const cards = [
    card({ id: 'settings', iconId: 'settings', title: 'Settings', text: 'Theme, auto-lock, backups, passphrase and recovery code.', href: '#/settings' }),
    card({ id: 'legacy', iconId: 'key', title: 'Legacy', text: 'Old cZEROde 1 messages, the old web vault and old desktop .czd files.', href: '#/legacy', badge: legacyBadge }),
    card({ id: 'about', iconId: 'info', title: 'About & security', text: 'What cZEROde protects — and what it can’t. In plain language.', href: '#/about' }),
    card({ id: 'tour', iconId: 'play', title: 'Quick tour', text: 'Five short steps: vault, sending, messages, backups.', onClick: () => openTutorial() }),
    card({ id: 'install', iconId: 'download', title: 'Install app', text: pwa.isIOS() ? 'Add cZEROde to your Home Screen — your vault is safer there.' : 'Its own window, works offline, and the browser keeps your vault.', onClick: () => install(), hidden: !installable }),
    card({ id: 'update', iconId: 'refresh', title: 'Get the latest version', text: 'The desktop app doesn’t update itself. New versions are on the releases page.', onClick: () => platform.openExternal(RELEASES_URL).catch(() => toast(userMessage('internal'), { kind: 'err' })), hidden: !platform.isTauri }),
    card({ id: 'codzilla', iconId: 'zoom', title: 'projerct codzilla', text: 'Quantum-resistant™. Totally real.', href: '#/codzilla', badge: h('span', { class: 'badge st-card-badge st-badge-prank', text: 'prank' }), tone: 'prank' }),
  ];

  const el = h('div', { class: 'st' },
    h('div', { class: 'st-page st-page-more' },
      h('header', { class: 'st-head' },
        h('p', { class: 'st-eyebrow', text: 'Everything else' }),
        h('h1', { class: 'st-title', text: 'More' }),
        h('p', { class: 'st-lead', text: 'Settings, old cZEROde 1 stuff, the fine print — and one very serious project.' })),
      h('nav', { class: 'st-cards', aria: { label: 'More' } }, cards),
      h('footer', { class: 'st-foot' },
        logo(),
        h('span', { class: 'st-foot-ver', text: `Version ${VERSION} · ${platform.isTauri ? 'Desktop app' : pwa.isStandalone() ? 'Installed web app' : 'Web app'}` }),
        h('span', { class: 'st-foot-note', text: 'No accounts. No servers. Nothing leaves this device unless you send it.' }))));
  root.append(el);

  const paintLegacy = () => {
    legacyBadge.hidden = !(state.get('legacy.found') && state.get('legacy.importDone') !== true);
  };
  paintLegacy();
  offs.push(state.on('legacy.found', paintLegacy), state.on('legacy.importDone', paintLegacy));

  return {
    unmount() {
      for (const off of offs.splice(0)) off();
      el.remove();
    },
  };
}
