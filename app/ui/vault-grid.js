// Vault grid/list of items (DESIGN §1.5, §10, §12). Owner: V1a.
// Cards render from the decrypted index at once (name, size, date, kind badge, ★, duration); thumbnails are decrypted
// lazily: an IntersectionObserver (rootMargin one viewport) queues visible cards, at most THUMB_JOBS in flight, and a
// card's thumbnail URL is handed back with vault.releaseThumb(id) when the card leaves the DOM (the vault revokes all
// of them on lock). Cards use content-visibility:auto (vault.css). One DOM serves both layouts (data-view grid|list).
// Keyboard: arrow keys move between cards (roving tabindex), Home/End, Enter opens, Space selects in select mode;
// the context-menu key / right click opens the card menu. Long-press (touch) starts select mode.
// Node-importable: the DOM is only touched inside functions.

import { h, icon } from '../util/dom.js';
import { extOf, fmtDate, fmtDuration, fmtSize, safeFilename } from '../util/format.js';
import { kindIcon, menu } from './components.js';

/** Filter chips (DESIGN §1.5). 'doc' also lists files of no particular kind, so every item has a chip. */
export const FILTERS = Object.freeze([
  { value: 'all', label: 'All' },
  { value: 'fav', label: '★', aria: 'Favorites' },
  { value: 'image', label: 'Photos' },
  { value: 'video', label: 'Videos' },
  { value: 'audio', label: 'Music' },
  { value: 'doc', label: 'Docs' },
  { value: 'note', label: 'Notes' },
]);

/** Sort orders (settings.vaultSort). */
export const SORTS = Object.freeze([
  { value: 'new', label: 'Newest' },
  { value: 'old', label: 'Oldest' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
]);

export const KIND_LABEL = Object.freeze({ image: 'Photo', video: 'Video', audio: 'Music', doc: 'Doc', note: 'Note', other: 'File' });

const THUMB_JOBS = 8;
const LONG_PRESS_MS = 480;
const MOVE_SLOP = 10;

let collator = null;
function compareNames(a, b) {
  try {
    collator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return collator.compare(a, b);
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const SORTERS = {
  new: (a, b) => b.addedAt - a.addedAt || byId(a, b),
  old: (a, b) => a.addedAt - b.addedAt || byId(a, b),
  name: (a, b) => compareNames(a.name, b.name) || byId(a, b),
  size: (a, b) => b.size - a.size || byId(a, b),
};

/**
 * A label (note title, album name) for display: control and direction characters dropped, ≤ 200 characters. The vault
 * cleans labels the same way when it reads its index; this is the belt to that pair of braces.
 * @param {string} s
 * @returns {string}
 */
export function labelText(s) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, '').trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

/**
 * The name shown for an item: file names through safeFilename, a note's title as a label (so "To do: Monday?" is not
 * shown as "To do_ Monday_").
 * @param {{name: string, kind?: string}} info
 * @returns {string}
 */
export function displayName(info) {
  return (info?.kind === 'note' && labelText(info.name)) || safeFilename(info?.name);
}

/** Lower-cased NFC text for search matching. */
export function searchKey(s) {
  return String(s ?? '').normalize('NFC').toLowerCase().trim();
}

/** Does an ItemInfo match a filter chip value? */
export function matchesKind(info, kind) {
  if (!kind || kind === 'all') return true;
  if (kind === 'fav') return info.fav === true;
  if (kind === 'doc') return info.kind === 'doc' || info.kind === 'other';
  return info.kind === kind;
}

/**
 * The items a filter shows, in display order. spec: {kind, query, sort, albumId}. Album mode keeps the album's
 * order (sort ignored). isHidden(id) hides items (pending deletes). A missing album yields [].
 * @param {{items(): object[], item(id: string): object, list(id: string): {itemIds: string[]}}} vault
 * @param {{kind?: string, query?: string, sort?: string, albumId?: string|null}} spec
 * @param {{isHidden?: (id: string) => boolean}} [opts]
 * @returns {import('../types.js').ItemInfo[]}
 */
export function visibleItems(vault, spec = {}, { isHidden } = {}) {
  let list;
  if (spec.albumId) {
    let l;
    try {
      l = vault.list(spec.albumId);
    } catch {
      return [];
    }
    const all = new Map(vault.items().map((i) => [i.id, i]));
    list = l.itemIds.map((id) => all.get(id)).filter(Boolean);
  } else {
    list = vault.items();
    list.sort(SORTERS[spec.sort] ?? SORTERS.new);
  }
  const q = searchKey(spec.query);
  return list.filter((i) => (!isHidden || !isHidden(i.id)) && matchesKind(i, spec.kind) && (!q || searchKey(i.name).includes(q)));
}

let dateFmt = null;
let dayFmt = null;
/**
 * fmtDate's format with shared Intl.DateTimeFormats (building one per card is slow for big vaults); dates of the
 * current year leave the year out, so the line fits narrow cards.
 */
function shortDate(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  try {
    const d = new Date(ms);
    if (d.getFullYear() === new Date(now).getFullYear()) {
      dayFmt ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
      return dayFmt.format(d);
    }
    dateFmt ??= new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    return dateFmt.format(d);
  } catch {
    return fmtDate(ms);
  }
}

/** "12 MB · Oct 1" / "12 MB · Mar 3, 2024" (mtime when known, else the date it was added; the year when not this one). */
export function metaLine(info, now = Date.now()) {
  const date = shortDate(Number.isFinite(info.mtime) ? info.mtime : info.addedAt, now);
  return [fmtSize(info.size), date].filter(Boolean).join(' · ');
}

// Icons are cloned from one built copy per id: building each <use> checks its URL, which adds up over thousands of cards.
const iconCache = new Map();
function iconOf(id) {
  let el = iconCache.get(id);
  if (!el) iconCache.set(id, (el = icon(id)));
  return el.cloneNode(true);
}
function kindIconOf(kind) {
  const key = `kind:${kind}`;
  let el = iconCache.get(key);
  if (!el) iconCache.set(key, (el = kindIcon(kind)));
  return el.cloneNode(true);
}

/**
 * The vault grid/list.
 * filter: the spec object (read at every update) or a function returning it: {kind, query, sort, view, albumId}.
 * onOpen(id) opens an item; onSelect(ids) reports the selection (select mode). Extra options (closest compatible
 * with §10): menuItems(info) → items for the card menu (components.menu), isHidden(id) (pending deletes),
 * renderEmpty(spec, total) → element shown when nothing matches.
 * @param {{vault: object, filter: object|(() => object), onOpen?: (id: string) => void, onSelect?: (ids: string[]) => void,
 *   menuItems?: (info: object) => Array<object>, isHidden?: (id: string) => boolean, renderEmpty?: (spec: object, total: number) => Node}} opts
 * @returns {{el: HTMLElement, update(): void, destroy(): void, items(): object[], setSelecting(on: boolean): void,
 *   readonly selecting: boolean, selected(): string[], select(ids: string[]): void, clearSelection(): void, focusItem(id: string): boolean}}
 */
export function grid({ vault, filter, onOpen, onSelect, menuItems, isHidden, renderEmpty } = {}) {
  const spec = () => (typeof filter === 'function' ? filter() : filter) ?? {};
  /** id → card record {id, info, el, open, thumb, img, more, offMenu, thumbState, visible} */
  const cards = new Map();
  const list = h('div', { class: 'vv-items', role: 'list', aria: { label: 'Vault items' } });
  const empty = h('div', { class: 'vv-empty', hidden: true });
  const el = h('div', { class: 'vv-grid' }, list, empty);
  let shown = [];
  let selecting = false;
  const selection = new Set();
  let activeId = null; // the card that holds tabIndex 0 (roving focus)
  let destroyed = false;

  // ───────── lazy thumbnails

  const queue = [];
  let inflight = 0;
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(onIntersect, { rootMargin: `${Math.max(200, Math.round(globalThis.innerHeight || 800))}px 0px` })
    : null;

  function onIntersect(entries) {
    for (const e of entries) {
      const c = cardOf(e.target);
      if (!c) continue;
      c.visible = e.isIntersecting;
      if (c.visible) want(c);
    }
    pump();
  }

  function cardOf(node) {
    const id = node?.dataset?.id;
    const c = id ? cards.get(id) : null;
    return c && c.el === node ? c : null;
  }

  function want(c) {
    if (c.info.hasThumb && c.thumbState === 'none') {
      c.thumbState = 'queued';
      queue.push(c);
    }
  }

  function pump() {
    while (!destroyed && inflight < THUMB_JOBS && queue.length) {
      const c = queue.shift();
      if (c.thumbState !== 'queued') continue;
      if (!c.el.isConnected || cards.get(c.id) !== c) {
        c.thumbState = 'none';
        continue;
      }
      if (!c.visible) {
        c.thumbState = 'none'; // re-queued when it scrolls near the viewport again
        continue;
      }
      c.thumbState = 'loading';
      inflight++;
      Promise.resolve()
        .then(() => vault.thumbUrl(c.id))
        .then((url) => {
          if (destroyed || cards.get(c.id) !== c || !c.el.isConnected) {
            if (url) vault.releaseThumb?.(c.id);
            return;
          }
          if (!url) {
            c.thumbState = 'failed';
            return;
          }
          showThumb(c, url);
        }, () => {
          if (cards.get(c.id) === c) c.thumbState = 'failed';
        })
        .finally(() => {
          inflight--;
          pump();
        });
    }
  }

  function showThumb(c, url) {
    const img = h('img', { class: 'vv-img', alt: displayName(c.info), decoding: 'async', draggable: false, src: url });
    img.addEventListener('load', () => c.thumb.classList.add('has-img'), { once: true });
    img.addEventListener('error', () => {
      img.remove();
      if (c.img !== img) return;
      c.img = null;
      if (c.thumbState === 'loaded') vault.releaseThumb?.(c.id);
      // Its URL can be revoked under it (another view released the same thumbnail): decrypt it once more.
      c.thumbState = c.retried ? 'failed' : 'none';
      c.retried = true;
      if (c.thumbState === 'none' && c.visible) {
        want(c);
        pump();
      }
    }, { once: true });
    c.img?.remove();
    c.img = img;
    c.thumbState = 'loaded';
    c.thumb.prepend(img);
  }

  function dropThumb(c) {
    if (c.thumbState === 'loaded' || c.thumbState === 'loading') vault.releaseThumb?.(c.id);
    c.img?.removeAttribute('src');
    c.img?.remove();
    c.img = null;
    c.thumb.classList.remove('has-img');
    c.thumbState = 'none';
  }

  // ───────── cards

  function createCard(info) {
    const c = { id: info.id, info, thumbState: 'none', visible: false, img: null, sig: '' };
    c.check = h('span', { class: 'vv-tick', aria: { hidden: 'true' } }, iconOf('check'));
    c.kindBadge = h('span', { class: 'vv-kind' });
    c.fav = h('span', { class: 'vv-fav', title: 'Favorite' }, iconOf('star-filled'));
    c.dur = h('span', { class: 'vv-dur' });
    c.ph = h('div', { class: 'vv-ph', aria: { hidden: 'true' } });
    c.thumb = h('div', { class: 'vv-thumb' }, c.ph, c.check, h('div', { class: 'vv-badges' }, c.kindBadge), c.fav, c.dur);
    c.name = h('span', { class: 'vv-name' });
    c.favInline = h('span', { class: 'vv-fav-inline', aria: { hidden: 'true' } }, iconOf('star-filled'));
    c.meta = h('span', { class: 'vv-meta' });
    c.open = h('button', {
      type: 'button',
      class: 'vv-open',
      tabIndex: -1,
      on: {
        click: (e) => {
          if (c.suppressClick) {
            c.suppressClick = false;
            e.preventDefault();
            return;
          }
          if (selecting) toggle(c.id);
          else onOpen?.(c.id);
        },
        keydown: (e) => onCardKey(e, c),
        focus: () => setActive(c.id),
      },
    }, c.thumb, h('span', { class: 'vv-body' }, h('span', { class: 'vv-nameline' }, c.name, c.favInline), c.meta));
    c.more = h('button', { type: 'button', class: 'btn-icon vv-more', tabIndex: -1, on: { focus: () => setActive(c.id) } }, iconOf('more'));
    c.offMenu = menuItems ? menu(c.more, () => menuItems(c.info)) : null;
    if (!menuItems) c.more.hidden = true;
    c.el = h('div', { class: 'vv-card', role: 'listitem', dataset: { id: info.id } }, c.open, c.more);
    c.el.addEventListener('contextmenu', (e) => {
      if (selecting || !menuItems) return;
      e.preventDefault();
      if (c.longPressed) return; // the long press started select mode instead
      c.more.click();
    });
    addLongPress(c);
    paintCard(c, info);
    cards.set(info.id, c);
    io?.observe(c.el);
    if (!io) {
      c.visible = true;
      want(c);
    }
    return c;
  }

  function paintCard(c, info) {
    const sig = [info.name, info.kind, info.size, info.mtime, info.addedAt, info.fav, info.hasThumb, info.duration].join('|');
    const hadThumb = c.info.hasThumb;
    c.info = info;
    if (sig !== c.sig) {
      c.sig = sig;
      const name = displayName(info);
      const kind = Object.hasOwn(KIND_LABEL, info.kind) ? info.kind : 'other';
      c.el.dataset.kind = kind;
      c.name.textContent = name;
      c.name.title = name;
      c.metaText = metaLine(info);
      c.meta.textContent = c.metaText;
      c.kindBadge.textContent = KIND_LABEL[kind];
      c.kindBadge.className = `vv-kind vv-kind-${kind}`;
      const ext = extOf(info.name);
      c.ph.replaceChildren(...[kindIconOf(kind), ext && kind !== 'note' ? h('span', { class: 'vv-ext', text: ext.slice(0, 5) }) : null].filter(Boolean));
      c.fav.hidden = info.fav !== true;
      c.favInline.hidden = info.fav !== true;
      const d = (kind === 'video' || kind === 'audio') && Number.isFinite(info.duration) ? fmtDuration(info.duration) : '';
      c.dur.textContent = d;
      c.dur.hidden = !d;
      c.more.setAttribute('aria-label', `More actions for ${name}`);
      c.more.title = 'More actions';
      if (hadThumb !== info.hasThumb) {
        dropThumb(c);
        if (c.visible) want(c);
      }
    }
    paintSelected(c);
  }

  function paintSelected(c) {
    const on = selection.has(c.id);
    c.el.classList.toggle('is-selected', on);
    if (selecting) c.open.setAttribute('aria-pressed', String(on));
    else c.open.removeAttribute('aria-pressed');
    c.open.setAttribute('aria-label', `${displayName(c.info)}, ${KIND_LABEL[c.info.kind] ?? 'File'}, ${c.metaText}${c.info.fav ? ', favorite' : ''}`);
  }

  function removeCard(c) {
    cards.delete(c.id);
    io?.unobserve(c.el);
    c.offMenu?.();
    dropThumb(c);
    c.el.remove();
    if (selection.delete(c.id)) emitSelect();
    if (activeId === c.id) activeId = null;
  }

  function addLongPress(c) {
    let timer = null;
    let start = null;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
      start = null;
    };
    c.el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      c.longPressed = false;
      c.suppressClick = false; // a long press whose click never came (scrolled away) must not eat this tap
      start = { x: e.clientX, y: e.clientY };
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        c.longPressed = true;
        c.suppressClick = true;
        if (!selecting) setSelecting(true);
        if (!selection.has(c.id)) toggle(c.id);
        globalThis.navigator?.vibrate?.(12);
      }, LONG_PRESS_MS);
    });
    c.el.addEventListener('pointermove', (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_SLOP) cancel();
    });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) c.el.addEventListener(t, cancel);
  }

  // ───────── selection

  function emitSelect() {
    try {
      onSelect?.([...selection]);
    } catch (e) {
      globalThis.console?.error?.(e);
    }
  }

  function toggle(id) {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
    const c = cards.get(id);
    if (c) paintSelected(c);
    emitSelect();
  }

  function setSelecting(on) {
    const v = Boolean(on);
    if (v === selecting) return;
    selecting = v;
    el.classList.toggle('is-selecting', v);
    if (!v) selection.clear();
    for (const c of cards.values()) paintSelected(c);
    emitSelect();
  }

  // ───────── keyboard

  /** One tab stop for the whole grid: the active card (and its menu button). */
  function setActive(id) {
    if (activeId === id) return;
    const prev = activeId ? cards.get(activeId) : null;
    if (prev) {
      prev.open.tabIndex = -1;
      prev.more.tabIndex = -1;
    }
    activeId = id;
    const c = cards.get(id);
    if (c) {
      c.open.tabIndex = 0;
      c.more.tabIndex = 0;
    }
  }

  function ensureActive() {
    if (activeId && cards.has(activeId) && shown.some((i) => i.id === activeId)) {
      cards.get(activeId).open.tabIndex = 0;
      cards.get(activeId).more.tabIndex = 0;
      return;
    }
    activeId = null;
    if (shown.length) setActive(shown[0].id);
  }

  function focusCard(id) {
    const c = cards.get(id);
    if (!c) return false;
    setActive(id);
    c.open.focus();
    c.el.scrollIntoView?.({ block: 'nearest' });
    return true;
  }

  /** The card in the row above/below with the closest horizontal centre. */
  function vertical(c, dir) {
    const ids = shown.map((i) => i.id);
    const i = ids.indexOf(c.id);
    if (spec().view === 'list') return ids[i + dir] ?? null;
    const r = c.el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    let rowTop = null;
    let best = null;
    let bestDx = Infinity;
    for (let k = i + dir; k >= 0 && k < ids.length; k += dir) {
      const rr = cards.get(ids[k])?.el.getBoundingClientRect();
      if (!rr) continue;
      const sameRow = Math.abs(rr.top - r.top) < 4;
      if (sameRow) continue;
      if (rowTop === null) rowTop = rr.top;
      else if (Math.abs(rr.top - rowTop) >= 4) break;
      const dx = Math.abs(rr.left + rr.width / 2 - cx);
      if (dx < bestDx) {
        bestDx = dx;
        best = ids[k];
      }
    }
    return best;
  }

  function onCardKey(e, c) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const ids = shown.map((i) => i.id);
    const i = ids.indexOf(c.id);
    let target = null;
    switch (e.key) {
      case 'ArrowRight':
        target = ids[i + 1];
        break;
      case 'ArrowLeft':
        target = ids[i - 1];
        break;
      case 'ArrowDown':
        target = vertical(c, 1);
        break;
      case 'ArrowUp':
        target = vertical(c, -1);
        break;
      case 'Home':
        target = ids[0];
        break;
      case 'End':
        target = ids.at(-1);
        break;
      case 'Enter':
        e.preventDefault();
        if (selecting) toggle(c.id);
        else onOpen?.(c.id);
        return;
      case ' ':
        if (selecting) {
          e.preventDefault();
          toggle(c.id);
        }
        return;
      case 'ContextMenu':
        if (menuItems && !selecting) {
          e.preventDefault();
          c.more.click();
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    if (target) focusCard(target);
  }

  // ───────── render

  function update() {
    if (destroyed) return;
    const s = spec();
    let next;
    try {
      next = visibleItems(vault, s, { isHidden });
    } catch {
      next = []; // locked meanwhile: the view replaces the grid
    }
    list.dataset.view = s.view === 'list' ? 'list' : 'grid';
    const keep = new Set(next.map((i) => i.id));
    // The focused card is going away (deleted from its menu, filtered out): focus moves to its neighbour.
    const focused = globalThis.document?.activeElement;
    let refocus = -1;
    for (const c of [...cards.values()]) {
      if (keep.has(c.id)) continue;
      if (focused && c.el.contains(focused)) refocus = shown.findIndex((i) => i.id === c.id);
      removeCard(c);
    }
    const els = next.map((info) => {
      const c = cards.get(info.id);
      if (c) {
        paintCard(c, info);
        return c.el;
      }
      return createCard(info).el;
    });
    // Move only what changed place (a new item at the top inserts one node instead of re-appending them all).
    let at = list.firstElementChild;
    for (const node of els) {
      if (at === node) at = at.nextElementSibling;
      else list.insertBefore(node, at);
    }
    shown = next;
    list.hidden = next.length === 0;
    empty.hidden = next.length > 0;
    if (!next.length) {
      let total = 0;
      try {
        total = vault.items().filter((i) => !isHidden?.(i.id)).length;
      } catch {
        total = 0;
      }
      empty.replaceChildren(renderEmpty ? renderEmpty(s, total) : h('p', { class: 'muted', text: 'Nothing here.' }));
    } else if (!empty.hidden || empty.firstChild) {
      empty.replaceChildren();
    }
    ensureActive();
    if (refocus >= 0 && next.length) focusCard(next[Math.min(refocus, next.length - 1)].id);
    pump();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    io?.disconnect();
    queue.length = 0;
    for (const c of [...cards.values()]) removeCard(c);
    selection.clear();
    list.replaceChildren();
    empty.replaceChildren();
    el.remove();
  }

  update();

  return {
    el,
    update,
    destroy,
    /** The ItemInfos currently shown, in order. */
    items: () => shown.slice(),
    setSelecting,
    get selecting() {
      return selecting;
    },
    selected: () => [...selection].filter((id) => cards.has(id)),
    /** Replaces the selection (select mode only). */
    select(ids) {
      selection.clear();
      for (const id of ids) if (cards.has(id)) selection.add(id);
      for (const c of cards.values()) paintSelected(c);
      emitSelect();
    },
    clearSelection() {
      selection.clear();
      for (const c of cards.values()) paintSelected(c);
      emitSelect();
    },
    focusItem: (id) => focusCard(id),
  };
}
