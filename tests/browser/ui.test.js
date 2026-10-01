// Browser units for the UI kit and shell (runner: tests/browser/index.html?suite=ui, app CSP):
// dom.h safety rules, toasts/modals/sheets/focus trap, components behaviour, passphraseField rules
// (easter egg only on secret-setting purposes, debounce, once per focus, purge clear), router + shell.
import { h, svg, icon, clear, toast, modal, sheet, confirmDialog, promptDialog, trapFocus, onOutside, announce, BACKDROP_GRACE_MS } from '../../app/util/dom.js';
import * as C from '../../app/ui/components.js';
import * as state from '../../app/state.js';
import * as router from '../../app/router.js';
import { mountShell } from '../../app/ui/shell.js';
import { maybeEasterEgg, showSkull } from '../../app/ui/easter.js';
import * as codzilla from '../../app/ui/codzilla.js';
import { openTutorial, STEPS } from '../../app/ui/tutorial.js';
import { setVault } from '../../app/vault/vault.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const key = (el, k, opts = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
const type = (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof TypeError;
  }
};
const skulls = () => document.querySelectorAll('.eg-modal').length;
const closeAllModals = async () => {
  for (const b of [...document.querySelectorAll('.modal-close')].reverse()) b.click();
  await wait(10);
};

export default async function (t) {
  // App stylesheets make visibility/focus behave as in the app.
  for (const href of ['../../css/app.css', '../../css/extras.css']) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.append(l);
  }
  const app = document.createElement('div');
  app.id = 'app';
  document.body.append(app);
  await wait(50);

  t.test('h(): props, children, CSSOM style, events, aria, dataset, ref', () => {
    let clicked = 0;
    let refEl = null;
    const el = h('button', {
      class: ['a', null, 'b c'], id: 'x1', text: 'Hi', type: 'button', title: 'T', disabled: false,
      dataset: { k: 'v', n: 3 }, style: { width: '12px', '--custom': '4' }, on: { click: () => clicked++ },
      aria: { label: 'L', pressed: false }, role: 'switch', tabIndex: 2, ref: (e) => { refEl = e; },
    });
    t.equal(el.tagName, 'BUTTON');
    t.equal(el.className, 'a b c');
    t.equal(el.id, 'x1');
    t.equal(el.textContent, 'Hi');
    t.equal(el.dataset.k, 'v');
    t.equal(el.dataset.n, '3');
    t.equal(el.style.width, '12px');
    t.equal(el.style.getPropertyValue('--custom'), '4');
    t.equal(el.getAttribute('aria-label'), 'L');
    t.equal(el.getAttribute('aria-pressed'), 'false');
    t.equal(el.getAttribute('role'), 'switch');
    t.equal(el.tabIndex, 2);
    t.equal(el.getAttribute('style'), 'width: 12px; --custom: 4;', 'style only via CSSOM');
    el.click();
    t.equal(clicked, 1);
    t.equal(refEl, el);
    const p = h('p', null, 'a', 1, null, false, true, undefined, ['b', [h('i', { text: 'c' })]]);
    t.equal(p.textContent, 'a1bc');
    t.equal(h('p', { text: '<b>x</b>' }).childElementCount, 0, 'text is never parsed');
    const a = h('a', { href: '#/vault', target: '_blank' });
    t.equal(a.getAttribute('href'), '#/vault');
    t.equal(a.rel, 'noopener noreferrer');
    t.equal(h('label', { for: 'x1' }).htmlFor, 'x1');
    t.equal(h('input', { attrs: { autocapitalize: 'none', 'data-x': 1 } }).getAttribute('autocapitalize'), 'none');
    t.equal(h('div', { 'data-free': 'ok' }).dataset.free, 'ok', 'unknown keys become checked attributes');
    const sel = h('select', { value: 'b' }, h('option', { value: 'a', text: 'A' }), h('option', { value: 'b', text: 'B' }));
    t.equal(sel.value, 'b', 'select value applied after its options');
    t.equal(h('input', { value: 7, type: 'range', min: 0, max: 10 }).value, '7', 'value after type/min/max');
    t.equal(h('textarea', { value: 'hi' }).value, 'hi');
  });

  t.test('h(): rejects style/on* attributes, unsafe tags and URLs', () => {
    t.assert(throws(() => h('div', { attrs: { style: 'color:red' } })), 'attrs.style');
    t.assert(throws(() => h('div', { attrs: { onclick: 'x()' } })), 'attrs.onclick');
    t.assert(throws(() => h('div', { attrs: { ONLOAD: 'x()' } })), 'attrs.ONLOAD');
    t.assert(throws(() => h('div', { onerror: 'x()' })), 'on* as a prop');
    t.assert(throws(() => h('div', { style: 'color:red' })), 'string style');
    t.assert(throws(() => h('source', { attrs: { srcset: 'x.png 1x' } })), 'srcset');
    for (const tag of ['script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base', 'SCRIPT', 'template']) t.assert(throws(() => h(tag)), tag);
    for (const url of ['javascript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'JAVASCRIPT:x', '\u0001javascript:x',
      '//evil.example/x', '/\\evil.example/x', '\\\\evil.example', 'https://evil.example/', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd',
      `${location.origin}/index.html`]) {
      t.assert(throws(() => h('a', { href: url })), `href ${JSON.stringify(url)}`);
      t.assert(throws(() => h('a', { attrs: { href: url } })), `attrs.href ${JSON.stringify(url)}`);
    }
    t.assert(throws(() => h('track', { src: 'https://evil.example/a.vtt' })), 'remote src');
    t.assert(throws(() => h('track', { src: 'blob:https://evil.example/123' })), 'cross-origin blob');
    t.assert(throws(() => h('form', { action: 'https://evil.example' })), 'form action');
    // <track> outside a media element never fetches, so these checks load nothing.
    const blob = URL.createObjectURL(new Blob(['x']));
    t.equal(h('track', { src: blob }).getAttribute('src'), blob, 'same-origin blob: ok');
    URL.revokeObjectURL(blob);
    t.equal(h('track', { src: './a.vtt' }).getAttribute('src'), './a.vtt', 'relative ok');
    t.equal(h('a', { href: 'page.html?x=1#y' }).getAttribute('href'), 'page.html?x=1#y');
  });

  t.test('svg() and icon()', () => {
    const s = svg('svg', { viewBox: '0 0 1 1', class: ['k'] }, svg('path', { d: 'M0 0' }));
    t.equal(s.namespaceURI, 'http://www.w3.org/2000/svg');
    t.equal(s.getAttribute('class'), 'k');
    t.assert(throws(() => svg('script')), 'svg script');
    t.assert(throws(() => svg('foreignObject')), 'foreignObject');
    t.assert(throws(() => svg('a', { href: 'javascript:x' })), 'svg javascript href');
    t.assert(throws(() => svg('use', { href: 'https://evil.example/s.svg#x' })), 'svg external href');
    t.assert(throws(() => svg('g', { onload: 'x' })), 'svg on*');
    const i = icon('lock');
    t.equal(i.getAttribute('aria-hidden'), 'true');
    t.assert(i.classList.contains('icon') && i.classList.contains('icon-lock'));
    t.assert(i.querySelector('use').getAttribute('href').endsWith('/assets/icons/sprite.svg#lock'));
    const l = icon('trash', { label: 'Delete' });
    t.equal(l.getAttribute('role'), 'img');
    t.equal(l.getAttribute('aria-label'), 'Delete');
    t.equal(l.getAttribute('aria-hidden'), null);
    t.assert(throws(() => icon('x"><script')), 'bad id');
    const box = h('div', null, h('span'), 'x');
    t.equal(clear(box).childNodes.length, 0);
  });

  t.test('sprite has every §7 icon', async () => {
    const res = await fetch('../../assets/icons/sprite.svg');
    const doc = new DOMParser().parseFromString(await res.text(), 'image/svg+xml');
    const ids = new Set([...doc.querySelectorAll('symbol')].map((s) => s.id));
    for (const id of ['lock', 'unlock', 'upload', 'folder', 'download', 'send', 'share', 'trash', 'play', 'pause', 'prev', 'next', 'shuffle', 'repeat',
      'repeat-one', 'image', 'video', 'music', 'file', 'note', 'search', 'settings', 'close', 'check', 'eye', 'eye-off', 'copy', 'key', 'star',
      'star-filled', 'album', 'plus', 'more', 'grid', 'list', 'warning', 'info', 'back', 'refresh', 'zoom']) t.assert(ids.has(id), `symbol ${id}`);
  });

  t.test('toast: live region, action, timeout, max 3', async () => {
    let undone = 0;
    const a = toast('Deleted 2', { action: { label: 'Undo', onClick: () => undone++ }, timeout: 0 });
    const root = document.getElementById('toasts');
    t.equal(root.getAttribute('aria-live'), 'polite');
    t.assert(root.contains(a.el));
    a.el.querySelector('.toast-action').click();
    t.equal(undone, 1);
    await wait(260);
    t.assert(!a.el.isConnected, 'closed after action');
    const b = toast('short', { timeout: 30, kind: 'err' });
    t.equal(b.el.getAttribute('role'), 'alert');
    await wait(300);
    t.assert(!b.el.isConnected, 'timed out');
    const many = [1, 2, 3, 4, 5].map((n) => toast(`n${n}`, { timeout: 0 }));
    t.equal(root.querySelectorAll('.toast').length, 3);
    many.forEach((x) => x.close());
    t.equal(toast('<img src=x>', { timeout: 1 }).el.querySelector('img'), null, 'message is text');
  });

  t.test('modal: value, Esc, backdrop, aria, inert background, focus restore', async () => {
    const opener = h('button', { type: 'button', text: 'open' });
    document.body.append(opener);
    opener.focus();
    const p = modal({ title: 'Hello', body: 'Para one\n\nPara two', actions: [{ label: 'No', value: false }, { label: 'Yes', kind: 'primary', value: 'yes', autofocus: true }] });
    t.equal(p.el.getAttribute('role'), 'dialog');
    t.equal(p.el.getAttribute('aria-modal'), 'true');
    t.equal(document.getElementById(p.el.getAttribute('aria-labelledby')).textContent, 'Hello');
    t.equal(p.el.querySelectorAll('.modal-body p').length, 2);
    t.equal(document.activeElement.textContent, 'Yes', 'autofocus');
    t.equal(document.getElementById('app').inert, true, 'background inert');
    t.assert(document.documentElement.classList.contains('has-overlay'));
    p.el.querySelector('.btn-primary').click();
    t.equal(await p, 'yes');
    t.equal(document.getElementById('app').inert, false);
    t.equal(document.activeElement, opener, 'focus restored');
    const p2 = modal({ title: 'Esc me', actions: [{ label: 'OK' }] });
    key(document.activeElement, 'Escape');
    t.equal(await p2, null);
    const p3 = modal({ title: 'Backdrop' });
    const bd = p3.el.parentElement;
    // The second click of a double click on the opener lands on the backdrop: ignored during the grace period.
    bd.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await wait(20);
    t.assert(p3.el.isConnected, 'a backdrop press right after opening is ignored');
    await wait(BACKDROP_GRACE_MS);
    bd.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    t.equal(await p3, null);
    const p4 = modal({ title: 'Sticky', dismissible: false, actions: [{ label: 'Only way out', value: 1 }] });
    key(document.activeElement, 'Escape');
    p4.el.parentElement.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await wait(20);
    t.assert(p4.el.isConnected, 'not dismissible');
    t.equal(p4.el.querySelector('.modal-close'), null);
    p4.el.querySelector('.btn').click();
    t.equal(await p4, 1);
    const p5 = modal({ title: 'label value', actions: [{ label: 'Go' }] });
    p5.el.querySelector('.btn').click();
    t.equal(await p5, 'Go', 'value defaults to the label');
    opener.remove();
  });

  t.test('modal/sheet/confirmDialog: backdrop grace period, busy, returnFocus when the opener is gone', async () => {
    const press = (el) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    // busy: a function checked at each press (a running job keeps the dialog), or a plain flag.
    let running = true;
    const p = modal({ title: 'Working', busy: () => running });
    await wait(BACKDROP_GRACE_MS + 20);
    press(p.el.parentElement);
    await wait(20);
    t.assert(p.el.isConnected, 'busy keeps it');
    running = false;
    press(p.el.parentElement);
    t.equal(await p, null, 'not busy any more: the backdrop dismisses it');
    const flag = modal({ title: 'Flag', busy: true });
    await wait(BACKDROP_GRACE_MS + 20);
    press(flag.el.parentElement);
    await wait(20);
    t.assert(flag.el.isConnected, 'busy: true keeps it');
    flag.close();
    await flag;

    // confirmDialog gets the grace period too (its modal handle is hidden).
    const asked = confirmDialog({ title: 'Sure?', message: 'Really' });
    const cbd = document.querySelector('#modals > .modal-backdrop:last-child');
    press(cbd);
    await wait(20);
    t.assert(cbd.isConnected, 'confirmDialog: early press ignored');
    await wait(BACKDROP_GRACE_MS);
    press(cbd);
    t.equal(await asked, false);

    // sheet: grace period, then the backdrop closes it (onClose once).
    let closes = 0;
    const s = sheet({ title: 'Sheet', body: 'x', onClose: () => closes++ });
    const sbd = s.el.parentElement;
    press(sbd);
    await wait(20);
    t.assert(s.el.isConnected, 'sheet: early press ignored');
    await wait(BACKDROP_GRACE_MS);
    press(sbd);
    t.assert(!s.el.isConnected, 'sheet closed by the backdrop');
    t.equal(closes, 1);
    await wait(100); // its history entry pops
    history.pushState(null, '', location.href); // no forward entry left behind for later history-length checks

    // returnFocus: the opener was re-rendered while the dialog was up.
    const host = h('div', null, h('button', { type: 'button', class: 'rf-old', text: 'old' }));
    document.body.append(host);
    host.firstChild.focus();
    const r = modal({ title: 'Return', actions: [{ label: 'OK', value: 1 }], returnFocus: () => host.querySelector('.rf-new') });
    host.replaceChildren(h('button', { type: 'button', class: 'rf-new', text: 'new' }));
    r.el.querySelector('.btn').click();
    t.equal(await r, 1);
    t.equal(document.activeElement, host.querySelector('.rf-new'), 'focus goes to returnFocus() when the opener is gone');
    // The opener still there: it wins over returnFocus.
    const keep = host.firstChild;
    keep.focus();
    const r2 = modal({ title: 'Return 2', actions: [{ label: 'OK' }], returnFocus: () => null });
    r2.el.querySelector('.btn').click();
    await r2;
    t.equal(document.activeElement, keep);
    host.remove();
  });

  t.test('trapFocus: Tab wraps inside, release() stops it', () => {
    const a = h('button', { type: 'button', text: 'a' });
    const b = h('input', {});
    const c = h('button', { type: 'button', text: 'c' });
    const hiddenBtn = h('button', { type: 'button', text: 'hidden', hidden: true });
    const box = h('div', null, a, b, hiddenBtn, c);
    document.body.append(box);
    const release = trapFocus(box);
    t.equal(document.activeElement, a, 'first focusable');
    c.focus();
    key(c, 'Tab');
    t.equal(document.activeElement, a, 'Tab on last → first');
    key(a, 'Tab', { shiftKey: true });
    t.equal(document.activeElement, c, 'Shift+Tab on first → last');
    release();
    c.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    c.dispatchEvent(ev);
    t.equal(ev.defaultPrevented, false, 'released');
    const empty = h('div', null, h('p', { text: 'no focusables' }));
    document.body.append(empty);
    const rel2 = trapFocus(empty);
    t.equal(document.activeElement, empty, 'container itself when nothing is focusable');
    rel2();
    box.remove();
    empty.remove();
  });

  t.test('modal focus trap keeps Tab inside the dialog', async () => {
    const p = modal({ title: 'Trap', actions: [{ label: 'One' }, { label: 'Two', autofocus: true }] });
    const btns = [...p.el.querySelectorAll('button')]; // close, One, Two
    btns.at(-1).focus();
    key(btns.at(-1), 'Tab');
    t.equal(document.activeElement, btns[0], 'wraps to the first (close) button');
    key(btns[0], 'Tab', { shiftKey: true });
    t.equal(document.activeElement, btns.at(-1));
    p.close();
    await p;
  });

  t.test('confirmDialog (typed) and promptDialog', async () => {
    const c = confirmDialog({ title: 'Delete vault?', message: 'Sure?', confirmLabel: 'Delete', danger: true, typed: 'DELETE' });
    await frame();
    const dlg = document.querySelector('.modal:last-of-type') ?? document.querySelectorAll('.modal')[0];
    const all = [...document.querySelectorAll('.modal')];
    const m = all.at(-1);
    const ok = m.querySelector('.btn-danger');
    t.assert(ok && ok.disabled, 'disabled until typed');
    const input = m.querySelector('input');
    t.equal(document.activeElement, input);
    type(input, 'delete');
    t.assert(ok.disabled, 'case matters');
    type(input, 'DELETE');
    t.assert(!ok.disabled);
    ok.click();
    t.equal(await c, true);
    t.assert(dlg !== null);
    const c2 = confirmDialog({ message: 'x' });
    key(document.activeElement, 'Escape');
    t.equal(await c2, false);
    const pr = promptDialog({ title: 'Rename', label: 'Name', value: 'old.txt' });
    await frame();
    const pin = [...document.querySelectorAll('.modal')].at(-1).querySelector('input');
    t.equal(pin.value, 'old.txt');
    pin.value = 'new.txt';
    key(pin, 'Enter');
    t.equal(await pr, 'new.txt');
    const pr2 = promptDialog({ title: 'x' });
    key(document.activeElement, 'Escape');
    t.equal(await pr2, null);
    t.assert(throws(() => promptDialog({ type: 'password' })), 'no secret prompts');
  });

  t.test('sheet: pushes one history entry; Back closes it; close() runs onClose once', async () => {
    const len = history.length;
    let closed = 0;
    const s = sheet({ title: 'Help', body: h('p', { text: 'body' }), onClose: () => closed++ });
    await wait(20);
    t.equal(history.length, len + 1, 'one entry');
    t.equal(s.el.getAttribute('role'), 'dialog');
    t.equal(document.activeElement, s.el, 'panel focused');
    history.back();
    await wait(150);
    t.equal(closed, 1, 'Back closed it');
    t.assert(!s.el.isConnected);
    let closed2 = 0;
    const s2 = sheet({ title: 'Two', onClose: () => closed2++ });
    await wait(20);
    s2.close();
    s2.close();
    await wait(150);
    t.equal(closed2, 1);
    t.equal(history.state?.czdOverlay, undefined, 'its entry was popped');
    let closed3 = 0;
    sheet({ title: 'Esc', onClose: () => closed3++ });
    await wait(20);
    key(document.activeElement, 'Escape');
    await wait(150);
    t.equal(closed3, 1, 'Esc closes');
  });

  t.test('purge closes open modals and sheets', async () => {
    let sc = 0;
    const p = modal({ title: 'Secret stuff' });
    sheet({ title: 'Secret sheet', onClose: () => sc++ });
    await wait(20);
    state.purge('test');
    t.equal(await p, null);
    t.equal(sc, 1);
    await wait(150);
    t.equal(document.querySelectorAll('.modal, .sheet').length, 0);
  });

  t.test('onOutside and announce', async () => {
    const inside = h('div', null, h('span', { text: 'in' }));
    const outside = h('div', { text: 'out' });
    document.body.append(inside, outside);
    let n = 0;
    const off = onOutside(inside, () => n++);
    inside.firstChild.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    t.equal(n, 0);
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    t.equal(n, 1);
    off();
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    t.equal(n, 1);
    inside.remove();
    outside.remove();
    announce('Hello there');
    await wait(50);
    const live = document.getElementById('announcer');
    t.equal(live.getAttribute('aria-live'), 'polite');
    t.equal(live.textContent, 'Hello there');
  });

  // ───────── passphrase field

  t.test('passphraseField: secret-input attributes per purpose', () => {
    const cases = [['vault', 'new', 'new-password'], ['change', 'new', 'new-password'], ['change', 'enter', 'current-password'],
      ['unlock', 'enter', 'current-password'], ['send', 'new', 'off'], ['text', 'new', 'off'], ['open', 'enter', 'off'], ['legacy', 'enter', 'off']];
    for (const [purpose, mode, ac] of cases) {
      const f = C.passphraseField({ label: 'P', mode, purpose });
      const i = f.el.querySelector('input');
      t.equal(i.type, 'password', `${purpose} type`);
      t.equal(i.autocomplete, ac, `${purpose}/${mode} autocomplete`);
      t.equal(i.getAttribute('autocapitalize'), 'none');
      t.equal(i.getAttribute('autocorrect'), 'off');
      t.equal(i.spellcheck, false);
      t.equal(f.el.querySelector('label').htmlFor, i.id, 'label linked');
      t.equal(f.el.querySelector('.meter').hidden, mode !== 'new', `${purpose} meter only in mode new`);
    }
    const f = C.passphraseField({ mode: 'enter', purpose: 'unlock', autocomplete: 'off' });
    t.equal(f.el.querySelector('input').autocomplete, 'off', 'explicit autocomplete wins');
  });

  t.test('passphraseField: show/hide, generate, generated flag, meter, weak warning', () => {
    const changes = [];
    const f = C.passphraseField({ label: 'New', mode: 'new', purpose: 'send', generateWords: 6, onChange: (v, i) => changes.push([v, i.generated]) });
    document.body.append(f.el);
    const input = f.el.querySelector('input');
    const toggle = f.el.querySelector('.pass-toggle');
    toggle.click();
    t.equal(input.type, 'text');
    t.equal(toggle.getAttribute('aria-pressed'), 'true');
    t.equal(toggle.getAttribute('aria-label'), 'Hide passphrase');
    toggle.click();
    t.equal(input.type, 'password');
    f.el.querySelector('.pass-gen').click();
    t.equal(f.generated, true);
    t.equal(f.value.split('-').length, 6, 'six words');
    t.assert(/^[a-z]+(-[a-z]+){5}$/.test(f.value), f.value);
    t.equal(input.type, 'text', 'generated phrases are shown');
    t.equal(f.el.querySelector('.meter').dataset.level, 'strong', '66 bits');
    t.equal(changes.at(-1)[1], true);
    type(input, `${f.value}x`);
    t.equal(f.generated, false, 'any edit clears generated');
    type(input, 'password');
    t.equal(f.el.querySelector('.meter').dataset.level, 'weak');
    t.assert(!f.el.querySelector('.pass-weak').hidden, 'WEAK warning');
    type(input, 'Tr0ub4dor&3-horse-staple');
    t.assert(f.el.querySelector('.pass-weak').hidden);
    t.assert(['ok', 'strong'].includes(f.el.querySelector('.meter').dataset.level));
    type(input, '');
    t.equal(f.el.querySelector('.meter').dataset.level, 'none');
    f.setValue('abc-def', { generated: true });
    t.equal(f.generated, true);
    f.setError('Wrong passphrase.');
    t.equal(input.getAttribute('aria-invalid'), 'true');
    t.equal(f.el.querySelector('.pass-err').textContent, 'Wrong passphrase.');
    t.equal(document.activeElement, input, 'setError focuses');
    f.setError(null);
    t.equal(input.getAttribute('aria-invalid'), null);
    f.setDisabled(true);
    t.assert(input.disabled && toggle.disabled);
    f.setDisabled(false);
    f.el.remove();
  });

  t.test('passphraseField: weak warning never on enter-mode fields', () => {
    for (const purpose of ['unlock', 'open', 'legacy']) {
      const f = C.passphraseField({ mode: 'enter', purpose });
      type(f.el.querySelector('input'), 'password');
      t.assert(f.el.querySelector('.pass-weak').hidden, purpose);
    }
  });

  t.test('passphraseField: Enter → onSubmit, "codzilla" event, purge clears', () => {
    const subs = [];
    let cz = 0;
    const f = C.passphraseField({ mode: 'enter', purpose: 'text', onSubmit: (v) => subs.push(v) });
    document.body.append(f.el);
    f.el.addEventListener('codzilla', () => cz++);
    const input = f.el.querySelector('input');
    type(input, 'secret');
    key(input, 'Enter');
    t.deepEqual(subs, ['secret']);
    type(input, 'CodZilla');
    key(input, 'Enter');
    t.equal(cz, 1);
    t.equal(subs.length, 2, 'still submitted');
    f.setValue('top secret', { generated: true });
    state.purge('test');
    t.equal(f.value, '');
    t.equal(f.generated, false);
    t.equal(input.type, 'password');
    f.el.remove();
  });

  t.test('easter egg: only on secret-setting purposes, debounced, once per focus', async () => {
    await closeAllModals();
    t.equal(await maybeEasterEgg('1234', 'unlock'), false);
    t.equal(await maybeEasterEgg('1234', 'open'), false);
    t.equal(await maybeEasterEgg('1234', 'legacy'), false);
    t.equal(await maybeEasterEgg('123456', 'vault'), false, 'exact values only');
    t.equal(skulls(), 0);

    // Field: enter-mode purposes never show it.
    for (const purpose of ['unlock', 'open', 'legacy']) {
      const f = C.passphraseField({ mode: 'enter', purpose });
      document.body.append(f.el);
      const i = f.el.querySelector('input');
      i.focus();
      type(i, '1234');
      await wait(500);
      t.equal(skulls(), 0, `no skull on ${purpose}`);
      f.el.remove();
    }

    // Text field in Decrypt mode (setMode('enter')) stays quiet; Encrypt mode shows it.
    const tx = C.passphraseField({ mode: 'new', purpose: 'text' });
    document.body.append(tx.el);
    const ti = tx.el.querySelector('input');
    tx.setMode('enter');
    ti.focus();
    type(ti, '12345');
    await wait(500);
    t.equal(skulls(), 0, 'text decrypt mode');
    tx.setMode('new');
    ti.blur();
    ti.focus();
    type(ti, '123');
    await wait(500);
    t.equal(skulls(), 1, 'text encrypt mode');
    await closeAllModals();
    tx.el.remove();

    // Typing through "123…" quickly doesn't fire (debounce).
    const v = C.passphraseField({ mode: 'new', purpose: 'vault' });
    document.body.append(v.el);
    const vi = v.el.querySelector('input');
    vi.focus();
    for (const s of ['1', '12', '123', '1234', '12345', '123456', '1234567', '12345678']) {
      type(vi, s);
      await wait(60);
    }
    await wait(500);
    t.equal(skulls(), 0, 'debounced');

    // Exactly 1234 → skull with the verbatim text; once per focus.
    vi.focus();
    type(vi, '1234');
    await wait(500);
    t.equal(skulls(), 1, 'vault 1234');
    const m = document.querySelector('.eg-modal');
    t.equal(m.querySelector('.eg-text').textContent, 'I knew you were stupid enough to use a short password, but not so much that you used the most common ones in the planet.');
    t.equal(m.querySelector('.eg-skull').textContent, '💀');
    const btn = m.querySelector('.modal-actions .btn');
    t.equal(btn.textContent, 'ok fine');
    btn.click();
    await wait(20);
    t.equal(document.activeElement, vi, 'focus back in the field');
    type(vi, '123');
    await wait(500);
    t.equal(skulls(), 0, 'not again during the same focus');
    vi.blur();
    vi.focus();
    type(vi, '12345');
    await wait(500);
    t.equal(skulls(), 1, 'again after refocus');
    await closeAllModals();
    v.el.remove();

    for (const purpose of ['send', 'change']) {
      const f = C.passphraseField({ mode: 'new', purpose });
      document.body.append(f.el);
      const i = f.el.querySelector('input');
      i.focus();
      type(i, '123');
      await wait(500);
      t.equal(skulls(), 1, purpose);
      await closeAllModals();
      f.el.remove();
    }
    const one = showSkull();
    const two = showSkull();
    t.equal(one, two, 'one skull at a time');
    await closeAllModals();
  });

  // ───────── other components

  t.test('strengthMeter', () => {
    const m = C.strengthMeter();
    m.update('');
    t.equal(m.el.dataset.level, 'none');
    m.update('a-b-c-d-e-f', { generated: true, words: 6 });
    t.equal(m.el.dataset.level, 'strong');
    t.assert(m.el.textContent.includes('Strong'));
    m.update('1234');
    t.equal(m.el.dataset.level, 'weak');
    t.assert(m.el.textContent.toLowerCase().includes('instantly'));
  });

  t.test('segmented: click, arrows, set() without onChange', () => {
    const seen = [];
    const s = C.segmented({ label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }], value: 'a', onChange: (v) => seen.push(v) });
    document.body.append(s.el);
    t.equal(s.el.getAttribute('role'), 'radiogroup');
    t.equal(s.el.getAttribute('aria-label'), 'Mode');
    const btns = [...s.el.querySelectorAll('[role="radio"]')];
    t.deepEqual(btns.map((b) => b.getAttribute('aria-checked')), ['true', 'false', 'false']);
    t.deepEqual(btns.map((b) => b.tabIndex), [0, -1, -1], 'roving tabindex');
    btns[2].click();
    t.deepEqual(seen, ['c']);
    key(btns[2], 'ArrowRight');
    t.equal(s.value, 'a', 'wraps');
    t.equal(document.activeElement, btns[0]);
    key(btns[0], 'End');
    t.equal(s.value, 'c');
    s.set('b');
    t.equal(seen.length, 3, 'set() is silent');
    t.equal(btns[1].getAttribute('aria-checked'), 'true');
    s.el.remove();
  });

  t.test('menu: keyboard accessible popup', async () => {
    const calls = [];
    const btn = h('button', { type: 'button', text: '⋯', aria: { label: 'Actions' } });
    document.body.append(btn);
    const off = C.menu(btn, [
      { label: 'Open', icon: 'eye', onClick: () => calls.push('open') },
      { label: 'Hidden', hidden: true, onClick: () => calls.push('hidden') },
      { label: 'Rename', onClick: () => calls.push('rename') },
      { label: 'Delete', danger: true, onClick: () => calls.push('delete') },
    ]);
    t.equal(btn.getAttribute('aria-haspopup'), 'menu');
    btn.click();
    let pop = document.querySelector('.menu[role="menu"]');
    t.assert(pop, 'opened');
    t.equal(btn.getAttribute('aria-expanded'), 'true');
    const items = [...pop.querySelectorAll('[role="menuitem"]')];
    t.deepEqual(items.map((i) => i.textContent), ['Open', 'Rename', 'Delete'], 'hidden skipped');
    t.equal(document.activeElement, items[0]);
    key(items[0], 'ArrowDown');
    t.equal(document.activeElement, items[1]);
    key(items[1], 'End');
    t.equal(document.activeElement, items[2]);
    key(items[2], 'ArrowDown');
    t.equal(document.activeElement, items[0], 'wraps');
    key(items[0], 'Escape');
    t.equal(document.querySelector('.menu'), null, 'Esc closes');
    t.equal(document.activeElement, btn, 'focus back on the button');
    key(btn, 'ArrowDown');
    pop = document.querySelector('.menu');
    pop.querySelectorAll('[role="menuitem"]')[1].click();
    t.deepEqual(calls, ['rename']);
    t.equal(document.querySelector('.menu'), null);
    btn.click();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    t.equal(document.querySelector('.menu'), null, 'outside click closes');
    off();
    btn.click();
    t.equal(document.querySelector('.menu'), null, 'off() detaches');
    btn.remove();
  });

  t.test('menu inside a modal attaches to the dialog layer and works', async () => {
    let hit = 0;
    const mb = h('button', { type: 'button', text: 'More', aria: { label: 'More' } });
    const p = modal({ title: 'With menu', body: mb });
    C.menu(mb, [{ label: 'Pick', onClick: () => hit++ }]);
    mb.click();
    const pop = document.querySelector('.menu');
    t.assert(pop && pop.parentElement === p.el.parentElement, 'menu lives in the modal backdrop');
    t.equal(pop.closest('[inert]'), null, 'not inert');
    pop.querySelector('[role="menuitem"]').click();
    t.equal(hit, 1);
    t.assert(p.el.isConnected, 'modal stays open');
    p.close();
    await p;
  });

  t.test('banner, emptyState, kindIcon, storageBar', () => {
    let dismissed = 0;
    let acted = 0;
    const b = C.banner({ kind: 'warn', text: 'Careful', actions: [{ label: 'Do it', onClick: () => acted++ }], onDismiss: () => dismissed++ });
    document.body.append(b);
    t.assert(b.classList.contains('banner-warn'));
    b.querySelector('.banner-actions .btn').click();
    t.equal(acted, 1);
    b.querySelector('.banner-close').click();
    t.equal(dismissed, 1);
    t.assert(!b.isConnected);
    t.equal(C.banner({ kind: 'err', text: 'x' }).getAttribute('role'), 'alert');
    let clicked = 0;
    const e = C.emptyState({ icon: 'lock', title: 'Empty', text: 'Nothing here', action: { label: 'Add', onClick: () => clicked++ } });
    e.querySelector('button').click();
    t.equal(clicked, 1);
    t.equal(e.querySelector('.empty-title').textContent, 'Empty');
    t.assert(C.kindIcon('video').classList.contains('kind-video'));
    t.assert(C.kindIcon('weird').classList.contains('kind-other'));
    const s1 = C.storageBar({ count: 3, itemBytes: 2048, usage: 50, quota: 100, persisted: false });
    t.assert(s1.textContent.includes('3 items'));
    t.assert(s1.textContent.includes('Not protected'));
    t.equal(parseFloat(s1.querySelector('.storage-fill').style.width), 50);
    const s2 = C.storageBar({ count: 1, itemBytes: 10, usage: null, quota: null, persisted: null });
    t.equal(s2.querySelector('.storage-track'), null, 'no bar without quota (Tauri)');
    t.assert(s2.textContent.includes('1 item ·'));
  });

  t.test('progressRow: progress, done, fail, cancel, sanitized name', () => {
    const r = C.progressRow({ name: 'evil\u202egpj.exe', total: 1000 });
    t.equal(r.el.querySelector('.progress-name').textContent, 'evilgpj.exe');
    r.update(250);
    t.equal(r.el.querySelector('.progress-fill').style.width, '25%');
    t.equal(r.el.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '25');
    const cancel = r.el.querySelector('.progress-cancel');
    t.assert(cancel.hidden);
    let cancelled = 0;
    r.onCancel(() => cancelled++);
    t.assert(!cancel.hidden);
    cancel.click();
    t.equal(cancelled, 1);
    r.fail('Not enough storage space.');
    t.equal(r.el.dataset.state, 'failed');
    t.assert(cancel.hidden);
    const r2 = C.progressRow({ name: 'ok.txt', total: 10 });
    r2.done();
    t.equal(r2.el.dataset.state, 'done');
    t.equal(r2.el.querySelector('.progress-status').textContent, 'Done');
  });

  t.test('stealthText: .geo/.cyr spans, never parsed as HTML', () => {
    const el = C.stealthText('ჶაბА<b>Б</b>x');
    t.equal(el.textContent, 'ჶაბА<b>Б</b>x');
    t.equal(el.querySelectorAll('b').length, 0);
    const spans = [...el.querySelectorAll('span')];
    t.deepEqual(spans.map((s) => [s.className, s.textContent]), [['geo', 'ჶაბ'], ['cyr', 'А'], ['cyr', 'Б']]);
  });

  t.test('copyButton: copies, feedback, secret clear on purge', async () => {
    const writes = [];
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s) => { writes.push(s); } } });
    try {
      const b = C.copyButton(() => 'cipher text');
      document.body.append(b);
      b.click();
      await wait(20);
      t.deepEqual(writes, ['cipher text']);
      t.assert(b.textContent.includes('Copied'));
      const s = C.copyButton(async () => 'my-secret-phrase', { secret: true, label: 'Copy passphrase' });
      document.body.append(s);
      t.assert(s.title.includes('clear the clipboard'));
      s.click();
      await wait(20);
      t.equal(writes.at(-1), 'my-secret-phrase');
      state.purge('test');
      await wait(10);
      if (document.hasFocus()) t.equal(writes.at(-1), '', 'cleared on lock while focused');
      else t.log('document not focused: clipboard clear on purge not observable');
      const empty = C.copyButton(() => '');
      document.body.append(empty);
      const before = writes.length;
      empty.click();
      await wait(20);
      t.equal(writes.length, before, 'nothing to copy');
      b.remove();
      s.remove();
      empty.remove();
    } finally {
      delete navigator.clipboard;
      if (desc) Object.defineProperty(Navigator.prototype, 'clipboard', desc);
    }
  });

  t.test('dropZone: files from a drop, dragover class, off()', async () => {
    const zone = h('div', { class: 'dropzone' });
    document.body.append(zone);
    const got = [];
    const off = C.dropZone(zone, { onFiles: (files, info) => got.push([files.map((f) => f.name), info.folders.length]) });
    const dt = new DataTransfer();
    dt.items.add(new File(['a'], 'a.txt'));
    dt.items.add(new File(['b'], 'b.png', { type: 'image/png' }));
    zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    t.assert(zone.classList.contains('dragover'));
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    zone.dispatchEvent(over);
    t.assert(over.defaultPrevented, 'accepts the drop');
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    zone.dispatchEvent(drop);
    await wait(20);
    t.assert(drop.defaultPrevented);
    t.deepEqual(got, [[['a.txt', 'b.png'], 0]]);
    t.assert(!zone.classList.contains('dragover'));
    const single = h('div');
    const got1 = [];
    C.dropZone(single, { multiple: false, onFiles: (f) => got1.push(f.length) });
    single.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(20);
    t.deepEqual(got1, [1]);
    off();
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(20);
    t.equal(got.length, 1, 'off() detaches');
    zone.remove();
  });

  t.test('folder traversal: dotfiles skipped, depth ≤ 8, ≤ 10,000 files, directories never become files', async () => {
    const file = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(new File(['x'], name)) });
    const dir = (name, children) => ({
      isFile: false, isDirectory: true, name,
      createReader() {
        let done = false;
        return { readEntries(ok) { // two batches like Chromium (100 per call)
          if (done) return ok([]);
          done = true;
          ok(children);
        } };
      },
    });
    let deep = file('deepest.txt');
    for (let d = 12; d >= 1; d--) deep = dir(`level${d}`, [file(`f${d}.txt`), deep]);
    const tree = dir('Trip', [file('a.jpg'), file('.DS_Store'), dir('.git', [file('config')]), dir('__MACOSX', [file('x')]), file('Thumbs.db'), deep]);
    const item = (entry, f = null) => ({ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => f });
    const dt = { items: [item(tree), item(file('loose.txt'), new File(['l'], 'loose.txt'))], files: [] };
    const res = await C.collectDrop(dt, { folders: true });
    t.deepEqual(res.files.map((f) => f.name), ['loose.txt']);
    t.equal(res.folders.length, 1);
    t.equal(res.folders[0].name, 'Trip');
    const names = res.folders[0].files.map((f) => f.name);
    t.assert(names.includes('a.jpg'));
    t.assert(!names.includes('.DS_Store') && !names.includes('config') && !names.includes('Thumbs.db') && !names.includes('x'), 'junk skipped');
    t.assert(names.includes('f7.txt'), 'depth 8 included');
    t.assert(!names.includes('f8.txt') && !names.includes('deepest.txt'), 'deeper than 8 skipped');
    t.equal(res.truncated, true);
    const noFolders = await C.collectDrop(dt, { folders: false });
    t.deepEqual(noFolders.files.map((f) => f.name), ['loose.txt'], 'folders=false: directory ignored');
    t.equal(noFolders.folders.length, 0);
    const big = dir('Big', Array.from({ length: 10005 }, (_, i) => file(`p${i}.jpg`)));
    const r2 = await C.collectDrop({ items: [item(big)], files: [] }, { folders: true });
    t.equal(r2.folders[0].files.length, 10000);
    t.equal(r2.truncated, true);
  });

  t.test('review: folder traversal reads a bounded number of entries (huge junk-only trees)', async () => {
    let calls = 0;
    const junk = Array.from({ length: 300_000 }, (_, i) => ({ isFile: true, isDirectory: false, name: `.cache-${i}`, file: (ok) => ok(new File(['x'], 'x')) }));
    const huge = {
      isFile: false, isDirectory: true, name: 'Huge',
      createReader() {
        let pos = 0;
        return { readEntries(ok) {
          calls++;
          const batch = junk.slice(pos, pos + 100);
          pos += batch.length;
          ok(batch);
        } };
      },
    };
    const res = await C.collectDrop({ items: [{ kind: 'file', webkitGetAsEntry: () => huge, getAsFile: () => null }], files: [] }, { folders: true });
    t.equal(res.truncated, true);
    t.equal(res.folders.length, 0, 'only skipped junk: no folder');
    t.assert(calls <= 1001, `readEntries calls: ${calls}`);
  });

  // ───────── views and shell

  t.test('codzilla: verbatim copy, empty input ignored, progress formatting, unmount clears timers', async () => {
    t.equal(codzilla.fmtPct(0), '0.0000%');
    t.equal(codzilla.fmtPct(0.5), '0.5000%');
    t.equal(codzilla.fmtPct(5), '5.000%');
    t.equal(codzilla.fmtPct(25.5), '25.50%');
    t.equal(codzilla.fmtPct(75), '75.0%');
    t.equal(codzilla.fmtPct(99.99999), '99.99999%');
    t.equal(codzilla.statusAt(0), 'Booting quantum processors...');
    t.equal(codzilla.statusAt(0.999), 'Final verification phase initiating...');
    t.equal(codzilla.statusAt(1), 'Final verification phase initiating...');
    const root = h('div');
    document.body.append(root);
    const v = codzilla.mount(root, router.parseHash('#/codzilla'), {});
    t.equal(root.querySelector('.cz-title').textContent, 'projerct codzilla');
    t.deepEqual([...root.querySelectorAll('.cz-g')].map((s) => s.textContent), ['pro', 'c']);
    t.equal(root.querySelector('.cz-tag').textContent, 'next-gen · quantum-resistant · 100% real · definitely not a prank');
    t.equal(root.querySelector('textarea').placeholder, 'type your super secret message...');
    const go = root.querySelector('.cz-btn');
    t.equal(go.textContent, '⚡ Encode with Codzilla');
    go.click();
    t.assert(root.querySelector('.cz-loading').hidden, 'empty input does nothing');
    root.querySelector('textarea').value = 'hello';
    go.click();
    t.assert(!root.querySelector('.cz-loading').hidden, 'loading');
    t.equal(root.querySelector('.cz-loading .cz-label').textContent, '⚙ Initializing Codzilla Engine v9.4.2...');
    await wait(300);
    t.assert(root.querySelector('.cz-pct').textContent.endsWith('%'));
    // Jump the clock past 30 s: 99.99999%, last status line, punchline after +0.5 s, Try Again resets.
    const realNow = performance.now.bind(performance);
    performance.now = () => realNow() + 31000;
    try {
      await wait(100);
      t.equal(root.querySelector('.cz-pct').textContent, '99.99999%');
      t.equal(root.querySelector('.cz-status').textContent, 'Final verification phase initiating...');
      await wait(600);
      t.assert(!root.querySelector('.cz-result').hidden, 'result shown');
      t.equal(root.querySelector('.cz-msg').textContent, 'bro the fuck did you just type there, twin not even me can encode that shit 😭🥀✌\ufe0f');
      t.equal(root.querySelector('.cz-again').textContent, '↺ Try Again');
    } finally {
      performance.now = realNow;
    }
    root.querySelector('.cz-again').click();
    t.assert(!root.querySelector('.cz-input').hidden && root.querySelector('.cz-result').hidden, 'reset');
    t.equal(root.querySelector('textarea').value, '');
    root.querySelector('textarea').value = 'again';
    go.click();
    await wait(50);
    v.unmount();
    t.equal(root.childElementCount, 0, 'page removed');
    const errors = [];
    const onErr = (e) => errors.push(e.message);
    window.addEventListener('error', onErr);
    await wait(300);
    window.removeEventListener('error', onErr);
    t.deepEqual(errors, []);
    // Another view can render into the same root afterwards (the old blank-page bug).
    root.append(h('p', { text: 'next view' }));
    await wait(100);
    t.equal(root.textContent, 'next view');
    root.remove();
  });

  t.test('tutorial: 5 steps, Next/Back, last button, marks done', async () => {
    t.equal(STEPS.length, 5);
    const p = openTutorial();
    t.equal(openTutorial(), p, 'single instance');
    const box = document.querySelector('.tu-box');
    const next = box.querySelector('.tu-next');
    t.equal(box.querySelector('.tu-count').textContent, '1 of 5');
    t.assert(box.querySelector('.tu-back').hidden);
    next.click();
    t.equal(box.querySelector('.tu-count').textContent, '2 of 5');
    t.assert(box.textContent.includes('recovery code'));
    box.querySelector('.tu-back').click();
    t.equal(box.querySelector('.tu-count').textContent, '1 of 5');
    for (let i = 0; i < 4; i++) next.click();
    t.equal(box.querySelector('.tu-count').textContent, '5 of 5');
    t.equal(next.textContent, "Let's go →");
    t.assert(box.querySelector('.tu-skip').hidden, 'no Skip on the last step');
    t.assert(box.textContent.includes('own vault'));
    next.click();
    t.equal(await p, 'done');
    t.equal(localStorage.getItem('czd2.tutorialDone'), 'true');
    localStorage.removeItem('czd2.tutorialDone');
  });

  // ───────── review regressions (C1 adversarial review)

  t.test('review: Esc in a menu inside a dialog closes only the menu', async () => {
    const mb = h('button', { type: 'button', text: 'More', aria: { label: 'More' } });
    const p = modal({ title: 'Menu host', body: mb });
    const off = C.menu(mb, [{ label: 'One', onClick() {} }, { label: 'Two', onClick() {} }]);
    mb.click();
    const item = document.querySelector('.menu [role="menuitem"]');
    t.equal(document.activeElement, item, 'focus in the menu');
    key(item, 'Escape');
    t.equal(document.querySelector('.menu'), null, 'menu closed');
    t.assert(p.el.isConnected, 'dialog still open');
    t.equal(document.activeElement, mb, 'focus back on the menu button');
    key(mb, 'Escape');
    t.equal(await p, null, 'a second Esc closes the dialog');
    off();
  });

  t.test('review: an open menu closes on route change and on lock', async () => {
    const btn = h('button', { type: 'button', text: '⋯', aria: { label: 'Item actions' } });
    document.body.append(btn);
    const off = C.menu(btn, [{ label: 'Delete', danger: true, onClick() {} }]);
    btn.click();
    t.assert(document.querySelector('.menu'), 'open');
    const prevRoute = state.get('route');
    state.set('route', { top: 'review', parts: [], query: new URLSearchParams(), hash: '#/review' });
    t.equal(document.querySelector('.menu'), null, 'route change closes it (no stale actions for an unmounted view)');
    t.equal(btn.getAttribute('aria-expanded'), 'false');
    btn.click();
    t.assert(document.querySelector('.menu'), 'reopens');
    state.purge('test');
    t.equal(document.querySelector('.menu'), null, 'lock closes it');
    state.set('route', prevRoute);
    off();
    btn.remove();
  });

  t.test('review: copy buttons — no await before the clipboard call; a later non-secret copy is never wiped', async () => {
    const writes = [];
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s) => { writes.push(s); } } });
    try {
      const s = C.copyButton(() => 'secret-words-here', { secret: true });
      const c = C.copyButton(() => 'ჶciphertext');
      document.body.append(s, c);
      s.click();
      t.deepEqual(writes, ['secret-words-here'], 'written synchronously in the click (keeps user activation on Safari)');
      await wait(20);
      c.click();
      await wait(20);
      t.equal(writes.at(-1), 'ჶciphertext');
      state.purge('test');
      await wait(10);
      if (!document.hasFocus()) t.log('document not focused: clear-on-lock not observable');
      t.equal(writes.at(-1), 'ჶciphertext', 'ciphertext copied after the secret is never cleared');
      t.assert(!writes.includes(''), 'nothing wiped');
      // Clearing off: the title must not promise a 30 s clear.
      localStorage.setItem('czd2.clipboardClearSec', '0');
      const off = C.copyButton(() => 'x', { secret: true });
      t.assert(!/after 30 s/.test(off.title), off.title);
      localStorage.removeItem('czd2.clipboardClearSec');
      s.remove();
      c.remove();
    } finally {
      delete navigator.clipboard;
      if (desc) Object.defineProperty(Navigator.prototype, 'clipboard', desc);
    }
  });

  t.test('review: lock (purge) closes toasts shown before it, not the ones shown after', async () => {
    const undo = toast('Deleted 3', { timeout: 8000, action: { label: 'Undo', onClick() {} } });
    const plain = toast('Saved "secret name.jpg"', { timeout: 0 });
    state.purge('test');
    const after = toast('Locked', { timeout: 0 });
    await wait(300);
    t.assert(!undo.el.isConnected, 'Undo toast gone (the delete commits on lock)');
    t.assert(!plain.el.isConnected, 'toasts may hold decrypted names');
    t.assert(after.el.isConnected, 'a toast shown after the lock stays');
    after.close();
  });

  t.test('review: toast timeout Infinity stays (no immediate close)', async () => {
    const tt = toast('stays', { timeout: Infinity });
    await wait(60);
    t.assert(tt.el.isConnected && tt.el.classList.contains('show'), 'still shown');
    tt.close();
  });

  t.test('review: closing the last dialog restores #app.inert instead of forcing it off', async () => {
    app.inert = true; // e.g. another overlay (the viewer) made the page inert
    const p = modal({ title: 'over the viewer' });
    t.equal(app.inert, true);
    p.close();
    await p;
    t.equal(app.inert, true, 'still inert: the other overlay is open');
    app.inert = false;
    const q = modal({ title: 'plain' });
    t.equal(app.inert, true);
    q.close();
    await q;
    t.equal(app.inert, false);
    // The other overlay closes while our dialog is open: closing the dialog must not leave the app stuck inert.
    app.inert = true;
    const r = modal({ title: 'viewer closes under me' });
    app.inert = false; // the viewer closed
    r.close();
    await r;
    t.equal(app.inert, false, 'not stuck');
  });

  t.test('review: passphraseField clear()/purge notifies onChange', () => {
    const changes = [];
    const f = C.passphraseField({ mode: 'new', purpose: 'send', generateWords: 6, onChange: (v, i) => changes.push([v, i.generated]) });
    f.setValue('alpha-beta-gamma-delta-echo-fox', { generated: true });
    state.purge('idle');
    t.deepEqual(changes.at(-1), ['', false], 'views re-check their buttons (no stale enabled "Lock & save" with an empty passphrase)');
    const n = changes.length;
    f.clear();
    t.equal(changes.length, n, 'no event when nothing changed');
  });

  t.test('review: a pending easter egg is dropped on lock, removal, mode switch or a changed value', async () => {
    await closeAllModals();
    const f = C.passphraseField({ mode: 'new', purpose: 'vault' });
    document.body.append(f.el);
    const i = f.el.querySelector('input');
    const refocus = () => {
      i.blur();
      i.focus();
    };
    refocus();
    type(i, '1234');
    state.purge('idle');
    await wait(500);
    t.equal(skulls(), 0, 'lock within the debounce: no skull on the lock screen');
    refocus();
    type(i, '1234');
    f.el.remove();
    await wait(500);
    t.equal(skulls(), 0, 'field removed (view unmounted)');
    document.body.append(f.el);
    refocus();
    type(i, '1234');
    f.setMode('enter');
    await wait(500);
    t.equal(skulls(), 0, 'switched to an enter-mode field (Text → Decrypt)');
    f.setMode('new');
    refocus();
    type(i, '1234');
    f.setValue('correct horse battery staple');
    await wait(500);
    t.equal(skulls(), 0, 'value replaced');
    refocus();
    type(i, '1234');
    await wait(500);
    t.equal(skulls(), 1, 'still works otherwise');
    await closeAllModals();
    f.el.remove();
  });

  t.test('review: svg() refuses animation elements (they can rewrite href)', () => {
    for (const tag of ['set', 'animate', 'animateMotion', 'animateTransform']) t.assert(throws(() => svg(tag, {})), tag);
  });

  t.test('review: Enter while an IME is composing does not submit dialogs', async () => {
    const p = promptDialog({ title: 'Rename', value: '名前' });
    const input = document.querySelector('.modal .input');
    key(input, 'Enter', { isComposing: true });
    await wait(10);
    t.assert(input.isConnected, 'still open while composing');
    key(input, 'Enter');
    t.equal(await p, '名前');
    const c = confirmDialog({ title: 'Delete vault', typed: 'DELETE' });
    const ci = document.querySelector('.modal .input');
    type(ci, 'DELETE');
    key(ci, 'Enter', { isComposing: true });
    await wait(10);
    t.assert(ci.isConnected, 'typed confirm still open while composing');
    key(ci, 'Enter');
    t.equal(await c, true);
  });

  t.test('review: a throwing onFiles is contained (no unhandled rejection)', async () => {
    let unhandled = 0;
    const onU = (e) => {
      unhandled++;
      e.preventDefault();
    };
    window.addEventListener('unhandledrejection', onU);
    const origErr = console.error;
    console.error = () => {};
    try {
      const zone = h('div', { class: 'dropzone' });
      document.body.append(zone);
      const off = C.dropZone(zone, { onFiles: () => { throw new Error('boom'); } });
      const dt = new DataTransfer();
      dt.items.add(new File(['a'], 'a.txt'));
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await wait(50);
      t.equal(unhandled, 0);
      off();
      zone.remove();
    } finally {
      console.error = origErr;
      window.removeEventListener('unhandledrejection', onU);
    }
  });

  t.test('review: the privacy cover hides every body-level layer and sits on top', async () => {
    const foreign = h('div', { class: 'review-foreign-overlay' }, 'decrypted preview');
    document.body.append(foreign);
    document.documentElement.classList.add('privacy-cover');
    await frame();
    t.equal(getComputedStyle(foreign).visibility, 'hidden', 'e.g. the viewer root appended to <body>');
    const cover = document.getElementById('privacy-cover') ?? null;
    if (cover) t.equal(getComputedStyle(cover).visibility, 'visible');
    document.documentElement.classList.remove('privacy-cover');
    foreign.remove();
  });

  t.test('review: stealthText stays responsive on huge ciphertexts (colouring is capped, text is complete)', () => {
    const unit = 'აბგАБВ';
    const text = unit.repeat(200_000); // 1.2 M chars
    const t0 = performance.now();
    const el = C.stealthText(text);
    const ms = performance.now() - t0;
    t.equal(el.textContent.length, text.length, 'every character is there');
    t.equal(el.textContent, text);
    t.assert(el.querySelectorAll('span').length <= 40_000, `spans: ${el.querySelectorAll('span').length}`);
    t.assert(el.querySelector('.geo') && el.querySelector('.cyr'), 'still coloured at the start');
    t.assert(ms < 1500, `built in ${Math.round(ms)} ms`);
  });

  t.test('router + shell: lifecycle, nav highlight, lock button, update banner', async () => {
    const lockCalls = [];
    setVault({ lock: (r) => lockCalls.push(r) });
    const shell = mountShell(app);
    t.equal(mountShell(app), shell, 'mounted once');
    t.assert(document.getElementById('player-dock'), '#player-dock');
    t.assert(document.getElementById('toasts') && document.getElementById('modals') && document.getElementById('privacy-cover'));
    const log = [];
    const view = (name) => async () => ({
      mount(root, route) {
        root.append(h('p', { class: 'v', text: name }));
        log.push(`mount ${name}:${route.top}`);
        return { update: (r) => log.push(`update ${name}:${r.top}`), unmount: () => log.push(`unmount ${name}`) };
      },
    });
    router.start(shell.main, {
      vault: view('vault'), send: view('send'), text: view('text'), more: view('more'), settings: view('settings'),
      about: view('about'), legacy: view('legacy'), codzilla: async () => codzilla,
    }, { fallback: 'vault' });
    await wait(50);
    t.equal(location.hash, '#/vault');
    t.equal(shell.main.textContent, 'vault');
    const active = () => [...document.querySelectorAll('.sh-tab[aria-current="page"]')].map((a) => a.dataset.top);
    t.deepEqual(active(), ['vault']);
    for (const [hash, nav] of [['#/send', 'send'], ['#/open', 'send'], ['#/incoming?share=1', 'send'], ['#/text', 'text'], ['#/more', 'more'],
      ['#/settings', 'more'], ['#/about', 'more'], ['#/legacy', 'more'], ['#/codzilla', 'more'], ['#/bogus', 'vault']]) {
      router.navigate(hash);
      await wait(60);
      t.deepEqual(active(), [nav], `${hash} highlights ${nav}`);
      t.equal(document.querySelectorAll('.sh-tab-m.active').length, 1);
    }
    t.equal(location.hash, '#/vault', 'unknown → vault');
    t.assert(log.includes('update send:open') && log.includes('update send:incoming'), 'open/incoming update the send view');
    t.assert(log.includes('unmount send'));
    t.equal(shell.main.querySelectorAll('.cz-page').length, 0, 'codzilla unmounted');

    const lock = document.querySelector('.sh-lock');
    t.assert(lock.hidden, 'lock hidden while not unlocked');
    state.set('vault.status', 'unlocked');
    t.assert(!lock.hidden, 'lock visible when unlocked');
    lock.click();
    t.deepEqual(lockCalls, ['user']);
    state.set('vault.status', 'locked');
    t.assert(lock.hidden);

    const upd = document.querySelector('.sh-update');
    t.assert(upd.hidden);
    state.set('sw.updateReady', true);
    t.assert(!upd.hidden);
    t.assert(upd.textContent.includes('Update ready'));
    state.set('vault.status', 'unlocked');
    t.assert(upd.textContent.includes('after you lock'));
    state.set('vault.status', 'locked');
    state.set('sw.updateReady', false);
    t.assert(upd.hidden);
    setVault(null);

    // A view module that throws on mount leaves a readable placeholder, not a blank page.
    router.navigate('#/more');
    await wait(60);
    const p = modal({ title: 'route change closes me' });
    router.navigate('#/text');
    t.equal(await p, null, 'modal closed on top-level route change');
  });

  t.test('review: stacked sheets — Back closes only the top one; close() then navigate() leaves no stale entry', async () => {
    router.navigate('#/text');
    await wait(80);
    const closed = [];
    const a = sheet({ title: 'A', onClose: () => closed.push('A') });
    await wait(30);
    const b = sheet({ title: 'B', onClose: () => closed.push('B') });
    await wait(30);
    history.back();
    await wait(150);
    t.deepEqual(closed, ['B'], 'Back closed the top sheet only');
    t.assert(a.el.isConnected, 'A still open');
    t.assert(!b.el.isConnected);
    a.close();
    router.navigate('#/more');
    await wait(600);
    t.deepEqual(closed, ['B', 'A']);
    t.equal(location.hash, '#/more');
    history.back();
    await wait(200);
    t.equal(location.hash, '#/text', 'Back returns to the previous route (the sheet entry was consumed)');
    t.equal(document.querySelectorAll('.sheet').length, 0);
  });

  t.test('review: an overlay entry left over from before a reload does not stop Back from closing a new sheet', async () => {
    // A reload while a sheet was open leaves an entry whose czdOverlay id came from the previous page load.
    history.replaceState({ czdOverlay: 9999 }, '', location.href);
    let closed = 0;
    const s = sheet({ title: 'after reload', onClose: () => closed++ });
    await wait(30);
    history.back();
    await wait(150);
    t.equal(closed, 1, 'Back closed the sheet');
    t.assert(!s.el.isConnected);
    history.replaceState(null, '', location.href);
  });

  t.test('privacy cover class hides the app', async () => {
    document.documentElement.classList.add('privacy-cover');
    await frame();
    t.equal(getComputedStyle(document.getElementById('privacy-cover')).display, 'flex');
    t.equal(getComputedStyle(app).visibility, 'hidden');
    document.documentElement.classList.remove('privacy-cover');
    await frame();
    t.equal(getComputedStyle(document.getElementById('privacy-cover')).display, 'none');
  });
}
