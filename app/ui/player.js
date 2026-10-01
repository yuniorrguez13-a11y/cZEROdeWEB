// Persistent audio/video player dock (DESIGN §1.5 Player, §1.6): mounted once into #player-dock by the shell and
// kept across route changes. Queue from an album or "Play all music"; prev/next, shuffle, repeat off/all/one,
// auto-advance; the current track is decrypted (streamed where possible, media.attachMedia) and the next one
// prefetched; Media Session metadata + play/pause/previoustrack/nexttrack/seekto handlers. Owner: F.
// Playing media (the player's and the viewer's, see trackMedia) is autolock activity: isPlaying() and state
// 'player' {playing}. A lock (state.onPurge) stops everything and clears the queue.
// Node-importable: the DOM is only touched inside functions.

import { h, icon, toast } from '../util/dom.js';
import * as state from '../state.js';
import { fmtDuration, kindOf, safeFilename } from '../util/format.js';
import { isCancel, userMessage } from '../errors.js';
import { attachMedia, detachMedia, disposeSource, prefetch } from '../media/media.js';

const REPEAT_NEXT = { off: 'all', all: 'one', one: 'off' };
const REPEAT_LABEL = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: this track' };
/** prev() restarts the track instead when it has played this long (s). */
const RESTART_AFTER = 3;

// ───────── playing-media registry (player + viewer): autolock activity, one source at a time

const tracked = new Map(); // element → off()
const playing = new Set();
/** The queue moves on by itself (ended → next track / repeat one): still "media playing" until it plays again. */
let advancing = false;
let advanceTimer = null;
/** A transition that never starts playing stops counting as activity after this long. */
const ADVANCE_MAX_MS = 30000;

function publish() {
  const now = playing.size > 0 || advancing;
  const old = state.get('player');
  if (!old || old.playing !== now) state.set('player', { playing: now });
}

/**
 * Counts an <audio>/<video> as "media playing" (autolock activity, state 'player') while it plays, and pauses the
 * other tracked elements when it starts. Extra over §10 (the viewer registers its media elements).
 * @param {HTMLMediaElement} el
 * @returns {() => void} off
 */
export function trackMedia(el) {
  if (!el || tracked.has(el)) return tracked.get(el) ?? (() => {});
  const onPlay = () => {
    for (const other of tracked.keys()) if (other !== el && !other.paused) other.pause();
    playing.add(el);
    publish();
  };
  const onStop = (e) => {
    // At the end of a track 'pause' comes right before 'ended': the 'ended' listeners (the player's auto-advance,
    // registered first) decide whether playback really stopped.
    if (e?.type === 'pause' && el.ended) return;
    playing.delete(el);
    publish();
  };
  const events = [['play', onPlay], ['playing', onPlay], ['pause', onStop], ['ended', onStop], ['emptied', onStop], ['error', onStop]];
  for (const [t, fn] of events) el.addEventListener(t, fn);
  const off = () => {
    for (const [t, fn] of events) el.removeEventListener(t, fn);
    tracked.delete(el);
    onStop();
  };
  tracked.set(el, off);
  return off;
}

/**
 * True while any tracked audio/video plays (the player's or the viewer's): autolock activity (DESIGN §1.6).
 * @returns {boolean}
 */
export function isPlaying() {
  return playing.size > 0 || advancing;
}

function startAdvance() {
  advancing = true;
  clearTimeout(advanceTimer);
  advanceTimer = setTimeout(endAdvance, ADVANCE_MAX_MS);
  publish();
}

function endAdvance() {
  clearTimeout(advanceTimer);
  advanceTimer = null;
  if (!advancing) return;
  advancing = false;
  publish();
}

// ───────── player state

let ui = null; // built by mountPlayer
let queue = []; // ViewerItem[] (audio/video only)
let order = []; // play order: indices into queue
let pos = -1; // position in order
let repeat = 'off';
let shuffled = false;
let title = '';
let failed = new Set(); // queue indices that could not be played
let current = null; // {index, src, handle, el, ctl}
let upcoming = null; // {index, src} prefetched next track
let prepareSeq = 0; // the newest next-track prepare; older ones dispose what they get
let loadSeq = 0;
let seeking = false;
let lastPosition = 0;

const playable = (item) => {
  const k = kindOf(item?.type, item?.name);
  return k === 'audio' || k === 'video';
};

function identity(n) {
  return Array.from({ length: n }, (_, i) => i);
}

/** Fisher–Yates over `list` (a copy). */
function shuffledCopy(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextPos(from, { wrap = repeat === 'all' } = {}) {
  if (!order.length) return -1;
  for (let step = 1; step <= order.length; step++) {
    let p = from + step;
    if (p >= order.length) {
      if (!wrap) return -1;
      p %= order.length;
    }
    if (!failed.has(order[p])) return p;
  }
  return -1;
}

function prevPos(from) {
  if (!order.length) return -1;
  for (let step = 1; step <= order.length; step++) {
    let p = from - step;
    if (p < 0) {
      if (repeat !== 'all') return -1;
      p = (p + order.length) % order.length;
    }
    if (!failed.has(order[p])) return p;
  }
  return -1;
}

const media = () => current?.el ?? null;

// ───────── DOM

function iconButton(id, label, onClick, extra = {}) {
  return h('button', { type: 'button', class: ['pl-btn', extra.class], title: label, aria: { label, ...(extra.aria ?? {}) }, on: { click: onClick } }, icon(id));
}

/**
 * Builds the dock UI into the shell's #player-dock (hidden while nothing is queued). Call once.
 * @param {HTMLElement} dock
 */
export function mountPlayer(dock) {
  if (ui) {
    if (dock && ui.root.parentNode !== dock) dock.append(ui.root);
    return;
  }
  const audio = h('audio', { class: 'pl-audio', preload: 'metadata' });
  const video = h('video', { class: 'pl-video', preload: 'metadata', playsInline: true, attrs: { controlslist: 'nodownload noremoteplayback', disableremoteplayback: true } });
  const artIcon = h('span', { class: 'pl-art-icon' }, icon('music'));
  const art = h('div', { class: 'pl-art' }, artIcon, video);
  const name = h('div', { class: 'pl-name' });
  const sub = h('div', { class: 'pl-sub' });
  const playBtn = iconButton('play', 'Play', () => togglePlay(), { class: 'pl-play' });
  const prevBtn = iconButton('prev', 'Previous track', () => prev());
  const nextBtn = iconButton('next', 'Next track', () => next());
  const shuffleBtn = iconButton('shuffle', 'Shuffle', () => setShuffle(!shuffled), { class: 'pl-toggle', aria: { pressed: 'false' } });
  const repeatBtn = iconButton('repeat', REPEAT_LABEL.off, () => setRepeat(REPEAT_NEXT[repeat]), { class: 'pl-toggle', aria: { pressed: 'false' } });
  const expandBtn = iconButton('zoom', 'Bigger video', () => toggleExpanded(), { class: 'pl-expand', aria: { pressed: 'false' } });
  const queueBtn = iconButton('list', 'Queue', () => toggleQueue(), { class: 'pl-toggle', aria: { pressed: 'false', expanded: 'false' } });
  const closeBtn = iconButton('close', 'Stop and close the player', () => stop());
  const cur = h('span', { class: 'pl-time', text: '0:00' });
  const dur = h('span', { class: 'pl-time pl-time-end', text: '0:00' });
  const range = h('input', {
    type: 'range',
    class: 'pl-range',
    min: 0,
    max: 1000,
    step: 1,
    value: 0,
    aria: { label: 'Seek' },
    on: {
      input: () => {
        seeking = true;
        const el = media();
        const d = el && Number.isFinite(el.duration) ? el.duration : 0;
        cur.textContent = fmtDuration((Number(range.value) / 1000) * d) || '0:00';
        paintRange();
      },
      change: () => {
        seeking = false;
        const el = media();
        if (el && Number.isFinite(el.duration)) el.currentTime = (Number(range.value) / 1000) * el.duration;
      },
    },
  });
  const list = h('ol', { class: 'pl-list' });
  const queueTitle = h('div', { class: 'pl-queue-title' });
  const queuePanel = h('div', { class: 'pl-queue', id: 'pl-queue', hidden: true },
    h('div', { class: 'pl-queue-head' }, queueTitle,
      h('div', { class: 'pl-queue-tools' },
        iconButton('shuffle', 'Shuffle', () => setShuffle(!shuffled), { class: 'pl-toggle pl-q-shuffle', aria: { pressed: 'false' } }),
        iconButton('repeat', REPEAT_LABEL.off, () => setRepeat(REPEAT_NEXT[repeat]), { class: 'pl-toggle pl-q-repeat', aria: { pressed: 'false' } }))),
    list);
  queueBtn.setAttribute('aria-controls', 'pl-queue');

  const bar = h('div', { class: 'pl-bar' },
    h('div', { class: 'pl-now' }, art, h('div', { class: 'pl-meta' }, name, sub)),
    h('div', { class: 'pl-center' },
      h('div', { class: 'pl-controls' }, shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn),
      h('div', { class: 'pl-seek' }, cur, range, dur)),
    h('div', { class: 'pl-side' }, expandBtn, queueBtn, closeBtn));
  const root = h('section', { class: 'pl-root', hidden: true, aria: { label: 'Player' } }, queuePanel, bar, audio);

  ui = { root, audio, video, art, artIcon, name, sub, playBtn, prevBtn, nextBtn, shuffleBtn, repeatBtn, expandBtn, queueBtn, cur, dur, range, list, queuePanel, queueTitle };
  for (const el of [audio, video]) {
    // Before trackMedia's own 'ended' handler: an auto-advance must not publish {playing:false} in between.
    el.addEventListener('ended', () => onEnded(el));
    trackMedia(el);
    el.addEventListener('playing', endAdvance);
    el.addEventListener('play', paintPlay);
    el.addEventListener('pause', paintPlay);
    el.addEventListener('timeupdate', () => paintTime(el));
    el.addEventListener('durationchange', () => paintTime(el));
    el.addEventListener('loadedmetadata', () => paintTime(el));
  }
  video.addEventListener('dblclick', () => video.requestFullscreen?.().catch(() => {}));
  dock?.append(root);
}

function paintRange() {
  ui.range.style.setProperty('--pl-pct', `${Number(ui.range.value) / 10}%`);
}

function paintTime(el) {
  if (!ui || el !== media()) return;
  const d = Number.isFinite(el.duration) ? el.duration : 0;
  ui.dur.textContent = fmtDuration(d) || '0:00';
  if (!seeking) {
    ui.cur.textContent = fmtDuration(el.currentTime) || '0:00';
    ui.range.value = String(d ? Math.round((el.currentTime / d) * 1000) : 0);
    paintRange();
  }
  const ms = globalThis.navigator?.mediaSession;
  const now = Date.now();
  if (ms && typeof ms.setPositionState === 'function' && d && now - lastPosition > 1000) {
    lastPosition = now;
    try {
      ms.setPositionState({ duration: d, playbackRate: el.playbackRate || 1, position: Math.min(el.currentTime, d) });
    } catch {
      // ignore
    }
  }
}

function paintPlay() {
  if (!ui) return;
  const el = media();
  const on = Boolean(el && !el.paused && !el.ended);
  ui.playBtn.replaceChildren(icon(on ? 'pause' : 'play'));
  ui.playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  ui.playBtn.title = on ? 'Pause' : 'Play';
  ui.root.classList.toggle('pl-on', on);
  const ms = globalThis.navigator?.mediaSession;
  if (ms) ms.playbackState = el ? (on ? 'playing' : 'paused') : 'none';
}

function paintToggles() {
  if (!ui) return;
  for (const b of ui.root.querySelectorAll('.pl-btn[aria-label="Shuffle"]')) b.setAttribute('aria-pressed', String(shuffled));
  for (const b of [ui.repeatBtn, ui.root.querySelector('.pl-q-repeat')]) {
    if (!b) continue;
    b.setAttribute('aria-pressed', String(repeat !== 'off'));
    b.setAttribute('aria-label', REPEAT_LABEL[repeat]);
    b.title = REPEAT_LABEL[repeat];
    b.replaceChildren(icon(repeat === 'one' ? 'repeat-one' : 'repeat'));
  }
  ui.prevBtn.disabled = pos < 0 || (prevPos(pos) < 0 && !(media()?.currentTime > RESTART_AFTER));
  ui.nextBtn.disabled = nextPos(pos) < 0;
}

function paintNow() {
  if (!ui) return;
  const item = pos >= 0 ? queue[order[pos]] : null;
  ui.root.hidden = !item;
  if (!item) return;
  const isVideo = kindOf(item.type, item.name) === 'video';
  ui.name.textContent = safeFilename(item.name);
  ui.name.title = ui.name.textContent;
  ui.sub.textContent = [title, `${pos + 1} / ${order.length}`].filter(Boolean).join(' · ');
  ui.root.classList.toggle('pl-has-video', isVideo);
  ui.artIcon.replaceChildren(icon(isVideo ? 'video' : 'music'));
  ui.expandBtn.hidden = !isVideo;
  if (!isVideo) setExpanded(false);
  paintToggles();
  paintList();
}

function paintList() {
  if (!ui || ui.queuePanel.hidden) return;
  ui.queueTitle.textContent = title ? `Queue · ${title}` : 'Queue';
  const rows = order.map((qi, p) => {
    const item = queue[qi];
    const isCur = p === pos;
    const bad = failed.has(qi);
    return h('li', { class: ['pl-li', isCur ? 'pl-current' : null, bad ? 'pl-failed' : null] },
      h('button', {
        type: 'button',
        class: 'pl-row',
        disabled: bad,
        aria: { current: isCur ? 'true' : undefined, label: `${p + 1}. ${safeFilename(item.name)}${bad ? " — can't be played" : ''}` },
        on: { click: () => playAt(p) },
      },
      h('span', { class: 'pl-row-n', text: isCur ? '' : String(p + 1) }, isCur ? icon(media() && !media().paused ? 'play' : 'pause') : null),
      h('span', { class: 'pl-row-name', text: safeFilename(item.name) }),
      bad ? h('span', { class: 'pl-row-state' }, icon('warning')) : null));
  });
  ui.list.replaceChildren(...rows);
  ui.list.querySelector('.pl-current')?.scrollIntoView?.({ block: 'nearest' });
}

function toggleQueue(force) {
  const open = force ?? ui.queuePanel.hidden;
  ui.queuePanel.hidden = !open;
  ui.queueBtn.setAttribute('aria-pressed', String(open));
  ui.queueBtn.setAttribute('aria-expanded', String(open));
  paintList();
}

function setExpanded(on) {
  ui.root.classList.toggle('pl-expanded', on);
  ui.expandBtn.setAttribute('aria-pressed', String(on));
  ui.expandBtn.setAttribute('aria-label', on ? 'Smaller video' : 'Bigger video');
  ui.expandBtn.title = on ? 'Smaller video' : 'Bigger video';
}

function toggleExpanded() {
  setExpanded(!ui.root.classList.contains('pl-expanded'));
}

// ───────── Media Session

function sessionHandlers(on) {
  const ms = globalThis.navigator?.mediaSession;
  if (!ms) return;
  const handlers = {
    play: () => media()?.play().catch(() => {}),
    pause: () => pause(),
    previoustrack: () => prev(),
    nexttrack: () => next(),
    seekto: (d) => {
      const el = media();
      if (el && d && Number.isFinite(d.seekTime)) el.currentTime = d.seekTime;
    },
    stop: () => stop(),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      ms.setActionHandler(action, on ? fn : null);
    } catch {
      // unsupported action
    }
  }
}

function sessionMetadata(item) {
  const ms = globalThis.navigator?.mediaSession;
  if (!ms) return;
  try {
    ms.metadata = item && typeof globalThis.MediaMetadata === 'function'
      ? new globalThis.MediaMetadata({ title: safeFilename(item.name), artist: 'cZEROde', album: title || '' })
      : null;
  } catch {
    // ignore
  }
}

// ───────── playback

function releaseCurrent() {
  if (!current) return;
  const c = current;
  current = null;
  c.ctl.abort();
  detachMedia(c.el);
  c.handle?.release();
  disposeSource(c.src);
}

/** Releases the prepared next track; a prepare still waiting for its source disposes it when it arrives. */
function dropUpcoming() {
  prepareSeq++;
  if (!upcoming) return;
  disposeSource(upcoming.src);
  upcoming = null;
}

/**
 * Decrypts the next track's header (vault.open) and lets media.prefetch start on it. Prepares can overlap
 * (track loaded, then shuffle/repeat clicked while the first one still waits): only the newest keeps its source.
 */
async function prepareNext(seq) {
  const p = nextPos(pos);
  if (p < 0 || order[p] === current?.index) {
    dropUpcoming();
    return;
  }
  const index = order[p];
  if (upcoming && upcoming.index === index) return;
  dropUpcoming();
  const mine = prepareSeq;
  try {
    const src = await queue[index].getSource();
    if (seq !== loadSeq || mine !== prepareSeq || !ui) {
      disposeSource(src);
      return;
    }
    upcoming = { index, src };
    prefetch(src);
  } catch {
    // the track fails later, when it is its turn
  }
}

async function loadAt(p, { autoplay = true } = {}) {
  const seq = ++loadSeq;
  releaseCurrent();
  pos = p;
  const index = order[p];
  const item = queue[index];
  paintNow();
  if (!item) return;
  const isVideo = kindOf(item.type, item.name) === 'video';
  const el = isVideo ? ui.video : ui.audio;
  for (const other of [ui.audio, ui.video]) if (other !== el) detachMedia(other);
  sessionMetadata(item);
  ui.root.classList.add('pl-loading');
  const ctl = new AbortController();
  let src = null;
  try {
    if (upcoming && upcoming.index === index) {
      src = upcoming.src;
      upcoming = null;
      prepareSeq++;
    } else {
      dropUpcoming();
      src = await item.getSource();
    }
    if (seq !== loadSeq) {
      disposeSource(src);
      return;
    }
    current = { index, src, handle: null, el, ctl };
    const handle = await attachMedia(el, src, { mode: isVideo ? 'video' : 'audio', signal: ctl.signal });
    if (seq !== loadSeq) {
      handle.release(); // a newer load already released the source
      return;
    }
    current.handle = handle;
  } catch (e) {
    if (seq !== loadSeq) return; // the newer load released current (and its source)
    if (current) releaseCurrent();
    else disposeSource(src);
    ui.root.classList.remove('pl-loading');
    if (isCancel(e)) return;
    failed.add(index);
    paintList();
    const n = nextPos(p, { wrap: true });
    if (n >= 0 && n !== p) {
      toast(`Skipped ${safeFilename(item.name)}: ${userMessage(e)}`, { kind: 'warn' });
      loadAt(n, { autoplay });
    } else {
      toast(`Couldn't play this queue: ${userMessage(e)}`, { kind: 'err' });
      stop();
    }
    return;
  }
  ui.root.classList.remove('pl-loading');
  paintTime(el);
  paintPlay();
  paintToggles();
  if (autoplay) {
    el.play().catch((e) => {
      if (e?.name === 'AbortError') return;
      if (seq === loadSeq) endAdvance();
      paintPlay(); // autoplay refused: stays paused, the user presses play
    });
  } else endAdvance();
  prepareNext(seq);
}

function onEnded(el) {
  if (el !== media()) return;
  if (repeat === 'one') {
    startAdvance();
    el.currentTime = 0;
    el.play().catch(() => endAdvance());
    return;
  }
  const n = nextPos(pos);
  if (n >= 0) {
    startAdvance();
    loadAt(n);
  } else paintPlay();
}

function togglePlay() {
  const el = media();
  if (!el) return;
  if (el.paused || el.ended) el.play().catch(() => {});
  else pause();
}

function playAt(p) {
  if (p < 0 || p >= order.length || failed.has(order[p])) return;
  loadAt(p);
}

function next() {
  const n = nextPos(pos);
  if (n >= 0) loadAt(n);
}

function prev() {
  const el = media();
  if (el && el.currentTime > RESTART_AFTER) {
    el.currentTime = 0;
    return;
  }
  const p = prevPos(pos);
  if (p >= 0) loadAt(p);
  else if (el) el.currentTime = 0;
}

function setShuffle(on) {
  shuffled = Boolean(on);
  if (!order.length) return;
  const curIndex = order[pos];
  if (shuffled) order = [curIndex, ...shuffledCopy(identity(queue.length).filter((i) => i !== curIndex))];
  else order = identity(queue.length);
  pos = order.indexOf(curIndex);
  dropUpcoming();
  paintNow();
  prepareNext(loadSeq);
}

function setRepeat(mode) {
  repeat = Object.hasOwn(REPEAT_NEXT, mode) ? mode : 'off';
  paintToggles();
  prepareNext(loadSeq);
}

/**
 * Pauses the player (keeps the queue). Extra over §10 (the viewer pauses it when its own media starts).
 */
export function pause() {
  endAdvance();
  const el = media();
  if (el && !el.paused) el.pause();
}

/**
 * Plays a queue of ViewerItems (only audio/video items are kept). start = index into `items`.
 * @param {import('../types.js').ViewerItem[]} items
 * @param {{start?: number, shuffle?: boolean, repeat?: 'off'|'all'|'one', title?: string}} [opts]
 */
export function playQueue(items, { start = 0, shuffle = false, repeat: rep = 'off', title: name } = {}) {
  if (!ui) {
    globalThis.console?.warn?.('[player] not mounted');
    return;
  }
  const list = Array.isArray(items) ? items : [];
  const startItem = list[start] && playable(list[start]) ? list[start] : null;
  const kept = list.filter(playable);
  if (!kept.length) {
    toast('Nothing to play here.', { kind: 'info' });
    return;
  }
  releaseCurrent();
  dropUpcoming();
  queue = kept;
  failed = new Set();
  title = typeof name === 'string' ? safeFilename(name) : '';
  repeat = Object.hasOwn(REPEAT_NEXT, rep) ? rep : 'off';
  shuffled = Boolean(shuffle);
  const first = startItem ? kept.indexOf(startItem) : 0;
  order = shuffled ? [first, ...shuffledCopy(identity(kept.length).filter((i) => i !== first))] : identity(kept.length);
  sessionHandlers(true);
  loadAt(order.indexOf(first));
}

/** Stops playback, releases the decrypted media and clears the queue (the dock hides). */
export function stop() {
  loadSeq++;
  clearTimeout(advanceTimer);
  advanceTimer = null;
  advancing = false;
  releaseCurrent();
  dropUpcoming();
  queue = [];
  order = [];
  pos = -1;
  failed = new Set();
  title = '';
  sessionMetadata(null);
  sessionHandlers(false);
  if (!ui) return;
  for (const el of [ui.audio, ui.video]) {
    detachMedia(el);
    playing.delete(el); // the 'pause' event comes later: isPlaying() is false right away
  }
  publish();
  ui.list.replaceChildren();
  ui.name.textContent = '';
  ui.sub.textContent = '';
  toggleQueue(false);
  setExpanded(false);
  paintPlay();
  paintNow();
}

state.onPurge(() => stop());
