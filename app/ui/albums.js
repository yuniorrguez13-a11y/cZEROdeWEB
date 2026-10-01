// Albums: the strip above the vault grid, the album editor sheet, the add-to-album dialog and small helpers the
// vault view uses for album headers and playback (DESIGN §1.5 Albums, §10). Owner: V1b.
// An album is a list of item ids (an item can be in many albums); its cover is one of its items (default: the
// first item with a thumbnail). Names are untrusted labels: only ever rendered as text.
// Thumbnails come from vault.thumbUrl (shared per item, reference-counted, all revoked by the vault on lock); each
// piece keeps the references it got in a thumbRefs() bag and hands them back with vault.releaseThumb when it goes
// away (§12).
// Every piece re-renders from vault 'lists'/'items'/'status' events and clears itself on lock.
// Node-importable: the DOM is only touched inside functions.

import { isCancel, userMessage } from '../errors.js';
import * as state from '../state.js';
import { current as currentRoute, navigate } from '../router.js';
import { announce, confirmDialog, h, icon, modal, promptDialog, sheet, toast } from '../util/dom.js';
import { fmtDuration, fmtSize } from '../util/format.js';
import { kindIcon } from './components.js';
import { playQueue } from './player.js';

const KIND_LABEL = { image: 'Photo', video: 'Video', audio: 'Music', doc: 'Document', note: 'Note', other: 'File' };
const ORDER_SAVE_MS = 400;
const LAZY_MARGIN = '200px';
const COVER_SCAN = 48;
/** The editor shows this many rows at first, and this many more each time the end comes near. */
const ROWS_PAGE = 200;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function report(e) {
  if (isCancel(e)) return;
  toast(userMessage(e), { kind: 'err' });
}

/**
 * A toast that names albums or items (decrypted names), shown after an await: only while the vault is still unlocked
 * (a lock during that await must not leave a name on the locked screen).
 */
function namedToast(vault, msg, opts) {
  if (vault?.status !== 'unlocked') return null;
  return toast(msg, opts);
}

/** vault.item(id) or null (removed meanwhile, or locked). */
function itemOr(vault, id) {
  try {
    return vault.item(id);
  } catch {
    return null;
  }
}

function listsOr(vault) {
  try {
    return vault.status === 'unlocked' ? vault.lists() : [];
  } catch {
    return [];
  }
}

function listOr(vault, id) {
  try {
    return vault.list(id);
  } catch {
    return null;
  }
}

/**
 * The item shown as the album's cover: its cover, else the first item with a thumbnail among its first
 * COVER_SCAN items (the strip re-renders on every import: a 10,000-item album of documents must not be walked each
 * time). -> ItemInfo|null.
 */
export function albumCover(vault, list) {
  const ids = list?.itemIds ?? [];
  if (list?.cover) {
    const c = itemOr(vault, list.cover);
    if (c) return c;
  }
  for (let i = 0; i < Math.min(ids.length, COVER_SCAN); i++) {
    const it = itemOr(vault, ids[i]);
    if (it?.hasThumb) return it;
  }
  return null;
}

/** The album's first item that still exists (its kind icon stands in when no item has a thumbnail). -> ItemInfo|null. */
function firstItem(vault, list) {
  for (const id of list?.itemIds ?? []) {
    const it = itemOr(vault, id);
    if (it) return it;
  }
  return null;
}

/** The album id of a route (#/vault/album/<id>) or null. */
function routeAlbum(r) {
  return r?.top === 'vault' && r.parts?.[0] === 'album' ? r.parts[1] ?? null : null;
}

/**
 * The thumbnail references one piece (strip card, editor, picker) holds: every vault.thumbUrl() that returned a URL
 * adds its id once; releaseThumbs() hands them all back. `gen` moves on at each release, so a load still running
 * then gives its reference straight back instead of keeping it.
 * @returns {{ids: string[], gen: number}}
 */
function thumbRefs() {
  return { ids: [], gen: 0 };
}

function releaseOne(vault, id) {
  try {
    vault.releaseThumb?.(id);
  } catch {
    // locked: already revoked
  }
}

/**
 * A thumbnail box (used: the piece's thumbRefs() bag, released when the piece goes away): the item's decrypted
 * thumbnail when it has one (loaded when it comes near the screen), else its kind icon. alt = item name (empty when
 * `decorative`).
 */
function thumbBox(vault, info, { className, decorative = false, observer, used } = {}) {
  const box = h('span', { class: ['al-thumb', className], dataset: { kind: info?.kind ?? 'other' } });
  const fallback = () => box.replaceChildren(kindIcon(info?.kind ?? 'other'));
  fallback();
  if (!info?.hasThumb) return box;
  let tried = 0;
  const load = () => {
    const gen = used?.gen;
    vault.thumbUrl(info.id).then((url) => {
      if (!url) return;
      // Not shown (the box left, or the piece already released its thumbnails): the reference goes straight back.
      if (!used || used.gen !== gen || (observer && !box.isConnected)) {
        releaseOne(vault, info.id);
        return;
      }
      used.ids.push(info.id);
      const img = h('img', { src: url, alt: decorative ? '' : info.name, decoding: 'async', draggable: false });
      img.addEventListener('error', () => {
        // A broken image (or the vault revoked it): hand this reference back, ask once more, then show the icon.
        const i = used.ids.indexOf(info.id);
        if (used.gen === gen && i >= 0) {
          used.ids.splice(i, 1);
          releaseOne(vault, info.id);
        }
        if (tried++ < 1) load();
        else fallback();
      }, { once: true });
      box.replaceChildren(img);
      box.classList.add('al-thumb-img');
    }, () => {});
  };
  if (observer) {
    box.czdLoad = load;
    observer.observe(box);
  } else {
    load();
  }
  return box;
}

/** Hands a piece's thumbnail references back to the vault (§12: when what shows them leaves the DOM). Safe while locked. */
function releaseThumbs(vault, refs) {
  refs.gen++;
  for (const id of refs.ids.splice(0)) releaseOne(vault, id);
}

function lazyObserver() {
  if (typeof IntersectionObserver !== 'function') return null;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      e.target.czdLoad?.();
    }
  }, { rootMargin: LAZY_MARGIN });
  return io;
}

// ───────── dialogs and helpers (also used by the vault view)

/**
 * "New album": asks for a name, creates it (with itemIds). -> ListInfo|null.
 * @param {{vault: object, itemIds?: string[], name?: string}} opts
 */
export async function createAlbumDialog({ vault, itemIds = [], name = '' } = {}) {
  const value = await promptDialog({ title: 'New album', label: 'Album name', value: name, placeholder: 'e.g. Summer 2026' });
  if (value === null) return null;
  try {
    const l = await vault.createList({ name: value.trim() || 'Album', itemIds });
    namedToast(vault, itemIds.length ? `Album “${l.name}” created with ${plural(l.itemIds.length, 'item')}.` : `Album “${l.name}” created.`, { kind: 'ok' });
    return l;
  } catch (e) {
    report(e);
    return null;
  }
}

/**
 * Renames an album (asks for the name). -> ListInfo|null.
 * @param {{vault: object, id: string}} opts
 */
export async function renameAlbumDialog({ vault, id } = {}) {
  const l = listOr(vault, id);
  if (!l) return null;
  const value = await promptDialog({ title: 'Rename album', label: 'Album name', value: l.name });
  if (value === null || !value.trim() || value.trim() === l.name) return null;
  try {
    return await vault.updateList(id, { name: value.trim() });
  } catch (e) {
    report(e);
    return null;
  }
}

/**
 * Deletes an album after a confirmation (its items stay in the vault). Leaves the album's route when it is open.
 * -> true when deleted.
 * @param {{vault: object, id: string}} opts
 */
export async function deleteAlbumDialog({ vault, id } = {}) {
  const l = listOr(vault, id);
  if (!l) return false;
  if (!(await confirmDeleteAlbum(l))) return false;
  return removeAlbum(vault, id, l.name);
}

function confirmDeleteAlbum(l) {
  return confirmDialog({
    title: 'Delete album?',
    message: `“${l.name}” goes away. Its ${plural(l.itemIds.length, 'item')} stay in your vault.`,
    confirmLabel: 'Delete album',
    danger: true,
  });
}

async function removeAlbum(vault, id, name) {
  try {
    await vault.removeList(id);
  } catch (e) {
    report(e);
    return false;
  }
  namedToast(vault, `Album “${name}” deleted.`, { kind: 'ok' });
  if (routeAlbum(currentRoute()) === id) navigate('#/vault', { replace: true });
  return true;
}

/**
 * The album's items as ViewerItems (for the viewer or the player); getSource opens the vault item.
 * @param {{vault: object, id: string}} opts
 * @returns {import('../types.js').ViewerItem[]}
 */
export function albumViewerItems({ vault, id } = {}) {
  const l = listOr(vault, id);
  if (!l) return [];
  const out = [];
  for (const itemId of l.itemIds) {
    const it = itemOr(vault, itemId);
    if (!it) continue;
    out.push({
      key: it.id,
      name: it.name,
      type: it.type,
      kind: it.kind,
      size: it.size,
      fav: it.fav,
      mtime: it.mtime,
      addedAt: it.addedAt,
      getSource: () => vault.sourceFor(it.id),
    });
  }
  return out;
}

/**
 * True when the album holds music or video (the album header shows ▶ Play).
 * @param {object} vault
 * @param {string} id
 * @returns {boolean}
 */
export function albumHasPlayable(vault, id) {
  const l = listOr(vault, id);
  return Boolean(l?.itemIds.some((x) => {
    const k = itemOr(vault, x)?.kind;
    return k === 'audio' || k === 'video';
  }));
}

/**
 * Plays the album's music/video in the player dock. start: index into the album's playable items.
 * @param {{vault: object, id: string, start?: number, shuffle?: boolean}} opts
 * @returns {boolean} false when there is nothing to play
 */
export function playAlbum({ vault, id, start = 0, shuffle = false } = {}) {
  const l = listOr(vault, id);
  const items = albumViewerItems({ vault, id }).filter((it) => it.kind === 'audio' || it.kind === 'video');
  if (!l || !items.length) return false;
  playQueue(items, { start: Math.max(0, Math.min(items.length - 1, start)), shuffle, title: l.name });
  return true;
}

// ───────── strip

/**
 * Horizontal album strip: one card per album (cover thumbnail, name, count) and a "+ New album" card. Re-renders on
 * vault changes and empties itself on lock. onOpen(id) opens an album (also called with a new album's id).
 * Extra: el.destroy() detaches the listeners (also done automatically once it is removed from the page).
 * @param {{vault: object, onOpen?: (id: string) => void}} opts
 * @returns {HTMLElement & {destroy(): void}}
 */
export function albumStrip({ vault, onOpen } = {}) {
  const count = h('span', { class: 'al-strip-count' });
  const list = h('ul', { class: 'al-strip-list' });
  const el = h('section', { class: 'al-strip', aria: { label: 'Albums' } },
    h('div', { class: 'al-strip-head' }, h('h2', { class: 'al-strip-title', text: 'Albums' }), count),
    list);
  let mounted = false;
  let destroyed = false;
  let scheduled = false;
  // Covers are decrypted when their card comes near the screen (the strip scrolls sideways; there may be many).
  const io = lazyObserver();

  const open = (id) => {
    try {
      onOpen?.(id);
    } catch (e) {
      globalThis.console?.error?.(e);
    }
  };

  // One card per album, kept for its lifetime and updated in place (imports fire many 'items' events: a rebuilt
  // card would flash its cover and drop keyboard focus). Only the cover box is replaced, when the cover changes.
  function makeCard(id) {
    const frame = h('span', { class: 'al-card-frame' });
    const name = h('span', { class: 'al-card-name' });
    const sub = h('span', { class: 'al-card-count' });
    const btn = h('button', { type: 'button', class: 'al-card', dataset: { id }, on: { click: () => open(id) } }, frame, name, sub);
    return { li: h('li', { class: 'al-strip-item' }, btn), btn, frame, name, sub, coverSig: null, used: thumbRefs() };
  }

  function paintCard(c, l) {
    const n = l.itemIds.length;
    c.name.textContent = l.name;
    c.sub.textContent = plural(n, 'item');
    c.btn.title = l.name;
    c.btn.setAttribute('aria-label', `${l.name}, ${plural(n, 'item')}`);
    const cover = albumCover(vault, l);
    const first = cover ? null : firstItem(vault, l);
    const sig = cover ? `t:${cover.id}:${cover.hasThumb ? 1 : 0}` : first ? `k:${first.kind}` : '';
    if (sig === c.coverSig) return;
    c.coverSig = sig;
    releaseThumbs(vault, c.used);
    const old = c.frame.firstElementChild;
    if (old) io?.unobserve(old);
    let thumb;
    if (cover) thumb = thumbBox(vault, cover, { className: 'al-card-cover', decorative: true, used: c.used, observer: io });
    else if (first) thumb = h('span', { class: 'al-thumb al-card-cover', dataset: { kind: first.kind } }, kindIcon(first.kind));
    else thumb = h('span', { class: 'al-thumb al-card-cover al-card-empty' }, icon('album'));
    c.frame.replaceChildren(thumb);
  }

  const newSub = h('span', { class: 'al-card-count' });
  let creating = false;
  const addLi = h('li', { class: 'al-strip-item' }, h('button', {
    type: 'button',
    class: 'al-card al-card-new',
    aria: { label: 'New album' },
    on: {
      click: async () => {
        if (creating) return; // a double click asks once
        creating = true;
        try {
          const l = await createAlbumDialog({ vault });
          if (l) open(l.id);
        } finally {
          creating = false;
        }
      },
    },
  },
  h('span', { class: 'al-card-frame' }, h('span', { class: 'al-thumb al-card-cover al-card-plus' }, icon('plus'))),
  h('span', { class: 'al-card-name', text: 'New album' }),
  newSub));
  const cards = new Map(); // id → card
  // The album shown by the route (#/vault/album/<id>) is marked as the current one.
  let activeId = routeAlbum(currentRoute());
  function markActive() {
    for (const [id, c] of cards) {
      const btn = c.li.firstElementChild;
      if (id === activeId) btn?.setAttribute('aria-current', 'page');
      else btn?.removeAttribute('aria-current');
    }
  }

  function render() {
    scheduled = false;
    if (destroyed) return;
    if (mounted && !el.isConnected) {
      el.destroy();
      return;
    }
    if (el.isConnected) mounted = true;
    const lists = listsOr(vault);
    el.hidden = vault?.status !== 'unlocked';
    count.textContent = lists.length ? String(lists.length) : '';
    newSub.textContent = lists.length ? 'Group anything' : 'Photos, music, files';
    const seen = new Set();
    const lis = lists.map((l) => {
      seen.add(l.id);
      let c = cards.get(l.id);
      if (!c) {
        c = makeCard(l.id);
        cards.set(l.id, c);
      }
      paintCard(c, l);
      return c.li;
    });
    for (const [id, c] of [...cards]) {
      if (seen.has(id)) continue;
      releaseThumbs(vault, c.used);
      const box = c.frame.firstElementChild;
      if (box) io?.unobserve(box);
      cards.delete(id);
    }
    lis.push(addLi);
    const now = [...list.children];
    if (now.length !== lis.length || now.some((x, i) => x !== lis[i])) {
      // Only the cards that changed place move: re-inserting all of them drops keyboard focus, and the scroll-snapped
      // strip would jump sideways (it re-snaps to a moved card), hiding the first albums.
      const active = globalThis.document?.activeElement;
      const x = list.scrollLeft;
      const want = new Set(lis);
      for (const c of now) if (!want.has(c)) c.remove();
      let node = list.firstElementChild;
      for (const li of lis) {
        if (node === li) node = node.nextElementSibling;
        else list.insertBefore(li, node);
      }
      if (list.scrollLeft !== x) list.scrollLeft = x;
      if (active && active !== globalThis.document.activeElement && list.contains(active)) active.focus({ preventScroll: true });
    }
    markActive();
    el.classList.toggle('al-strip-none', lists.length === 0);
  }
  const schedule = () => {
    if (scheduled || destroyed) return;
    scheduled = true;
    queueMicrotask(render);
  };
  const types = ['lists', 'items', 'status'];
  for (const t of types) vault?.addEventListener?.(t, schedule);
  const offPurge = state.onPurge(() => {
    for (const c of cards.values()) {
      const box = c.frame.firstElementChild;
      if (box) io?.unobserve(box);
    }
    cards.clear();
    list.replaceChildren();
    count.textContent = '';
    el.hidden = true;
  });
  const offRoute = state.on('route', (r) => {
    activeId = routeAlbum(r);
    markActive();
  });
  el.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const t of types) vault?.removeEventListener?.(t, schedule);
    offPurge();
    offRoute();
    io?.disconnect();
    for (const c of cards.values()) releaseThumbs(vault, c.used);
    cards.clear();
  };
  render();
  return el;
}

// ───────── editor

/**
 * Album editor sheet: rename, reorder (drag handles, and ↑/↓ buttons for keyboards and screen readers), remove items,
 * set the cover, delete the album. Changes save as they are made. -> the sheet {el, body, close()}.
 * @param {{vault: object, id: string}} opts
 */
export function albumEditor({ vault, id } = {}) {
  const l0 = listOr(vault, id);
  if (!l0) {
    toast('That album is gone.', { kind: 'warn' });
    return null;
  }
  let order = [...l0.itemIds];
  /** The album's items as last seen: one in the album that isn't among them was put there elsewhere meanwhile. */
  let known = new Set(l0.itemIds);
  let cover = l0.cover ?? null;
  let name = l0.name;
  let saveTimer = null;
  /** Local order changes not saved yet (saved ORDER_SAVE_MS after the last one, on close and before a lock). */
  let orderDirty = false;
  let dragging = null;
  let gone = false;
  let deleting = false;
  let asking = false;
  const io = lazyObserver();
  const used = thumbRefs();
  const rows = new Map(); // id → {li, up, down, coverBtn, ...}

  const nameInput = h('input', { class: 'input al-ed-name-input', id: `al-name-${id}`, type: 'text', value: name, maxLength: 200, autocomplete: 'off', spellcheck: false });
  const nameSaved = h('span', { class: 'al-ed-saved', role: 'status' });
  const countEl = h('span', { class: 'al-ed-count' });
  const listEl = h('ol', { class: 'al-ed-list', aria: { label: 'Album items' } });
  const empty = h('div', { class: 'empty al-ed-empty', hidden: true },
    h('div', { class: 'empty-icon' }, icon('album')),
    h('p', { class: 'empty-title', text: 'This album is empty' }),
    h('p', { class: 'empty-text', text: 'Select items in your vault and choose “Add to album”.' }));
  const delBtn = h('button', { type: 'button', class: 'btn btn-danger al-ed-delete', on: { click: () => del() } }, icon('trash'), h('span', { text: 'Delete album' }));
  let limit = ROWS_PAGE;
  const moreBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost al-ed-more-btn', on: { click: () => showMore() } });
  const moreBox = h('div', { class: 'al-ed-more', hidden: true }, moreBtn);
  function showMore() {
    limit += ROWS_PAGE;
    render();
  }
  // Scrolling near the end shows the next rows by itself.
  const moreIo = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && !moreBox.hidden && !dragging) showMore();
  }, { rootMargin: '300px' }) : null;
  moreIo?.observe(moreBox);

  const body = h('div', { class: 'al-ed' },
    h('div', { class: 'field al-ed-name' },
      h('div', { class: 'al-ed-name-head' }, h('label', { class: 'label', for: `al-name-${id}`, text: 'Name' }), nameSaved),
      nameInput),
    h('div', { class: 'al-ed-section' },
      h('h3', { class: 'al-ed-title' }, h('span', { text: 'Items' }), countEl),
      h('p', { class: 'hint al-ed-hint', text: 'Drag the handle to reorder, or use the arrows. The cover is what the album shows in the strip.' })),
    listEl,
    moreBox,
    empty,
    h('div', { class: 'al-ed-danger' },
      h('div', { class: 'al-ed-danger-text' },
        h('p', { class: 'al-ed-danger-title', text: 'Delete this album' }),
        h('p', { class: 'hint', text: 'Only the album goes away — its files stay in your vault.' })),
      delBtn));

  const sh = sheet({ title: name, body, className: 'al-editor', onClose: () => cleanup() });
  const titleEl = sh.el.querySelector('.sheet-title');

  // ── saving
  async function saveName() {
    const v = nameInput.value.trim();
    if (!v || v === name) {
      nameInput.value = name;
      return;
    }
    try {
      const l = await vault.updateList(id, { name: v });
      name = l.name;
      nameInput.value = name;
      if (titleEl) titleEl.textContent = name;
      nameSaved.textContent = 'Saved';
      setTimeout(() => {
        nameSaved.textContent = '';
      }, 1600);
    } catch (e) {
      report(e);
    }
  }
  nameInput.addEventListener('change', saveName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      saveName(); // focus stays in the sheet
    }
  });

  function scheduleOrder() {
    orderDirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushOrder, ORDER_SAVE_MS);
  }
  /**
   * The local order plus what was put in the album elsewhere since the editor last looked (an import into this album,
   * "Add to album"): saving the local order alone would take those items out again.
   */
  function mergedOrder() {
    const cur = listOr(vault, id);
    if (!cur) return order;
    const have = new Set(cur.itemIds);
    const mine = new Set(order);
    const extra = cur.itemIds.filter((x) => !mine.has(x) && !known.has(x));
    for (const x of extra) known.add(x);
    // ...and what was taken out elsewhere stays out
    const kept = order.filter((x) => have.has(x));
    return extra.length || kept.length !== order.length ? [...kept, ...extra] : order;
  }

  /** Saves the local order when it changed. updateList is called synchronously (a 'locking' listener relies on it). */
  async function flushOrder() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!orderDirty || deleting || vault.status !== 'unlocked') return;
    orderDirty = false;
    order = mergedOrder();
    try {
      await vault.updateList(id, { itemIds: order });
    } catch (e) {
      report(e);
    }
  }
  /** Saves whatever is still pending: a typed name (Esc/Back close without a 'change' event) and the order. */
  function saveNow() {
    if (deleting || vault.status !== 'unlocked') return;
    const v = nameInput.value.trim();
    if (v && v !== name) saveName();
    flushOrder();
  }

  // ── rows
  function rowFor(info) {
    const handle = h('span', { class: 'al-ed-handle', title: 'Drag to reorder', aria: { hidden: 'true' } }, h('span', { class: 'al-grip' }));
    const sub = [KIND_LABEL[info.kind] ?? 'File', fmtSize(info.size)];
    if (info.duration) sub.push(fmtDuration(info.duration));
    const up = h('button', { type: 'button', class: 'btn-icon al-ed-btn al-ed-up', aria: { label: `Move ${info.name} up` }, on: { click: () => move(info.id, -1, 'up') } }, icon('back'));
    const down = h('button', { type: 'button', class: 'btn-icon al-ed-btn al-ed-down', aria: { label: `Move ${info.name} down` }, on: { click: () => move(info.id, 1, 'down') } }, icon('back'));
    // A toggle: the second click of a double click would clear the cover the first one set.
    const coverBtn = h('button', { type: 'button', class: 'btn-icon al-ed-btn al-ed-cover', on: { click: (e) => e.detail > 1 || setCover(info.id) } }, icon('image'));
    // A double click must not also remove the next row, which moves under the pointer.
    const remove = h('button', { type: 'button', class: 'btn-icon al-ed-btn al-ed-remove', aria: { label: `Remove ${info.name} from the album` }, on: { click: (e) => e.detail > 1 || removeItem(info.id) } }, icon('close'));
    const badge = h('span', { class: 'badge badge-gold al-ed-badge', text: 'Cover', hidden: true });
    const li = h('li', { class: 'al-ed-row', dataset: { id: info.id } },
      handle,
      thumbBox(vault, info, { className: 'al-ed-thumb', observer: io, used }),
      h('div', { class: 'al-ed-meta' },
        h('span', { class: 'al-ed-item-name', text: info.name, title: info.name }),
        h('span', { class: 'al-ed-sub' }, h('span', { text: sub.join(' · ') }), badge)),
      h('div', { class: 'al-ed-actions' }, up, down, coverBtn, remove));
    return { li, up, down, coverBtn, badge, info };
  }

  function render() {
    const inOrder = new Set(order);
    for (const rid of [...rows.keys()]) if (!inOrder.has(rid)) rows.delete(rid);
    order = order.filter((x) => rows.has(x) || itemOr(vault, x));
    // Big albums (a folder import can make 10,000 items) show their first `limit` rows; more on demand.
    const lis = [];
    for (const x of order.slice(0, limit)) {
      let r = rows.get(x);
      if (!r) {
        const info = itemOr(vault, x);
        if (!info) continue;
        r = rowFor(info);
        rows.set(x, r);
      }
      lis.push(r.li);
    }
    const want = new Set(lis);
    for (const [rid, r] of [...rows]) if (!want.has(r.li)) rows.delete(rid);
    // Moves only the rows that are out of place (a swap moves one): re-inserting every row would re-lay the whole
    // list and drop keyboard focus.
    const active = globalThis.document?.activeElement;
    for (const c of [...listEl.children]) if (!want.has(c)) c.remove();
    let node = listEl.firstElementChild;
    for (const li of lis) {
      if (node === li) node = node.nextElementSibling;
      else listEl.insertBefore(li, node);
    }
    if (active && active !== globalThis.document.activeElement && listEl.contains(active)) active.focus({ preventScroll: true });
    const rest = order.length - lis.length;
    moreBox.hidden = rest <= 0;
    moreBtn.textContent = `Show ${Math.min(rest, ROWS_PAGE)} more`;
    paint();
  }

  function paint() {
    const n = order.length;
    countEl.textContent = String(n);
    empty.hidden = n > 0;
    listEl.hidden = n === 0;
    const shownCover = cover && order.includes(cover) ? cover : albumCover(vault, { itemIds: order })?.id ?? null;
    order.forEach((x, i) => {
      const r = rows.get(x);
      if (!r) return;
      r.up.disabled = i === 0;
      r.down.disabled = i === n - 1;
      const isCover = x === shownCover;
      r.li.classList.toggle('al-ed-is-cover', isCover);
      r.badge.hidden = !isCover;
      r.coverBtn.setAttribute('aria-pressed', String(x === cover));
      r.coverBtn.setAttribute('aria-label', x === cover ? `${r.info.name} is the cover` : `Use ${r.info.name} as the cover`);
      r.coverBtn.title = x === cover ? 'Cover' : 'Set as cover';
    });
  }

  function move(itemId, delta, which) {
    const i = order.indexOf(itemId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    if (j >= limit - 1) limit = j + 2; // keep the moved row (and its neighbour) on screen
    render();
    const r = rows.get(itemId);
    const btn = which === 'up' ? (r.up.disabled ? r.down : r.up) : (r.down.disabled ? r.up : r.down);
    btn.focus();
    announce(`Moved to position ${j + 1} of ${order.length}`);
    scheduleOrder();
  }

  async function setCover(itemId) {
    const next = cover === itemId ? null : itemId;
    const before = cover;
    cover = next;
    paint();
    try {
      await flushOrder();
      await vault.updateList(id, { cover: next });
      announce(next ? 'Cover set' : 'Cover cleared');
    } catch (e) {
      cover = before;
      paint();
      report(e);
    }
  }

  async function removeItem(itemId) {
    const at = order.indexOf(itemId);
    if (at < 0) return;
    const info = rows.get(itemId)?.info;
    // Keep focus in the list: the next row's remove button (or the previous one's).
    const nextId = order[at + 1] ?? order[at - 1];
    order.splice(at, 1);
    if (cover === itemId) cover = null;
    render();
    if (nextId) rows.get(nextId)?.li.querySelector('.al-ed-remove')?.focus();
    else nameInput.focus();
    clearTimeout(saveTimer);
    saveTimer = null;
    orderDirty = false;
    order = mergedOrder();
    try {
      await vault.updateList(id, { itemIds: order, cover });
    } catch (e) {
      report(e);
      return;
    }
    namedToast(vault, `Removed ${info ? `“${info.name}”` : 'the item'} from the album.`, {
      timeout: 6000,
      action: {
        label: 'Undo',
        onClick: async () => {
          // Puts it back into the album as it is NOW (it may have changed since, also after the editor closed).
          if (!gone) await flushOrder();
          const cur = listOr(vault, id);
          if (!cur || cur.itemIds.includes(itemId) || !itemOr(vault, itemId)) return;
          const ids = [...cur.itemIds];
          ids.splice(Math.min(at, ids.length), 0, itemId);
          try {
            await vault.updateList(id, { itemIds: ids });
          } catch (e) {
            report(e);
          }
        },
      },
    });
  }

  async function del() {
    if (asking) return; // a double click asks once
    asking = true;
    let ok = false;
    const l = listOr(vault, id);
    try {
      await flushOrder();
      ok = Boolean(l) && (await confirmDeleteAlbum(l));
    } finally {
      asking = false;
    }
    if (!ok || gone) return;
    // Close first: the sheet's history entry goes before the album route is left.
    deleting = true;
    sh.close();
    await removeAlbum(vault, id, l.name);
  }

  // ── drag to reorder (pointer events; the dragged row stays in the DOM, its neighbours move)
  listEl.addEventListener('pointerdown', (e) => {
    const handle = e.target instanceof Element ? e.target.closest('.al-ed-handle') : null;
    if (!handle || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const li = handle.closest('.al-ed-row');
    if (!li) return;
    e.preventDefault();
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // capture is a nicety
    }
    dragging = { li, handle, pointerId: e.pointerId, from: order.indexOf(li.dataset.id), lastY: e.clientY };
    li.classList.add('al-dragging');
    listEl.classList.add('al-ed-sorting');
  });
  listEl.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragging.pointerId) return;
    e.preventDefault();
    const y = e.clientY;
    dragging.lastY = y;
    const { li } = dragging;
    const mid = (el) => {
      const b = el.getBoundingClientRect();
      return b.top + b.height / 2;
    };
    let prev = li.previousElementSibling;
    while (prev && y < mid(prev)) {
      listEl.insertBefore(prev, li.nextElementSibling);
      prev = li.previousElementSibling;
    }
    let next = li.nextElementSibling;
    while (next && y > mid(next)) {
      listEl.insertBefore(next, li);
      next = li.nextElementSibling;
    }
    // Scroll the sheet near its edges.
    const scroller = sh.body;
    const box = scroller.getBoundingClientRect();
    if (y < box.top + 48) scroller.scrollTop -= 14;
    else if (y > box.bottom - 48) scroller.scrollTop += 14;
  });
  const endDrag = (e) => {
    if (!dragging || (e && e.pointerId !== dragging.pointerId)) return;
    const { li, from } = dragging;
    dragging = null;
    li.classList.remove('al-dragging');
    listEl.classList.remove('al-ed-sorting');
    const shown = [...listEl.children].map((x) => x.dataset.id).filter(Boolean);
    const to = shown.indexOf(li.dataset.id);
    const head = new Set(order.slice(0, shown.length));
    if (to !== from && shown.length <= order.length && shown.every((x) => head.has(x))) {
      order = [...shown, ...order.slice(shown.length)];
      paint();
      announce(`Moved to position ${to + 1} of ${order.length}`);
      scheduleOrder();
    } else if (!orderDirty) {
      onLists(); // changes that arrived during the drag
    }
  };
  listEl.addEventListener('pointerup', endDrag);
  listEl.addEventListener('pointercancel', endDrag);
  listEl.addEventListener('lostpointercapture', endDrag);

  // ── live updates
  const onLists = () => {
    if (dragging || orderDirty) return;
    const l = listOr(vault, id);
    if (!l) {
      gone = true;
      sh.close();
      return;
    }
    name = l.name;
    if (globalThis.document?.activeElement !== nameInput) nameInput.value = name;
    if (titleEl) titleEl.textContent = name;
    order = [...l.itemIds];
    known = new Set(l.itemIds);
    cover = l.cover ?? null;
    render();
  };
  const onItems = (e) => {
    const removed = e?.detail?.removed ?? [];
    const updated = e?.detail?.updated ?? [];
    for (const x of [...removed, ...updated]) rows.delete(x);
    if (removed.length) {
      const dropped = new Set(removed); // deleting thousands of items fires one event
      order = order.filter((x) => !dropped.has(x));
    }
    if (!dragging) render();
  };
  vault.addEventListener('lists', onLists);
  vault.addEventListener('items', onItems);
  // A lock closes the sheet after the keys are gone: save what is pending while they still exist.
  const onLocking = () => saveNow();
  vault.addEventListener('locking', onLocking);

  function cleanup() {
    saveNow();
    gone = true;
    io?.disconnect();
    moreIo?.disconnect();
    vault.removeEventListener('lists', onLists);
    vault.removeEventListener('items', onItems);
    vault.removeEventListener('locking', onLocking);
    rows.clear();
    listEl.replaceChildren();
    releaseThumbs(vault, used);
  }

  render();
  return sh;
}

// ───────── add to album

/**
 * Picks an album (or makes a new one) for the given items. -> the album id, or null when cancelled.
 * @param {{vault: object, itemIds: string[]}} opts
 * @returns {Promise<string|null>}
 */
export async function addToAlbumDialog({ vault, itemIds } = {}) {
  const ids = [...new Set(Array.isArray(itemIds) ? itemIds : [])].filter((x) => itemOr(vault, x));
  if (!ids.length) return null;
  const lists = listsOr(vault);
  const used = thumbRefs();
  const io = lazyObserver(); // the list scrolls: covers load as they come into view
  let p = null;
  let focusSet = false;
  const choose = (value) => p?.close(value);

  const options = lists.map((l) => {
    const has = new Set(l.itemIds); // a selection can hold thousands of items
    const all = ids.every((x) => has.has(x));
    const cover = albumCover(vault, l);
    const lead = cover ? null : firstItem(vault, l);
    const first = !all && !focusSet;
    if (first) focusSet = true;
    return h('li', null, h('button', {
      type: 'button',
      class: 'al-pick',
      dataset: { id: l.id, autofocus: first ? '' : undefined },
      disabled: all,
      on: { click: () => choose({ id: l.id }) },
    },
    cover ? thumbBox(vault, cover, { className: 'al-pick-thumb', decorative: true, used, observer: io })
      : lead ? h('span', { class: 'al-thumb al-pick-thumb', dataset: { kind: lead.kind } }, kindIcon(lead.kind))
        : h('span', { class: 'al-thumb al-pick-thumb' }, icon('album')),
    h('span', { class: 'al-pick-meta' },
      h('span', { class: 'al-pick-name', text: l.name }),
      h('span', { class: 'al-pick-sub', text: all ? `Already in this album` : plural(l.itemIds.length, 'item') })),
    all ? h('span', { class: 'al-pick-check' }, icon('check')) : null));
  });

  const newId = `al-new-${Math.random().toString(36).slice(2, 8)}`;
  const newInput = h('input', { class: 'input', id: newId, type: 'text', placeholder: 'Album name', maxLength: 200, autocomplete: 'off', spellcheck: false, dataset: { autofocus: focusSet ? undefined : '' } });
  const createBtn = h('button', { type: 'button', class: 'btn btn-primary al-new-create', disabled: true, on: { click: () => choose({ name: newInput.value }) } }, icon('plus'), h('span', { text: 'Create' }));
  newInput.addEventListener('input', () => {
    createBtn.disabled = !newInput.value.trim();
  });
  newInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      if (newInput.value.trim()) choose({ name: newInput.value });
    }
  });

  const body = h('div', { class: 'al-add' },
    h('p', { class: 'al-add-lead', text: `${plural(ids.length, 'item')} selected` }),
    lists.length ? h('ul', { class: 'al-pick-list', aria: { label: 'Albums' } }, options) : null,
    h('div', { class: 'field al-new' },
      h('label', { class: 'label', for: newId, text: lists.length ? 'Or a new album' : 'New album' }),
      h('div', { class: 'al-new-row' }, newInput, createBtn)));

  p = modal({ title: 'Add to album', body, className: 'al-add-modal', actions: [{ label: 'Cancel', kind: 'ghost', value: null }] });
  const picked = await p;
  io?.disconnect();
  releaseThumbs(vault, used);
  if (!picked || typeof picked !== 'object') return null;
  try {
    if (picked.id) {
      const l = listOr(vault, picked.id);
      if (!l) {
        toast('That album is gone.', { kind: 'warn' });
        return null;
      }
      const has = new Set(l.itemIds);
      const merged = [...l.itemIds, ...ids.filter((x) => !has.has(x))];
      const added = merged.length - l.itemIds.length;
      const r = await vault.updateList(picked.id, { itemIds: merged });
      namedToast(vault, added ? `Added ${plural(added, 'item')} to “${r.name}”.` : `Already in “${r.name}”.`, { kind: 'ok' });
      return picked.id;
    }
    const l = await vault.createList({ name: String(picked.name ?? '').trim() || 'Album', itemIds: ids });
    namedToast(vault, `Album “${l.name}” created with ${plural(l.itemIds.length, 'item')}.`, { kind: 'ok' });
    return l.id;
  } catch (e) {
    report(e);
    return null;
  }
}
