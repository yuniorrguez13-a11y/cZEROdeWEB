// App shell (DESIGN §1.2, §1.6, §10): header with logo, nav tabs (bottom nav on phones), the
// header lock button (visible while the vault is unlocked), the update banner, the privacy
// cover, #player-dock and the toast/modal roots.

import { h, icon, toast } from '../util/dom.js';
import * as state from '../state.js';
import { navTop } from '../router.js';
import { vault } from '../vault/vault.js';
import * as pwa from '../pwa.js';
import { mountPlayer } from './player.js';

/** Nav tabs: route top, header label, phone label, icon. */
export const TABS = Object.freeze([
  { top: 'vault', label: 'Vault', short: 'Vault', icon: 'lock' },
  { top: 'send', label: 'Send · Open', short: 'Share', icon: 'send' },
  { top: 'text', label: 'Text', short: 'Text', icon: 'note' },
  { top: 'more', label: 'More', short: 'More', icon: 'more' },
]);

/** The wordmark: c (accent) ZER O (gold) de. */
export function logo() {
  return h('span', { class: 'logo' }, h('span', { class: 'logo-c', text: 'c' }), 'ZER', h('span', { class: 'logo-o', text: 'O' }), 'de');
}

let mounted = null;

/**
 * Builds the shell into `root` (#app) and the overlay roots into <body>.
 * @param {HTMLElement} root
 * @returns {{main: HTMLElement, setActive(top: string): void}}
 */
export function mountShell(root) {
  if (mounted) return mounted;
  const d = globalThis.document;
  const links = [];
  const navLink = (t, compact) => {
    const a = h('a', {
      href: `#/${t.top}`,
      class: compact ? 'sh-tab-m' : 'sh-tab',
      dataset: { top: t.top },
    }, compact ? icon(t.icon) : null, h('span', { class: compact ? 'sh-tab-m-label' : null, text: compact ? t.short : t.label }));
    links.push(a);
    return a;
  };

  const lockBtn = h('button', {
    type: 'button',
    class: 'btn btn-sm sh-lock',
    hidden: true,
    aria: { label: 'Lock vault' },
    on: {
      click: () => {
        try {
          vault?.lock('user');
        } catch (e) {
          globalThis.console?.error?.(e);
          toast("Couldn't lock — reload the page to be safe.", { kind: 'err' });
        }
      },
    },
  }, icon('lock'), h('span', { class: 'sh-lock-label', text: 'Lock' }));

  const updateText = h('span');
  const updateBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Reload', on: { click: () => applyUpdate() } });
  const updateBar = h('div', { class: 'sh-update', role: 'status', hidden: true }, icon('refresh'), updateText, updateBtn);

  const header = h('header', { class: 'sh-header' },
    h('a', { class: 'sh-brand', href: '#/vault', aria: { label: 'cZEROde — vault' } }, logo(), h('span', { class: 'sh-pill', text: 'v2' })),
    h('nav', { class: 'sh-nav', aria: { label: 'Main' } }, TABS.map((t) => navLink(t, false))),
    h('div', { class: 'sh-actions' }, lockBtn));

  const main = h('main', { id: 'main', class: 'sh-main', tabIndex: -1 });
  const dock = h('div', { id: 'player-dock', class: 'sh-dock' });
  const bottom = h('nav', { class: 'sh-bottom', aria: { label: 'Main' } }, TABS.map((t) => navLink(t, true)));
  const skip = h('button', {
    type: 'button',
    class: 'sh-skip',
    text: 'Skip to content',
    on: { click: () => main.focus() },
  });

  root.replaceChildren(h('div', { class: 'sh-app' }, skip, header, updateBar, main, dock, bottom));
  // The persistent player lives in the dock and survives route changes (DESIGN §1.5, §10).
  try {
    mountPlayer(dock);
  } catch (e) {
    globalThis.console?.warn?.('[shell] player not available', e);
  }

  // Overlay roots live outside #app so the app can be made inert while a dialog is open.
  const ensure = (id, make) => d.getElementById(id) ?? d.body.appendChild(make());
  ensure('toasts', () => h('div', { id: 'toasts', class: 'toasts', role: 'region', aria: { live: 'polite', label: 'Notifications' } }));
  ensure('modals', () => h('div', { id: 'modals', class: 'modal-root' }));
  ensure('privacy-cover', () => h('div', { id: 'privacy-cover', class: 'sh-cover', aria: { hidden: 'true' } }, h('div', { class: 'sh-cover-logo' }, logo())));

  function setActive(top) {
    const nav = navTop(top);
    for (const a of links) {
      const on = a.dataset.top === nav;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  function paintLock() {
    const unlocked = state.get('vault.status') === 'unlocked';
    lockBtn.hidden = !unlocked;
    d.documentElement.classList.toggle('vault-unlocked', unlocked);
    paintUpdate();
  }

  function paintUpdate() {
    const ready = state.get('sw.updateReady') === true;
    updateBar.hidden = !ready;
    if (!ready) return;
    const blocked = state.get('vault.status') === 'unlocked' || (Number(state.get('busy')) || 0) > 0;
    updateText.textContent = blocked ? 'Update ready — it installs after you lock the vault.' : 'Update ready — reload to get it.';
  }

  async function applyUpdate() {
    updateBtn.disabled = true;
    try {
      await pwa.applyUpdate();
    } catch (e) {
      globalThis.console?.error?.(e);
      toast("Couldn't update right now — try reloading the page.", { kind: 'warn' });
    } finally {
      updateBtn.disabled = false;
    }
  }

  state.on('vault.status', paintLock);
  state.on('sw.updateReady', paintUpdate);
  state.on('busy', paintUpdate);
  state.on('route', (route) => setActive(route?.top ?? ''));
  paintLock();
  setActive(state.get('route')?.top ?? '');

  mounted = { main, setActive };
  return mounted;
}
