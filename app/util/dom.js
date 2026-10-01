// DOM building without HTML strings, plus toasts, modals, sheets and focus helpers (DESIGN §2.2, §7).
// h() is the only way app code creates elements: no markup parsing, no inline handlers, no style
// attributes (CSSOM via props.style only), and URLs limited to '#…', relative paths and blob: URLs.

import * as state from '../state.js';
import { pushOverlay } from '../router.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
// SVG elements that run script, embed HTML, or (animation) can rewrite attributes such as href after our checks.
const SVG_BLOCKED = new Set(['script', 'foreignobject', 'style', 'iframe', 'set', 'animate', 'animatemotion', 'animatetransform', 'discard', 'handler', 'listener']);
const BLOCKED_TAGS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'meta', 'link', 'style', 'template', 'noscript', 'portal']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'xlink:href', 'cite', 'background', 'ping', 'manifest', 'codebase']);
// (Frame-only attributes need no entry: frame tags are blocked outright.)
const BLOCKED_ATTRS = new Set(['style', 'srcset', 'imagesrcset', 'is']);
// Plain DOM properties h() sets directly (besides the documented ones handled explicitly below).
const PROPS = new Set(['id', 'title', 'alt', 'disabled', 'checked', 'hidden', 'value', 'type', 'placeholder', 'tabIndex', 'name', 'htmlFor',
  'rows', 'cols', 'accept', 'multiple', 'download', 'target', 'rel', 'min', 'max', 'step', 'maxLength', 'minLength', 'readOnly', 'required',
  'autocomplete', 'inputMode', 'enterKeyHint', 'spellcheck', 'lang', 'dir', 'selected', 'open', 'controls', 'loop', 'muted', 'playsInline',
  'preload', 'autoplay', 'loading', 'decoding', 'width', 'height', 'draggable', 'colSpan', 'rowSpan', 'label', 'size', 'pattern', 'autofocus',
  'indeterminate', 'defaultValue', 'defaultChecked', 'noValidate', 'webkitdirectory', 'translate']);

function doc() {
  const d = globalThis.document;
  if (!d) throw new TypeError('dom: no document');
  return d;
}

/**
 * Checks a URL for href/src: '#…', a relative path, or a same-origin blob: URL. With
 * allowSameOrigin, absolute same-origin http(s) URLs pass too (svg sprite references).
 * Mirrors the URL parser's whitespace/control handling so "java\tscript:" and " //host" can't slip through.
 */
function checkUrl(value, { allowSameOrigin = false } = {}) {
  const s = String(value);
  if (s.startsWith('#')) return s;
  const d = doc();
  const base = new URL(d.baseURI);
  let u;
  try {
    u = new URL(s, base);
  } catch {
    throw new TypeError(`dom: invalid URL ${JSON.stringify(s.slice(0, 80))}`);
  }
  if (u.protocol === 'blob:') {
    if (u.origin === base.origin) return s;
    throw new TypeError('dom: cross-origin blob: URL');
  }
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u0020]/g, '');
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(cleaned);
  if (u.origin !== base.origin || (hasScheme && !allowSameOrigin)) {
    throw new TypeError(`dom: URL not allowed ${JSON.stringify(s.slice(0, 80))} (only '#…', relative or blob:)`);
  }
  return s;
}

function setAttr(el, name, value, { svg = false } = {}) {
  const n = String(name);
  const lower = n.toLowerCase();
  if (lower.startsWith('on')) throw new TypeError(`dom: event handler attribute '${n}' is not allowed — use props.on`);
  if (BLOCKED_ATTRS.has(lower)) throw new TypeError(`dom: attribute '${n}' is not allowed${lower === 'style' ? ' — use props.style (CSSOM)' : ''}`);
  if (value === null || value === undefined || value === false) {
    el.removeAttribute(n);
    return;
  }
  let v = value === true ? '' : String(value);
  if (URL_ATTRS.has(lower)) v = checkUrl(v, { allowSameOrigin: svg });
  el.setAttribute(n, v);
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (typeof c === 'string' || typeof c === 'number' || typeof c === 'bigint') el.append(String(c));
    else if (c && typeof c.nodeType === 'number') el.append(c);
    else throw new TypeError('dom: children must be nodes, strings, numbers, arrays or null');
  }
}

function classList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.flat(Infinity).filter(Boolean).flatMap((x) => String(x).split(/\s+/)).filter(Boolean);
  return String(v).split(/\s+/).filter(Boolean);
}

/**
 * Creates an element.
 * props: class (string|string[]), id, text (textContent), attrs{}, dataset{}, style{} (CSSOM; '--x' via
 * setProperty), on{type: fn}, ref(el), aria{} (aria-*; booleans → "true"/"false"), role, disabled, checked,
 * hidden, value, type, placeholder, href ('#…'|relative|blob:), title, alt, src (relative|blob:), tabIndex,
 * plus common form/media properties (name, htmlFor, rows, accept, multiple, download, target, autocomplete…).
 * Unknown keys become attributes through the same checks. 'style'/on* in attrs throw.
 * target=_blank links get rel="noopener noreferrer".
 * @param {string} tag
 * @param {object|null} [props]
 * @param {...any} children nodes, strings, numbers, arrays, null/false (skipped)
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const t = String(tag).toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(t) || BLOCKED_TAGS.has(t)) throw new TypeError(`dom: tag <${tag}> is not allowed`);
  const el = doc().createElement(t);
  const p = props ?? {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || k === 'value') continue; // value is set after children (<select> options, input type)
    switch (k) {
      case 'class':
      case 'className':
        el.classList.add(...classList(v));
        break;
      case 'text':
        el.textContent = v === null ? '' : String(v);
        break;
      case 'attrs':
        for (const [a, av] of Object.entries(v ?? {})) setAttr(el, a, av);
        break;
      case 'dataset':
        for (const [dk, dv] of Object.entries(v ?? {})) if (dv !== undefined && dv !== null) el.dataset[dk] = String(dv);
        break;
      case 'style':
        if (typeof v !== 'object' || v === null) throw new TypeError('dom: props.style must be an object (CSSOM)');
        for (const [sk, sv] of Object.entries(v)) {
          if (sv === undefined || sv === null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
          else el.style[sk] = sv;
        }
        break;
      case 'on':
        for (const [type, fn] of Object.entries(v ?? {})) {
          if (typeof fn === 'function') el.addEventListener(type, fn);
          else if (Array.isArray(fn)) el.addEventListener(type, fn[0], fn[1]);
        }
        break;
      case 'aria':
        for (const [ak, av] of Object.entries(v ?? {})) {
          if (av === undefined || av === null) continue;
          el.setAttribute(`aria-${ak}`, typeof av === 'boolean' ? String(av) : String(av));
        }
        break;
      case 'role':
        if (v !== null) el.setAttribute('role', String(v));
        break;
      case 'href':
      case 'src':
        if (v !== null) el[k] = checkUrl(v);
        break;
      case 'ref':
        break;
      case 'for':
        el.htmlFor = String(v);
        break;
      default:
        if (PROPS.has(k)) {
          if (k === 'webkitdirectory') el.webkitdirectory = !!v;
          else if (v !== null) el[k] = v;
        } else {
          setAttr(el, k, v);
        }
    }
  }
  if (el.target === '_blank') el.rel = 'noopener noreferrer';
  append(el, children);
  if (p.value !== undefined && p.value !== null) el.value = p.value;
  if (typeof p.ref === 'function') p.ref(el);
  return el;
}

/**
 * Creates an SVG element. attrs are set as attributes (no style, no on*, href limited to '#…',
 * relative, blob: or same-origin URLs).
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...any} children
 * @returns {SVGElement}
 */
export function svg(tag, attrs, ...children) {
  const t = String(tag);
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(t) || SVG_BLOCKED.has(t.toLowerCase())) {
    throw new TypeError(`dom: svg tag <${tag}> is not allowed`);
  }
  const el = doc().createElementNS(SVG_NS, t);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === 'class') el.setAttribute('class', classList(v).join(' '));
    else setAttr(el, k, v, { svg: true });
  }
  append(el, children);
  return el;
}

/**
 * Removes all children.
 * @param {Element} el
 * @returns {Element}
 */
export function clear(el) {
  el.replaceChildren();
  return el;
}

const SPRITE = new URL('../../assets/icons/sprite.svg', import.meta.url).href;

/**
 * Sprite icon: <svg class="icon"><use href="assets/icons/sprite.svg#id"></svg>. Decorative
 * (aria-hidden) unless a label is given (role=img + aria-label).
 * @param {string} id symbol id from assets/icons/sprite.svg
 * @param {{label?: string, className?: string}} [opts]
 * @returns {SVGSVGElement}
 */
export function icon(id, { label, className } = {}) {
  if (!/^[a-z0-9-]+$/.test(String(id))) throw new TypeError(`dom: bad icon id ${id}`);
  const attrs = { class: ['icon', `icon-${id}`, className], viewBox: '0 0 24 24', focusable: 'false' };
  if (label) Object.assign(attrs, { role: 'img', 'aria-label': String(label) });
  else attrs['aria-hidden'] = 'true';
  return svg('svg', attrs, svg('use', { href: `${SPRITE}#${id}` }));
}

// ───────── layers (modals, sheets): inert background, Esc, focus restore

const layers = []; // [{el, close(value)}], topmost last
// Whether WE made #app inert. When another overlay (the viewer) already had it inert we leave it alone,
// and on the last close we only undo our own change — never forcing it off, never leaving it stuck on.
let weSetInert = false;

function appRoot() {
  return globalThis.document?.getElementById('app') ?? null;
}

function overlayRoot() {
  const d = doc();
  let r = d.getElementById('modals');
  if (!r) {
    r = h('div', { id: 'modals', class: 'modal-root' });
    d.body.append(r);
  }
  return r;
}

function syncInert() {
  const app = appRoot();
  if (app && layers.length && !app.inert) {
    app.inert = true;
    weSetInert = true;
  } else if (app && !layers.length && weSetInert) {
    app.inert = false;
    weSetInert = false;
  }
  layers.forEach((l, i) => {
    l.el.inert = i !== layers.length - 1;
  });
  globalThis.document?.documentElement.classList.toggle('has-overlay', layers.length > 0);
}

function pushLayer(layer) {
  layers.push(layer);
  syncInert();
}

function removeLayer(layer) {
  const i = layers.indexOf(layer);
  if (i >= 0) layers.splice(i, 1);
  syncInert();
}

// Lock clears the screen: every modal/sheet closes, and every toast shown before the lock (they can hold
// decrypted names, and an "Undo" must not outlive the lock). Registered at load so it runs before the
// handlers of modules loaded later, whose own "Locked" toasts then stay. No DOM needed until it runs.
state.onPurge(() => {
  for (const l of [...layers].reverse()) l.close(null, { purge: true });
  for (const close of [...openToasts.keys()]) close();
});

let layerHooks = false;
function installLayerHooks() {
  if (layerHooks) return;
  layerHooks = true;
  // Esc closes the topmost dismissible layer (an open menu inside it handles its own Esc first).
  doc().addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !layers.length) return;
    if (e.target instanceof Element && e.target.closest('[role="menu"]')) return;
    const top = layers.at(-1);
    if (top.dismissible === false) return;
    e.preventDefault();
    e.stopPropagation();
    top.close(null);
  }, true);
  // A different top-level route closes modals opened for the old one.
  state.on('route', (route, { old }) => {
    if (!old || old.top === route?.top) return;
    for (const l of [...layers].reverse()) if (l.kind === 'modal') l.close(null);
  });
}

function focusables(el) {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), '
    + '[tabindex]:not([tabindex="-1"]), audio[controls], video[controls], summary, [contenteditable="true"]';
  return [...el.querySelectorAll(sel)].filter((x) => !x.closest('[hidden], [inert]') && x.getClientRects().length > 0);
}

/**
 * Keeps keyboard focus inside `el`: Tab/Shift+Tab wrap around, and focus moves into el now
 * (first [data-autofocus]/[autofocus] or focusable element, else el itself). Returns release().
 * @param {HTMLElement} el
 * @returns {() => void} release
 */
export function trapFocus(el) {
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const f = focusables(el);
    if (!f.length) {
      e.preventDefault();
      el.focus();
      return;
    }
    const first = f[0];
    const last = f.at(-1);
    const active = el.ownerDocument.activeElement;
    if (e.shiftKey && (active === first || !el.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !el.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  el.addEventListener('keydown', onKey);
  if (!el.contains(el.ownerDocument.activeElement)) {
    const target = el.querySelector('[data-autofocus], [autofocus]') ?? focusables(el)[0] ?? el;
    if (target === el && !el.hasAttribute('tabindex')) el.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  return () => el.removeEventListener('keydown', onKey);
}

/**
 * Calls fn(event) on a pointerdown outside `el` (capture phase). Returns off().
 * @param {Element} el
 * @param {(e: Event) => void} fn
 * @returns {() => void}
 */
export function onOutside(el, fn) {
  const d = el.ownerDocument ?? doc();
  const handler = (e) => {
    if (!el.isConnected) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(el) || el.contains(e.target)) return;
    fn(e);
  };
  d.addEventListener('pointerdown', handler, true);
  return () => d.removeEventListener('pointerdown', handler, true);
}

let announcer = null;
/**
 * Announces a message to screen readers (polite live region).
 * @param {string} msg
 */
export function announce(msg) {
  const d = doc();
  if (!announcer || !announcer.isConnected) {
    announcer = h('div', { id: 'announcer', class: 'visually-hidden', aria: { live: 'polite', atomic: 'true' } });
    d.body.append(announcer);
  }
  announcer.textContent = '';
  const text = String(msg ?? '');
  // A fresh text node in the next frame makes repeated messages announce again.
  const raf = globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 16));
  raf(() => {
    announcer.textContent = text;
  });
}

// ───────── toasts

const TOAST_ICON = { info: 'info', ok: 'check', warn: 'warning', err: 'warning' };
const MAX_TOASTS = 3;
const openToasts = new Map(); // close → element, oldest first, for every toast still shown

function toastRoot() {
  const d = doc();
  let r = d.getElementById('toasts');
  if (!r) {
    r = h('div', { id: 'toasts', class: 'toasts', role: 'region', aria: { live: 'polite', label: 'Notifications' } });
    d.body.append(r);
  }
  return r;
}

/**
 * Shows a toast (pill at the bottom; announced politely). timeout 0 = stays until closed.
 * action: {label, onClick} adds a button (e.g. Undo); the timer pauses while hovered/focused.
 * @param {string} msg
 * @param {{kind?: 'info'|'ok'|'warn'|'err', timeout?: number, action?: {label: string, onClick: () => void}}} [opts]
 * @returns {{close(): void, el: HTMLElement}}
 */
export function toast(msg, { kind = 'info', timeout = 4000, action } = {}) {
  const root = toastRoot();
  const k = Object.hasOwn(TOAST_ICON, kind) ? kind : 'info';
  let timer = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openToasts.delete(close);
    clearTimeout(timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  };
  // The #toasts container is the (polite) live region; errors interrupt.
  const el = h('div', { class: ['toast', `toast-${k}`], role: k === 'err' ? 'alert' : null },
    icon(TOAST_ICON[k]),
    h('span', { class: 'toast-msg', text: msg }),
    action ? h('button', {
      type: 'button',
      class: 'toast-action',
      text: action.label,
      on: {
        click: () => {
          close();
          try {
            action.onClick?.();
          } catch (e) {
            globalThis.console?.error?.(e);
          }
        },
      },
    }) : null);
  // 0, negative, Infinity or NaN = stays until closed (setTimeout would turn Infinity into 0).
  const ms = Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 2 ** 31 - 1) : 0;
  const arm = () => {
    clearTimeout(timer);
    if (ms > 0 && !closed) timer = setTimeout(close, ms);
  };
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', arm);
  root.append(el);
  openToasts.set(close, el);
  for (const [oldClose, oldEl] of [...openToasts].slice(0, Math.max(0, openToasts.size - MAX_TOASTS))) {
    oldClose();
    oldEl.remove();
  }
  const raf = globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 16));
  raf(() => el.classList.add('show'));
  arm();
  return { close, el };
}

// ───────── modal / sheet / dialogs

function bodyNodes(body) {
  if (body === null || body === undefined) return [];
  if (typeof body === 'string') return body.split(/\n{2,}/).map((para) => h('p', { text: para }));
  return [body];
}

let idSeq = 0;
const uid = (p) => `${p}-${++idSeq}`;
/** Enter that confirms an IME composition (CJK input) must not submit (keyCode 229: Safari/old Chromium). */
const composing = (e) => e.isComposing || e.keyCode === 229;

/**
 * Modal dialog. Resolves with the clicked action's value (its label when value is undefined),
 * or null when dismissed (Esc, backdrop, close button, route change, lock).
 * actions: [{label, kind: 'primary'|'ghost'|'danger'|'go'|undefined, value, autofocus, disabled}].
 * The returned promise also has .close(value) and .el.
 * @param {{title?: string, body?: any, actions?: Array<object>, dismissible?: boolean, className?: string}} opts
 * @returns {Promise<any>}
 */
export function modal({ title, body, actions = [], dismissible = true, className } = {}) {
  installLayerHooks();
  const d = doc();
  const titleId = uid('modal-title');
  const previous = d.activeElement;
  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });
  let release = () => {};
  let finished = false;
  const layer = { kind: 'modal', dismissible };
  const close = (value = null) => {
    if (finished) return;
    finished = true;
    release();
    removeLayer(layer);
    backdrop.remove();
    if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    resolve(value);
  };
  layer.close = close;
  const buttons = actions.map((a) => h('button', {
    type: 'button',
    class: ['btn', a.kind ? `btn-${a.kind}` : null],
    text: a.label,
    disabled: !!a.disabled,
    dataset: { autofocus: a.autofocus ? '' : undefined },
    on: { click: () => close(a.value !== undefined ? a.value : a.label) },
  }));
  const panel = h('div', { class: ['modal', className], role: 'dialog', aria: { modal: 'true', labelledby: title ? titleId : undefined }, tabIndex: -1 },
    (title || dismissible) ? h('div', { class: 'modal-head' },
      title ? h('h2', { class: 'modal-title', id: titleId, text: title }) : h('span'),
      dismissible ? h('button', { type: 'button', class: 'btn-icon modal-close', aria: { label: 'Close' }, on: { click: () => close(null) } }, icon('close')) : null) : null,
    h('div', { class: 'modal-body' }, bodyNodes(body)),
    buttons.length ? h('div', { class: 'modal-actions' }, buttons) : null);
  const backdrop = h('div', { class: 'modal-backdrop', on: { pointerdown: (e) => {
    if (e.target === backdrop && dismissible) close(null);
  } } }, panel);
  layer.el = backdrop;
  overlayRoot().append(backdrop);
  pushLayer(layer);
  release = trapFocus(panel);
  done.close = close;
  done.el = panel;
  return done;
}

/**
 * Sheet: a large panel (full-screen on phones) with a title bar and a close button. Opening pushes
 * ONE history entry (Back closes it). onClose runs once, however it closes.
 * @param {{title?: string, body?: any, onClose?: () => void, className?: string}} opts
 * @returns {{el: HTMLElement, body: HTMLElement, close(): void}}
 */
export function sheet({ title, body, onClose, className } = {}) {
  installLayerHooks();
  const d = doc();
  const titleId = uid('sheet-title');
  const previous = d.activeElement;
  let release = () => {};
  let finished = false;
  let overlay = null;
  const layer = { kind: 'sheet', dismissible: true };
  const finish = (fromPop) => {
    if (finished) return;
    finished = true;
    release();
    removeLayer(layer);
    wrap.remove();
    if (!fromPop) overlay?.close();
    if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    try {
      onClose?.();
    } catch (e) {
      globalThis.console?.error?.(e);
    }
  };
  layer.close = () => finish(false);
  const content = h('div', { class: 'sheet-body' }, bodyNodes(body));
  const panel = h('section', { class: ['sheet', className], role: 'dialog', aria: { modal: 'true', labelledby: title ? titleId : undefined }, tabIndex: -1 },
    h('div', { class: 'sheet-head' },
      h('button', { type: 'button', class: 'btn-icon sheet-back', aria: { label: 'Close' }, on: { click: () => finish(false) } }, icon('back')),
      h('h2', { class: 'sheet-title', id: titleId, text: title ?? '' }),
      h('button', { type: 'button', class: 'btn-icon sheet-close', aria: { label: 'Close' }, on: { click: () => finish(false) } }, icon('close'))),
    content);
  const wrap = h('div', { class: 'sheet-backdrop', on: { pointerdown: (e) => {
    if (e.target === wrap) finish(false);
  } } }, panel);
  layer.el = wrap;
  overlayRoot().append(wrap);
  pushLayer(layer);
  // Focus the panel itself (screen readers read the title; phones don't pop the keyboard) unless
  // the content marks an element with data-autofocus.
  if (!panel.querySelector('[data-autofocus], [autofocus]')) panel.focus({ preventScroll: true });
  release = trapFocus(panel);
  overlay = pushOverlay(() => finish(true));
  return { el: panel, body: content, close: () => finish(false) };
}

/**
 * Confirmation dialog. typed: a word the user must type to enable the confirm button (e.g. 'DELETE').
 * @param {{title?: string, message?: string, confirmLabel?: string, danger?: boolean, typed?: string}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, confirmLabel = 'OK', danger = false, typed } = {}) {
  const parts = bodyNodes(message);
  let input = null;
  if (typed) {
    const id = uid('confirm-typed');
    input = h('input', { class: 'input', id, type: 'text', autocomplete: 'off', spellcheck: false, attrs: { autocapitalize: 'characters', autocorrect: 'off' } });
    parts.push(h('div', { class: 'field' }, h('label', { class: 'label', for: id, text: `Type ${typed} to confirm` }), input));
  }
  const p = modal({
    title,
    body: h('div', { class: 'stack' }, parts),
    actions: [
      { label: 'Cancel', kind: 'ghost', value: false },
      { label: confirmLabel, kind: danger ? 'danger' : 'primary', value: true, autofocus: !typed, disabled: !!typed },
    ],
  });
  if (input) {
    const ok = p.el.querySelector('.modal-actions .btn:last-child');
    input.addEventListener('input', () => {
      ok.disabled = input.value.trim() !== typed;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !composing(e) && !ok.disabled) {
        e.preventDefault();
        p.close(true);
      }
    });
    input.focus();
  }
  return p.then((v) => v === true);
}

/**
 * Asks for a short text (never a secret: use passphraseField for those). Enter submits.
 * @param {{title?: string, label?: string, value?: string, type?: string, placeholder?: string}} opts
 * @returns {Promise<string|null>}
 */
export function promptDialog({ title, label, value = '', type = 'text', placeholder } = {}) {
  if (type === 'password') throw new TypeError('promptDialog: secrets must use passphraseField');
  const id = uid('prompt');
  const input = h('input', { class: 'input', id, type, value, placeholder, autocomplete: 'off', spellcheck: false });
  const p = modal({
    title,
    body: h('div', { class: 'field' }, label ? h('label', { class: 'label', for: id, text: label }) : null, input),
    actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: 'OK', kind: 'primary', value: '__ok__' }],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !composing(e)) {
      e.preventDefault();
      p.close('__ok__');
    }
  });
  input.focus();
  input.select();
  return p.then((v) => (v === '__ok__' ? input.value : null));
}
