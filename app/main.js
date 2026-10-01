// App entry point (module script from index.html). Boot order (DESIGN §10):
// framing check → settings.migrateLegacy → theme → global dragover/drop preventDefault → mountShell
// → pwa.registerServiceWorker → (await import('./vault/boot.js')).boot(...) → router.start(...).
// Owner: C1 skeleton; phase-4 integration owns the final wiring.

import * as settings from './settings.js';
import * as state from './state.js';
import * as router from './router.js';
import * as vaultModule from './vault/vault.js';
import { mountShell } from './ui/shell.js';

// First statement: never run inside a frame (DESIGN §2.3). Function declarations below are hoisted.
if (window.top !== window.self) {
  renderFramed();
} else {
  start().catch((e) => warn('startup failed', e));
}

/** Lazy view modules per view key ('open'/'incoming' render the send view, see router.viewKey). */
function routes() {
  return {
    vault: () => import('./ui/vault-view.js'),
    send: () => import('./ui/send-view.js'),
    text: () => import('./ui/text-view.js'),
    more: () => import('./ui/more-view.js'),
    settings: () => import('./ui/settings-view.js'),
    about: () => import('./ui/settings-view.js'),
    legacy: () => import('./ui/legacy-view.js'),
    codzilla: () => import('./ui/codzilla.js'),
  };
}

/** Shown instead of the app inside a frame (clickjacking): a plain link out, nothing else. */
function renderFramed() {
  const root = document.getElementById('app') ?? document.body;
  const p = document.createElement('p');
  p.className = 'framed';
  const a = document.createElement('a');
  a.href = window.location.href;
  a.target = '_top';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Open cZEROde in its own tab';
  p.append(a);
  root.replaceChildren(p);
}

function warn(what, e) {
  console.warn(`[cZEROde] ${what}:`, e);
}

async function start() {
  settings.migrateLegacy();
  settings.applyTheme();

  // A file (or a dragged link) dropped outside a drop zone must never navigate away from the app.
  // Text dragged onto an editable field (message boxes) keeps the browser's normal drop.
  const swallow = (e) => {
    if (e.defaultPrevented) return; // a drop zone handled it
    const hasFiles = [...(e.dataTransfer?.types ?? [])].includes('Files');
    if (!hasFiles && e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  };
  window.addEventListener('dragover', swallow);
  window.addEventListener('drop', swallow);

  const shell = mountShell(document.getElementById('app'));

  try {
    (await import('./pwa.js')).registerServiceWorker();
  } catch (e) {
    warn('service worker registration failed', e);
  }

  try {
    await (await import('./vault/boot.js')).boot({ router, state, settings });
  } catch (e) {
    warn('vault boot failed', e);
  }

  const ctx = {
    get vault() {
      return vaultModule.vault;
    },
    state,
  };
  router.start(shell.main, routes(), { fallback: 'vault', ctx });
}
