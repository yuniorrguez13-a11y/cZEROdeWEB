// Hash router (DESIGN §1.2, §10). Routes look like '#/top/part/part?query'.
// - Views are lazy ViewModules keyed by "view key": 'open' and 'incoming' render the send view,
//   every other top is its own key. Same key → view.update(route); else unmount() then mount().
// - Unknown tops are replaced by the fallback ('#/vault').
// - pushOverlay() gives sheets/the viewer ONE history entry so the Back button closes them.
// Pure helpers (parseHash, viewKey, navTop) are exported for tests and the shell.

import * as state from './state.js';

/** Every top-level route of §1.2. */
export const TOPS = Object.freeze(['vault', 'send', 'open', 'incoming', 'text', 'more', 'settings', 'about', 'legacy', 'codzilla']);
const VIEW_ALIAS = Object.freeze({ open: 'send', incoming: 'send' });
const NAV_ALIAS = Object.freeze({ open: 'send', incoming: 'send', settings: 'more', about: 'more', legacy: 'more', codzilla: 'more' });

/**
 * Parses a location hash into a Route. '#/vault/item/ab?x=1' → {top:'vault', parts:['item','ab'], query, hash}.
 * Parts are percent-decoded (invalid escapes are kept as typed); empty segments are dropped.
 * @param {string} hash
 * @returns {import('./types.js').Route}
 */
export function parseHash(hash) {
  const h = typeof hash === 'string' ? hash : '';
  const body = h.replace(/^#/, '').replace(/^\/+/, '');
  const qi = body.indexOf('?');
  const path = qi < 0 ? body : body.slice(0, qi);
  const query = new URLSearchParams(qi < 0 ? '' : body.slice(qi + 1));
  const segs = path.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { top: (segs[0] ?? '').toLowerCase(), parts: segs.slice(1), query, hash: h.startsWith('#') ? h : `#${h}` };
}

/**
 * Which view module renders a top ('open'/'incoming' → 'send').
 * @param {string} top
 * @returns {string}
 */
export function viewKey(top) {
  return VIEW_ALIAS[top] ?? top;
}

/**
 * Which nav tab is highlighted for a top (§1.2): settings/about/legacy/codzilla → 'more', open/incoming → 'send'.
 * @param {string} top
 * @returns {string}
 */
export function navTop(top) {
  return NAV_ALIAS[top] ?? top;
}

/** Hash for a top + parts (+ optional query), percent-encoding each part. */
export function hrefFor(top, ...parts) {
  let query = '';
  if (parts.length && (parts.at(-1) instanceof URLSearchParams || (parts.at(-1) && typeof parts.at(-1) === 'object'))) {
    const q = new URLSearchParams(parts.pop()).toString();
    if (q) query = `?${q}`;
  }
  return `#/${[top, ...parts].map((p) => encodeURIComponent(String(p))).join('/')}${query}`;
}

// ───────── runtime

let root = null;
let routes = {};
let options = { fallback: 'vault', ctx: { vault: null, state } };
let currentRoute = parseHash('');
let currentKey = null;
let currentView = null;
let renderSeq = 0;
let started = false;

// Overlay stack: [{id, onPop, pushed}]; history.state.czdOverlay = id of the entry's overlay, and
// czdSession = this page load (ids restart after a reload; entries from an earlier load are plain entries).
const overlays = [];
let overlaySeq = 0;
const SESSION = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const overlayIdOf = (st) => (st && typeof st === 'object' && st.czdSession === SESSION ? st.czdOverlay : undefined);
let pendingBack = null; // Promise resolved by the popstate our own history.back() triggers
let resolveBack = null;
const deferred = [];

function loc() {
  return globalThis.location;
}

function hist() {
  return globalThis.history;
}

/** Runs fn now, or after the history.back() we are waiting for has landed. */
function whenSettled(fn) {
  if (pendingBack) deferred.push(fn);
  else fn();
}

function backAndWait() {
  if (!pendingBack) {
    pendingBack = new Promise((resolve) => {
      resolveBack = resolve;
    });
    // Safety net: some engines skip popstate for a no-op traversal.
    setTimeout(() => settleBack(), 400);
  }
  hist().back();
}

function settleBack() {
  if (!pendingBack) return;
  pendingBack = null;
  const r = resolveBack;
  resolveBack = null;
  r?.();
  const fns = deferred.splice(0);
  for (const fn of fns) fn();
}

let popHooked = false;
function hookPopState() {
  if (popHooked) return;
  popHooked = true;
  globalThis.addEventListener?.('popstate', onPopState);
}

function onPopState(e) {
  const id = overlayIdOf(e.state);
  // Close every pushed overlay that is above the entry we landed on.
  for (let i = overlays.length - 1; i >= 0; i--) {
    const o = overlays[i];
    if (!o.pushed) continue;
    if (typeof id === 'number' && o.id <= id) break;
    overlays.splice(i, 1);
    if (!o.closing) {
      try {
        o.onPop?.();
      } catch (err) {
        globalThis.console?.error?.('[router] overlay onPop failed', err);
      }
    }
  }
  settleBack();
}

/**
 * Adds ONE history entry for a sheet or the viewer; Back calls onPop (and removes the entry).
 * close() removes the entry without calling onPop.
 * @param {() => void} onPop
 * @returns {{close(): void}}
 */
export function pushOverlay(onPop) {
  hookPopState();
  const o = { id: ++overlaySeq, onPop, pushed: false, closing: false };
  overlays.push(o);
  const h = hist();
  if (h && typeof h.pushState === 'function') {
    whenSettled(() => {
      if (!overlays.includes(o)) return; // closed before the push happened
      try {
        h.pushState({ ...(h.state && typeof h.state === 'object' ? h.state : {}), czdOverlay: o.id, czdSession: SESSION }, '', loc()?.href);
        o.pushed = true;
      } catch {
        // history unavailable (sandboxed) — Back simply won't close it
      }
    });
  }
  return {
    close() {
      const i = overlays.indexOf(o);
      if (i < 0) return;
      o.closing = true;
      if (!o.pushed) {
        overlays.splice(i, 1);
        return;
      }
      // Our entry is on top only when it's the current one; otherwise leave the stale entry
      // (Back then lands on the same URL, which is harmless).
      if (overlayIdOf(hist()?.state) === o.id) backAndWait();
      else overlays.splice(i, 1);
    },
  };
}

/**
 * Changes the route. With replace, the current history entry is replaced (no Back step).
 * Navigation waits for a pending overlay history.back() to land first.
 * @param {string} hash e.g. '#/vault' or '#/vault/item/<id>'
 * @param {{replace?: boolean}} [opts]
 */
export function navigate(hash, { replace = false } = {}) {
  const target = String(hash).startsWith('#') ? String(hash) : `#${hash}`;
  whenSettled(() => {
    const l = loc();
    if (!l) return;
    if (replace) {
      const url = `${l.href.split('#')[0]}${target}`;
      try {
        hist().replaceState(hist().state, '', url);
      } catch {
        l.replace(url);
        return;
      }
      if (started) render();
    } else if (l.hash === target) {
      if (started) render();
    } else {
      l.hash = target; // hashchange → render
    }
  });
}

/**
 * The current Route.
 * @returns {import('./types.js').Route}
 */
export function current() {
  return currentRoute;
}

function showFailure(el, err) {
  // Views still being built throw CzdError('not-implemented'): a warning, not an app error.
  const log = err?.code === 'not-implemented' ? globalThis.console?.warn : globalThis.console?.error;
  log?.call(globalThis.console, '[router] view failed', err);
  const doc = globalThis.document;
  if (!doc || !el) return;
  const box = doc.createElement('div');
  box.className = 'empty route-error';
  const t = doc.createElement('p');
  t.className = 'empty-title';
  t.textContent = "This part of cZEROde isn't available right now.";
  const s = doc.createElement('p');
  s.className = 'empty-text';
  s.textContent = 'Try reloading the page.';
  box.append(t, s);
  el.replaceChildren(box);
}

function unmountCurrent() {
  if (!currentView) return;
  const v = currentView;
  currentView = null;
  try {
    v.unmount?.();
  } catch (e) {
    globalThis.console?.error?.('[router] unmount failed', e);
  }
}

async function render() {
  const route = parseHash(loc()?.hash ?? '');
  const key = viewKey(route.top);
  if (!route.top || !Object.hasOwn(routes, key)) {
    if (route.top !== options.fallback) {
      navigate(`#/${options.fallback}`, { replace: true });
      return;
    }
    unmountCurrent();
    currentKey = null;
    showFailure(root, new Error(`no route for '${key}'`));
    return;
  }
  const seq = ++renderSeq;
  const prevTop = currentRoute.top;
  currentRoute = route;
  if (key === currentKey && currentView) {
    try {
      currentView.update?.(route);
    } catch (e) {
      globalThis.console?.error?.('[router] update failed', e);
    }
    state.set('route', route);
    return;
  }
  unmountCurrent();
  currentKey = key;
  root.replaceChildren();
  state.set('route', route);
  let mod;
  try {
    mod = await routes[key]();
  } catch (e) {
    if (seq === renderSeq) showFailure(root, e);
    return;
  }
  if (seq !== renderSeq) return; // a newer navigation won
  try {
    const view = mod.mount(root, route, options.ctx);
    currentView = view && typeof view === 'object' ? view : { unmount() {} };
  } catch (e) {
    currentView = null;
    showFailure(root, e);
  }
  if (prevTop && prevTop !== route.top) {
    globalThis.scrollTo?.(0, 0);
    try {
      root.focus?.({ preventScroll: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Starts routing into `root`. routes: {viewKey: () => Promise<ViewModule>} (keys: vault, send, text,
 * more, settings, about, legacy, codzilla — 'open'/'incoming' use 'send'). opts.ctx is passed to
 * mount() (default {vault: null, state}).
 * @param {HTMLElement} rootEl
 * @param {Record<string, () => Promise<import('./types.js').ViewModule>>} routeTable
 * @param {{fallback?: string, ctx?: object}} opts
 */
export function start(rootEl, routeTable, { fallback = 'vault', ctx } = {}) {
  if (started) throw new TypeError('router.start(): already started');
  root = rootEl;
  routes = { ...routeTable };
  options = { fallback, ctx: ctx ?? { vault: null, state } };
  started = true;
  globalThis.addEventListener?.('hashchange', () => render());
  hookPopState();
  render();
}
