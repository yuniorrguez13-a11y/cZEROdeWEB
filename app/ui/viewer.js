// Full-screen viewer (DESIGN §1.5 Viewer, §5.1): an overlay appended to <body> (the privacy cover hides it) that
// shows one ViewerItem at a time in the mode format.viewerMode() picks: image (fit; click / double-tap 2× zoom;
// browser pinch-zoom), audio, video, text (≤ 2 MiB, wrap toggle), note (editable) or none (file info). Prev/next
// within the given list (buttons, ← →, swipe ≥ 50 px in < 300 ms); Esc, Back or swipe-down closes. Owner: F.
//
// History: routed:false pushes ONE entry (router.pushOverlay) that Back pops; routed:true means the caller owns the
// route (vault-view at #/vault/item/<key>): prev/next replace the route's last segment with the new item's key and
// closing calls onClose(reason) — on 'user' the caller then navigates back. onClose reasons: 'user' (close button,
// Esc, swipe-down), 'back' (Back, routed:false only), 'closed' (handle.close() / closeViewer()), 'purge' (lock),
// 'replaced' (another openViewer), 'empty' (update([])).
// Actions: the bar shows item.actions; a click calls onAction(action, item) synchronously (so a save picker can
// open), 'editNote' is the note editor's Save: onAction('editNote', item, {title, body}) (may return a Promise).
// Saving a note makes a new item (DESIGN §1.5): when that Promise resolves to {key} (or the new ItemInfo {id}), the
// viewer keeps showing the note under its new key, whether the caller's update() comes before or after.
// Sources: item.getSource() is called on every show; the DecryptSource is handed back with media.disposeSource()
// when the viewer moves on or closes. Optional extra ViewerItem fields used when present: fav, mtime, addedAt.
// Node-importable: the DOM is only touched inside functions.

import { h, icon, trapFocus, announce } from '../util/dom.js';
import * as state from '../state.js';
import * as router from '../router.js';
import { isCancel, userMessage } from '../errors.js';
import { CAPS } from '../config.js';
import { extOf, fmtDate, fmtSize, kindOf, safeFilename, viewerMode } from '../util/format.js';
import { attachMedia, detachMedia, disposeSource, readNote, readText } from '../media/media.js';
import { kindIcon, menu } from './components.js';
import { pause as pausePlayer, trackMedia } from './player.js';

const SWIPE_PX = 50;
const SWIPE_MS = 300;
const DOUBLE_TAP_MS = 300;
const KIND_LABEL = { image: 'Photo', video: 'Video', audio: 'Music', doc: 'Document', note: 'Note', other: 'File' };
const ACTIONS = {
  fav: { icon: 'star', label: 'Favorite' },
  save: { icon: 'download', label: 'Save' },
  share: { icon: 'share', label: 'Share' },
  send: { icon: 'send', label: 'Send' },
  addToVault: { icon: 'lock', label: 'Add to vault' },
  rename: { icon: 'note', label: 'Rename', more: true },
  album: { icon: 'album', label: 'Add to album', more: true },
  delete: { icon: 'trash', label: 'Delete', more: true, danger: true },
  // Shown on the audio card itself, not in the bar: hands the track to the player dock (it keeps playing on other screens).
  play: { icon: 'play', label: 'Play in background', inline: true },
};
/** Offered on the info card of 'none' items and of items this device can't show. */
const CARD_ACTIONS = ['save', 'share', 'send', 'addToVault'];

let active = null;

/**
 * Opens the viewer (closing one already open).
 * @param {{items: import('../types.js').ViewerItem[], index?: number, onAction?: (action: string, item: object, payload?: object) => any,
 *   onClose?: (reason: string) => void, routed?: boolean}} opts
 * @returns {{close(): void, setIndex(i: number): void, update(items: import('../types.js').ViewerItem[]): void}}
 */
export function openViewer({ items, index = 0, onAction, onClose, routed = false } = {}) {
  if (active) active.close('replaced');
  const v = createViewer({ items: Array.isArray(items) ? [...items] : [], index, onAction, onClose, routed: Boolean(routed) });
  active = v;
  return { close: () => v.close('closed'), setIndex: (i) => v.setIndex(i), update: (list) => v.update(list) };
}

/** Closes the open viewer, if any. */
export function closeViewer() {
  active?.close('closed');
}

state.onPurge(() => active?.close('purge'));

function createViewer({ items: initial, index: startIndex, onAction, onClose, routed }) {
  const d = globalThis.document;
  let items = initial;
  let index = clampIndex(startIndex, items.length);
  let closed = false;
  let loadSeq = 0;
  let cur = null; // {item, mode, src, handle, ctl, offTrack, note}
  let zoomed = false;
  let swipe = null;
  let lastTap = null;
  let wrapText = true;
  let offMenu = null; // the "More" menu of the current action bar
  let saving = null; // {key, lost} while a note save runs: the saved note gets a new key (DESIGN §1.5)
  const previousFocus = d.activeElement;
  const app = d.getElementById('app');
  const weInerted = Boolean(app && !app.inert);

  const nameEl = h('h2', { class: 'vw-name', id: 'vw-name' });
  const metaEl = h('p', { class: 'vw-meta' });
  const counter = h('span', { class: 'vw-count' });
  const closeBtn = h('button', { type: 'button', class: 'btn-icon vw-close', aria: { label: 'Close viewer' }, title: 'Close (Esc)', on: { click: () => close('user') } },
    icon('close', { className: 'vw-ico-close' }), icon('back', { className: 'vw-ico-back' }));
  const actions = h('div', { class: 'vw-actions', role: 'toolbar', aria: { label: 'Item actions' } });
  const stage = h('div', { class: 'vw-stage' });
  const prevBtn = h('button', { type: 'button', class: 'vw-nav vw-prev', aria: { label: 'Previous' }, title: 'Previous (←)', on: { click: () => step(-1) } }, icon('back'));
  const nextBtn = h('button', { type: 'button', class: 'vw-nav vw-next', aria: { label: 'Next' }, title: 'Next (→)', on: { click: () => step(1) } }, icon('back'));
  const root = h('div', { class: 'vw-root', role: 'dialog', tabIndex: -1, aria: { modal: 'true', labelledby: 'vw-name' } },
    h('header', { class: 'vw-bar' }, closeBtn, h('div', { class: 'vw-title' }, nameEl, h('div', { class: 'vw-sub' }, counter, metaEl))),
    actions,
    h('div', { class: 'vw-main' }, stage, prevBtn, nextBtn));

  root.addEventListener('keydown', onKey);
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', () => (swipe = null));
  stage.addEventListener('click', onStageClick);

  d.body.append(root);
  d.documentElement.classList.add('vw-open');
  if (weInerted) app.inert = true;
  const releaseFocus = trapFocus(root);
  root.focus({ preventScroll: true });
  const overlay = routed ? null : router.pushOverlay(() => close('back', { fromPop: true }));

  load();

  // ───────── navigation

  function clampIndex(i, n) {
    const x = Math.floor(Number(i) || 0);
    return n ? Math.min(Math.max(0, x), n - 1) : 0;
  }

  function step(delta) {
    if (closed || !items.length) return;
    const i = index + delta;
    if (i < 0 || i >= items.length) return;
    go(i);
  }

  function go(i) {
    index = i;
    load();
    replaceRoute(items[index]?.key);
  }

  /** routed: the route's last segment follows the shown item (replaceState, no history entry). */
  function replaceRoute(key) {
    if (!routed || typeof key !== 'string') return;
    const r = router.current();
    if (r.top && r.parts.length && r.parts.at(-1) !== key) router.navigate(router.hrefFor(r.top, ...r.parts.slice(0, -1), key), { replace: true });
  }

  function setIndex(i) {
    if (closed || !items.length) return;
    const j = clampIndex(i, items.length);
    if (j === index && cur) return;
    index = j;
    load();
  }

  function update(list) {
    if (closed) return;
    const key = cur?.item?.key ?? items[index]?.key;
    items = Array.isArray(list) ? [...list] : [];
    if (!items.length) {
      close('empty');
      return;
    }
    if (follow(key)) return;
    // The note being saved left the list under its old key: its new key arrives with the save (settleSave).
    if (saving && saving.key === key) {
      saving.lost = true;
      return;
    }
    index = clampIndex(index, items.length);
    load();
  }

  /** Keeps showing the current item when `key` is in the list (its position may change). */
  function follow(key) {
    const same = items.findIndex((x) => x.key === key);
    if (same < 0) return false;
    index = same;
    if (cur) cur.item = items[same];
    paintChrome();
    return true;
  }

  /** A note save finished: newKey (or null) is what onAction('editNote') resolved to. */
  function settleSave(oldKey, newKey) {
    const s = saving;
    saving = null;
    if (closed || !cur || cur.item.key !== oldKey) return;
    if (newKey && newKey !== oldKey) {
      const i = items.findIndex((x) => x.key === oldKey);
      cur.item = { ...cur.item, key: newKey };
      if (!follow(newKey) && i >= 0) items[i] = cur.item; // the caller's update() comes later and finds it
      replaceRoute(newKey);
      return;
    }
    if (s?.lost) {
      index = clampIndex(index, items.length);
      load();
    }
  }

  // ───────── loading

  function release() {
    if (!cur) return;
    const c = cur;
    cur = null;
    c.ctl.abort();
    c.offTrack?.();
    for (const el of stage.querySelectorAll('video, audio')) detachMedia(el);
    c.handle?.release();
    disposeSource(c.src);
  }

  /**
   * A note edited but not saved is handed to the caller whenever the viewer leaves it (another item, close, lock):
   * onAction('editNote', item, {title, body, reason}). On a lock (reason 'purge') the caller decides whether it can
   * still save it (DESIGN §1.5 "dirty editor is saved before lock").
   */
  function flushNote(reason) {
    if (!cur?.note?.dirty()) return;
    try {
      const r = callAction('editNote', cur.item, { ...cur.note.payload(), reason });
      if (r && typeof r.then === 'function') r.then(undefined, (e) => globalThis.console?.error?.('[viewer] saving the note failed', e));
    } catch {
      // reported by the caller
    }
  }

  async function load() {
    flushNote('navigate');
    const seq = ++loadSeq;
    release();
    setZoom(false);
    const item = items[index];
    if (!item) return;
    const mode = viewerMode(item.type, item.name, item.size);
    const ctl = new AbortController();
    cur = { item, mode, src: null, handle: null, ctl, offTrack: null, note: null };
    root.dataset.mode = mode;
    paintChrome();
    stage.replaceChildren(loading());
    let src;
    try {
      src = await item.getSource();
    } catch (e) {
      if (seq === loadSeq && !closed) showProblem(e);
      return;
    }
    if (seq !== loadSeq || closed) {
      disposeSource(src);
      return;
    }
    cur.src = src;
    try {
      if (mode === 'image' || mode === 'audio' || mode === 'video') await showMedia(seq, mode, src, ctl.signal);
      else if (mode === 'text') await showText(seq, src);
      else if (mode === 'note') await showNote(seq, src);
      else showNone();
    } catch (e) {
      if (seq !== loadSeq || closed || isCancel(e)) return;
      showProblem(e);
    }
  }

  async function showMedia(seq, mode, src, signal) {
    const item = cur.item;
    let el;
    let box;
    if (mode === 'image') {
      el = h('img', { class: 'vw-img', alt: safeFilename(item.name), draggable: false, decoding: 'async' });
      box = h('div', { class: 'vw-img-wrap' }, el);
    } else if (mode === 'video') {
      el = h('video', { class: 'vw-video', controls: true, playsInline: true, preload: 'metadata', attrs: { controlslist: 'nodownload noremoteplayback', disableremoteplayback: true } });
      box = el;
    } else {
      el = h('audio', { class: 'vw-audio-el', controls: true, preload: 'metadata', attrs: { controlslist: 'nodownload' } });
      const bg = actionsOf(item).includes('play') ? h('div', { class: 'vw-audio-bg' },
        h('button', { type: 'button', class: 'btn btn-sm vw-audio-bgbtn', on: { click: () => callAction('play', item) } }, icon('play'), h('span', { text: ACTIONS.play.label })),
        h('p', { class: 'vw-audio-hint', text: 'Keeps playing while you look around the app.' })) : null;
      box = h('div', { class: 'vw-audio' }, h('div', { class: 'vw-audio-art' }, icon('music')), h('p', { class: 'vw-audio-name', text: safeFilename(item.name) }), el, bg);
    }
    // Hidden while loading; the element must be in the document for some engines to load it.
    box.classList.add('vw-pending');
    stage.append(box);
    if (mode !== 'image') {
      cur.offTrack = trackMedia(el);
      el.addEventListener('play', () => pausePlayer());
    }
    const handle = await attachMedia(el, src, { mode, signal });
    if (seq !== loadSeq || closed) {
      handle.release();
      return;
    }
    cur.handle = handle;
    stage.replaceChildren(box);
    box.classList.remove('vw-pending');
    root.dataset.via = handle.via;
  }

  async function showText(seq, src) {
    const { text, truncated } = await readText(src, { maxBytes: CAPS.text });
    if (seq !== loadSeq || closed) return;
    const pre = h('pre', { class: 'vw-text', tabIndex: 0, text, aria: { label: `Contents of ${safeFilename(cur.item.name)}` } });
    const wrapBtn = h('button', {
      type: 'button',
      class: 'btn btn-sm btn-ghost vw-wrap-btn',
      aria: { pressed: String(wrapText) },
      text: 'Wrap lines',
      on: {
        click: () => {
          wrapText = !wrapText;
          wrapBtn.setAttribute('aria-pressed', String(wrapText));
          box.classList.toggle('vw-nowrap', !wrapText);
        },
      },
    });
    const box = h('div', { class: ['vw-textbox', wrapText ? null : 'vw-nowrap'] },
      h('div', { class: 'vw-textbar' },
        truncated ? h('p', { class: 'vw-trunc' }, icon('info'), h('span', { text: `Showing the first ${fmtSize(CAPS.text)} — save the file to see all of it.` })) : h('span', { class: 'vw-textkind', text: extOf(cur.item.name) ? `.${extOf(cur.item.name)}` : 'Text' }),
        wrapBtn),
      pre);
    stage.replaceChildren(box);
  }

  async function showNote(seq, src) {
    const note = await readNote(src);
    if (seq !== loadSeq || closed) return;
    const item = cur.item;
    const editable = actionsOf(item).includes('editNote');
    const titleIn = h('input', { class: 'input vw-note-title', type: 'text', value: note.title, autocomplete: 'off', spellcheck: true, readOnly: !editable, aria: { label: 'Title' }, maxLength: 200 });
    const bodyIn = h('textarea', { class: 'input vw-note-body', value: note.body, spellcheck: true, readOnly: !editable, aria: { label: 'Note' } });
    const status = h('span', { class: 'vw-note-status', aria: { live: 'polite' } });
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary vw-note-save', disabled: true }, icon('check'), h('span', { text: 'Save' }));
    const state0 = { title: note.title, body: note.body };
    const dirty = () => titleIn.value !== state0.title || bodyIn.value !== state0.body;
    const paint = (msg) => {
      saveBtn.disabled = !dirty();
      status.textContent = msg ?? (dirty() ? 'Unsaved changes' : '');
    };
    const save = async () => {
      if (!dirty() || saveBtn.disabled || saving) return;
      const payload = { title: titleIn.value, body: bodyIn.value };
      const before = { ...state0 };
      // The caller has this version now: leaving the note right away must not hand it over a second time.
      Object.assign(state0, payload);
      saveBtn.disabled = true;
      status.textContent = 'Saving…';
      const it = cur?.item ?? item;
      saving = { key: it.key, lost: false };
      try {
        // The saved note is a new item (new id): a result with its key ({key} or the ItemInfo {id}) keeps it shown.
        const r = await callAction('editNote', it, payload);
        const newKey = r && typeof r === 'object' ? (typeof r.key === 'string' ? r.key : typeof r.id === 'string' ? r.id : null) : null;
        settleSave(it.key, newKey);
        if (seq === loadSeq && !closed) paint('Saved');
      } catch (e) {
        settleSave(it.key, null);
        Object.assign(state0, before);
        if (seq === loadSeq && !closed) paint(userMessage(e));
      }
    };
    saveBtn.addEventListener('click', save);
    for (const el of [titleIn, bodyIn]) el.addEventListener('input', () => paint());
    const form = h('div', { class: 'vw-note' },
      titleIn,
      bodyIn,
      editable ? h('div', { class: 'vw-note-foot' }, status, saveBtn) : null);
    form.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    });
    cur.note = { dirty, payload: () => ({ title: titleIn.value, body: bodyIn.value }), clear: () => { titleIn.value = ''; bodyIn.value = ''; } };
    stage.replaceChildren(form);
  }

  function showNone() {
    const item = cur.item;
    const kind = kindOf(item.type, item.name);
    const ext = extOf(item.name);
    // Photos/videos/music this app can't hand to the browser (HEIC, TIFF, …) say so; photos above CAPS.image are
    // too big (viewerMode); other files have no preview.
    let text = 'No preview for this kind of file.';
    if (kind === 'image' && Number(item.size) > CAPS.image) text = userMessage('too-big-to-preview');
    else if ((kind === 'image' || kind === 'video' || kind === 'audio') && ext) text = `This device can't ${kind === 'image' ? 'show' : 'play'} .${ext} files.`;
    stage.replaceChildren(infoCard(item, { icon: kindIcon(kind), text }));
  }

  function showProblem(e) {
    if (!cur) return;
    const item = cur.item;
    const ext = extOf(item.name);
    const code = e?.code;
    let text;
    if (code === 'unsupported-media') text = ext ? `This device can't ${cur.mode === 'image' ? 'show' : 'play'} .${ext} files.` : userMessage(e);
    else text = userMessage(e);
    stage.replaceChildren(infoCard(item, { icon: h('span', { class: 'vw-warn-icon' }, icon('warning')), text, problem: true }));
    announce(text);
  }

  function infoCard(item, { icon: ic, text, problem = false }) {
    const acts = actionsOf(item).filter((a) => CARD_ACTIONS.includes(a));
    const kind = kindOf(item.type, item.name);
    return h('div', { class: ['vw-card', problem ? 'vw-card-problem' : null] },
      h('div', { class: 'vw-card-icon' }, ic),
      h('p', { class: 'vw-card-name', text: safeFilename(item.name) }),
      h('p', { class: 'vw-card-meta', text: [KIND_LABEL[kind], fmtSize(item.size), dateOf(item)].filter(Boolean).join(' · ') }),
      h('p', { class: 'vw-card-text', text }),
      acts.length ? h('div', { class: 'vw-card-actions' }, acts.map((a, i) => h('button', {
        type: 'button',
        class: ['btn', i === 0 ? 'btn-primary' : null],
        on: { click: () => callAction(a, item) },
      }, icon(ACTIONS[a].icon), h('span', { text: ACTIONS[a].label })))) : null);
  }

  function loading() {
    return h('div', { class: 'vw-loading', role: 'status' }, h('span', { class: 'vw-spinner', aria: { hidden: 'true' } }), h('span', { class: 'vw-loading-text', text: 'Decrypting…' }));
  }

  // ───────── chrome

  function actionsOf(item) {
    return Array.isArray(item?.actions) ? item.actions : [];
  }

  function dateOf(item) {
    const t = Number.isFinite(item?.mtime) ? item.mtime : Number.isFinite(item?.addedAt) ? item.addedAt : null;
    return t === null ? '' : fmtDate(t);
  }

  function paintChrome() {
    const item = items[index];
    if (!item) return;
    const name = safeFilename(item.name);
    nameEl.textContent = name;
    nameEl.title = name;
    counter.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
    counter.hidden = items.length < 2;
    const kind = kindOf(item.type, item.name);
    metaEl.textContent = [KIND_LABEL[kind], fmtSize(item.size), dateOf(item)].filter(Boolean).join(' · ');
    prevBtn.hidden = index <= 0;
    nextBtn.hidden = index >= items.length - 1;
    paintActions(item);
  }

  function paintActions(item) {
    offMenu?.();
    offMenu = null;
    const list = actionsOf(item).filter((a) => Object.hasOwn(ACTIONS, a) && !ACTIONS[a].inline);
    const buttons = [];
    for (const a of list.filter((x) => !ACTIONS[x].more)) {
      const spec = ACTIONS[a];
      const fav = a === 'fav';
      const on = fav && item.fav === true;
      const label = fav ? (on ? 'Unfavorite' : 'Favorite') : spec.label;
      buttons.push(h('button', {
        type: 'button',
        class: ['vw-act', fav ? 'vw-act-fav' : null],
        title: label,
        aria: { label, pressed: fav ? String(on) : undefined },
        on: { click: () => callAction(a, item) },
      }, icon(fav && on ? 'star-filled' : spec.icon), h('span', { class: 'vw-act-label', text: fav ? 'Favorite' : spec.label })));
    }
    const more = list.filter((x) => ACTIONS[x].more);
    if (more.length) {
      const btn = h('button', { type: 'button', class: 'vw-act vw-act-more', title: 'More', aria: { label: 'More actions' } }, icon('more'), h('span', { class: 'vw-act-label', text: 'More' }));
      offMenu = menu(btn, more.map((a) => ({ label: ACTIONS[a].label, icon: ACTIONS[a].icon, danger: ACTIONS[a].danger, onClick: () => callAction(a, item) })));
      buttons.push(btn);
    }
    actions.replaceChildren(...buttons);
    actions.hidden = buttons.length === 0;
  }

  /** onAction runs synchronously inside the click (user activation is kept for pickers). Returns its result. */
  function callAction(action, item, payload) {
    if (typeof onAction !== 'function') return undefined;
    try {
      const r = payload === undefined ? onAction(action, item) : onAction(action, item, payload);
      if (r && typeof r.then === 'function' && action !== 'editNote') r.then(undefined, (e) => globalThis.console?.error?.('[viewer] action failed', e));
      return r;
    } catch (e) {
      globalThis.console?.error?.('[viewer] action failed', e);
      if (action === 'editNote') throw e;
      return undefined;
    }
  }

  // ───────── zoom and gestures

  function setZoom(on, at) {
    const img = stage.querySelector('.vw-img');
    if (!on || !img) {
      zoomed = false;
      stage.classList.remove('vw-zoomed');
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
      if (img) {
        img.style.width = '';
        img.style.height = '';
      }
      return;
    }
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const fx = at ? (at.x - r.left) / r.width : 0.5;
    const fy = at ? (at.y - r.top) / r.height : 0.5;
    zoomed = true;
    stage.classList.add('vw-zoomed');
    img.style.width = `${Math.round(r.width * 2)}px`;
    img.style.height = `${Math.round(r.height * 2)}px`;
    const s = stage.getBoundingClientRect();
    const px = at ? at.x - s.left : s.width / 2;
    const py = at ? at.y - s.top : s.height / 2;
    stage.scrollLeft = Math.max(0, fx * r.width * 2 - px);
    stage.scrollTop = Math.max(0, fy * r.height * 2 - py);
  }

  function onStageClick(e) {
    // Mouse: a click on the photo toggles 2× zoom (touch uses double-tap, see onPointerUp).
    if (cur?.mode !== 'image' || e.pointerType === 'touch' || e.pointerType === 'pen' || !(e.target instanceof Element) || !e.target.closest('.vw-img')) return;
    if (e.detail === 0) return; // keyboard "click"
    setZoom(!zoomed, { x: e.clientX, y: e.clientY });
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse') return;
    if (!e.isPrimary) {
      swipe = null; // a second finger: pinch, not a swipe
      return;
    }
    // Native media controls (an audio element, the bottom strip of a video) keep their own drags (seeking).
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest('audio, .vw-note, .vw-textbar')) return;
    if (t && t.matches('video')) {
      const r = t.getBoundingClientRect();
      if (e.clientY > r.bottom - 72) return;
    }
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
  }

  function onPointerUp(e) {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    const dt = e.timeStamp - swipe.t;
    swipe = null;
    const pinched = (globalThis.visualViewport?.scale ?? 1) > 1.01;
    if (dt < SWIPE_MS && !zoomed && !pinched) {
      if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
        step(dx < 0 ? 1 : -1);
        return;
      }
      if (dy >= SWIPE_PX && dy > Math.abs(dx) * 1.5) {
        close('user');
        return;
      }
    }
    if (cur?.mode === 'image' && Math.hypot(dx, dy) < 12 && e.target instanceof Element && e.target.closest('.vw-img, .vw-img-wrap')) {
      if (lastTap && e.timeStamp - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap = null;
        setZoom(!zoomed, { x: e.clientX, y: e.clientY });
      } else {
        lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      }
    }
  }

  function onKey(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target instanceof Element ? e.target : null;
    const typing = t && t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    if (e.key === 'Escape') {
      if (t && t.closest('[role="menu"]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (zoomed) setZoom(false);
      else close('user');
      return;
    }
    if (typing || (t && t.closest('video, audio, [role="menu"], .vw-text'))) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    }
  }

  // ───────── close

  function close(reason = 'user', { fromPop = false } = {}) {
    if (closed) return;
    flushNote(reason);
    closed = true;
    loadSeq++;
    cur?.note?.clear();
    release();
    offMenu?.();
    offMenu = null;
    stage.replaceChildren();
    root.removeEventListener('keydown', onKey);
    releaseFocus();
    root.remove();
    d.documentElement.classList.remove('vw-open');
    if (weInerted && app) app.inert = false;
    if (active && active.close === close) active = null;
    if (overlay && !fromPop) overlay.close();
    if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
    try {
      onClose?.(reason);
    } catch (e) {
      globalThis.console?.error?.('[viewer] onClose failed', e);
    }
  }

  return { close, setIndex, update, go };
}
