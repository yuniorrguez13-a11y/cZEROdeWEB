// DOM building without HTML strings, plus toasts, modals and sheets.
// Owner: C1 (phase 1). Phase-0 stub: exports match DESIGN §10; bodies throw CzdError('not-implemented').

import { CzdError } from '../errors.js';

/** Creates an element. props: class, id, text, attrs{}, dataset{}, style{} (CSSOM), on{}, ref, disabled, checked, hidden, value, type, placeholder, href, title, alt, src, tabIndex, role, aria{}; 'style' in attrs throws. */
export function h(tag, props, ...children) {
  throw new CzdError('not-implemented');
}

/** Creates an SVG element. */
export function svg(tag, attrs, ...children) {
  throw new CzdError('not-implemented');
}

/** Removes all children. */
export function clear(el) {
  throw new CzdError('not-implemented');
}

/** Sprite icon (<svg><use>). */
export function icon(id, { label } = {}) {
  throw new CzdError('not-implemented');
}

/** action: {label, onClick}; returns {close()}. */
export function toast(msg, { kind = 'info', timeout = 4000, action } = {}) {
  throw new CzdError('not-implemented');
}

/** Resolves the chosen action value or null. */
export function modal({ title, body, actions = [], dismissible = true, className }) {
  throw new CzdError('not-implemented');
}

/** Full-screen on mobile, pushes history; returns {el, close()}. */
export function sheet({ title, body, onClose, className }) {
  throw new CzdError('not-implemented');
}

/** Resolves boolean. */
export function confirmDialog({ title, message, confirmLabel = 'OK', danger = false, typed }) {
  throw new CzdError('not-implemented');
}

/** Resolves string or null. */
export function promptDialog({ title, label, value = '', type = 'text', placeholder }) {
  throw new CzdError('not-implemented');
}

/** Returns release(). */
export function trapFocus(el) {
  throw new CzdError('not-implemented');
}

/** Returns off(). */
export function onOutside(el, fn) {
  throw new CzdError('not-implemented');
}

/** aria-live announcement. */
export function announce(msg) {
  throw new CzdError('not-implemented');
}
