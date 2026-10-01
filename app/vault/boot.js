// Vault boot (DESIGN §2.5, §4.2, §4.5, §10): opens the vault database, creates the Vault singleton with its store
// factory, holds the single-vault-tab lock ('czd-vault-tab' + 'yield' over BroadcastChannel 'czd-lock'), sweeps the
// store while holding it, wires the Send stager, remote locks, autolock, the legacy and browser probes, and on the
// desktop mirrors the index to $APPDATA/vault2/index.json (rebuilding IndexedDB from it when IndexedDB lost the vault).

import * as platform from '../platform.js';
import * as stateModule from '../state.js';
import { isPassive } from '../state.js';
import * as settingsModule from '../settings.js';
import { bootProbe } from '../crypto/kdf.js';
import { fromUtf8, utf8 } from '../util/bytes.js';
import { openVaultDb } from './db.js';
import { openStore, probeBestKind } from './store.js';
import { Vault, setVault } from './vault.js';
import { makeThumb } from './thumbs.js';
import { startAutolock } from './autolock.js';

const MIRROR_DELAY_MS = 500;
const YIELD_WAIT_MS = 3000;
const SWEEP_DELAY_MS = 3000;
const MIRROR_DIR = 'vault2';
const MIRROR_FILE = 'index.json';

function warn(what, e) {
  globalThis.console?.warn?.(`[vault boot] ${what}`, e);
}

/**
 * Boots the vault layer (called once by main.js). Extra options (tests): idb, IDBKeyRange (fake-indexeddb),
 * locks (navigator.locks stand-in), BroadcastChannel, tauriFs, sweepDelayMs.
 * Sets state 'vault.status' (mirrors vault 'status' events), 'browser.ok', 'legacy.found' ({notes, files, playlists}
 * or null) and 'legacy.importDone'.
 * @param {{router?: object, state?: typeof stateModule, settings?: typeof settingsModule, idb?: IDBFactory, IDBKeyRange?: any,
 *   locks?: LockManager|null, BroadcastChannel?: typeof BroadcastChannel|null, tauriFs?: object, sweepDelayMs?: number}} [opts]
 * @returns {Promise<{vault: Vault, stop: () => void}>}
 */
export async function boot({
  router,
  state = stateModule,
  settings = settingsModule,
  idb,
  IDBKeyRange,
  locks = globalThis.navigator?.locks,
  BroadcastChannel: BC = globalThis.BroadcastChannel,
  tauriFs = platform.tauriFs,
  sweepDelayMs = SWEEP_DELAY_MS,
} = {}) {
  void router; // views navigate on their own; kept for the §10 signature
  const stops = [];

  bootProbe().then(
    (r) => state.set('browser.ok', r.ok === true),
    () => state.set('browser.ok', false),
  );

  const tab = createTabLock({ locks: platform.isTauri ? null : locks, BC, state });
  stops.push(() => tab.close());
  await tab.acquire();

  let vault = null;
  let db = null;
  try {
    db = await openVaultDb({
      ...(idb ? { idb } : {}),
      ...(IDBKeyRange ? { IDBKeyRange } : {}),
      onClose: () => vault?.lock('closed'),
    });
  } catch (e) {
    warn('the vault database is unavailable', e);
  }

  if (db && platform.isTauri) {
    try {
      if (await rebuildFromMirror(db, tauriFs)) warn('rebuilt the vault index from index.json', null);
    } catch (e) {
      warn('could not rebuild the index from index.json', e);
    }
  }

  /** The vault's store (opened by the Vault through this factory); reused for sweeps and staging. */
  let current = null;
  const storeFactory = async (kind) => {
    const k = kind ?? (await probeBestKind());
    if (current && current.kind === k) return current;
    const s = await openStore(k, { db });
    current = s;
    return s;
  };

  vault = new Vault({
    db,
    openStore: storeFactory,
    thumbnailer: makeThumb,
    isHolder: () => tab.isHolder(),
    useHere: () => tab.takeOver(),
  });
  setVault(vault);
  const onStatus = (e) => state.set('vault.status', e.detail.status);
  vault.addEventListener('status', onStatus);
  stops.push(() => vault.removeEventListener('status', onStatus));
  tab.onLost = () => vault.lock('remote');
  await vault.init();
  state.set('vault.status', vault.status);

  // Any purge (another module's "lock everything") also locks the vault; vault.lock's own purge finds it locked already.
  // A deliberate one (panic: autolock's Esc×3 when nothing is unlocked yet) also cancels an unlock, create or
  // restore still running, so the vault can't open a moment later. Passive ones (idle/hidden/…) leave those alone:
  // autolock applies the hidden rule again when the vault opens.
  if (typeof state.onPurge === 'function') {
    stops.push(state.onPurge((reason) => {
      if (vault.status === 'unlocked' || !isPassive(reason)) vault.lock(reason);
    }));
  }

  if (typeof state.onRemoteLock === 'function') {
    stops.push(state.onRemoteLock((reason) => {
      // Passive reasons aren't broadcast any more (state.purge); a tab running older code may still send them.
      if (!isPassive(reason)) vault.lock('remote');
    }));
  }

  if (!platform.isTauri) {
    let staging = null;
    platform.setStager(async (name, source, opts) => {
      if (current) return current.stage(name, source, opts);
      staging ??= storeFactory().catch((e) => {
        staging = null;
        throw e;
      });
      return (await staging).stage(name, source, opts);
    });
    stops.push(() => platform.setStager(null));
  }

  if (tab.isHolder() && db && vault.status === 'locked') {
    // Re-checked when due: "Use it here" in another tab may have taken the vault tab lock meanwhile (§4.2).
    const t = setTimeout(() => {
      if (tab.isHolder()) sweep(db, current).catch((e) => warn('sweep failed', e));
    }, sweepDelayMs);
    t?.unref?.();
    stops.push(() => clearTimeout(t));
  }

  let player = null;
  import('../ui/player.js').then((m) => {
    player = m;
  }, () => {});
  stops.push(startAutolock({
    vault,
    settings,
    state,
    isMediaPlaying: () => {
      try {
        return Boolean(player?.isPlaying?.());
      } catch {
        return false;
      }
    },
  }));

  probeLegacy(db, state);

  if (platform.isTauri && db) {
    const mirror = createMirror(db, tauriFs);
    const schedule = (e) => mirror.schedule(e?.type === 'status' && e.detail?.status === 'none');
    for (const type of ['items', 'lists', 'meta', 'status']) {
      vault.addEventListener(type, schedule);
      stops.push(() => vault.removeEventListener(type, schedule));
    }
    const flush = () => mirror.flush();
    globalThis.addEventListener?.('pagehide', flush);
    stops.push(() => {
      globalThis.removeEventListener?.('pagehide', flush);
      mirror.flush();
    });
  }

  return {
    vault,
    stop() {
      for (const s of stops.splice(0).reverse()) {
        try {
          s();
        } catch (e) {
          warn('stop failed', e);
        }
      }
    },
  };
}

/** Deletes stale tmp files and item files without an index record (the store holds 'czd-store' while it does). */
async function sweep(db, store) {
  if (!store) return;
  if (!(await db.getMeta())) return;
  const knownIds = (await db.getAll('items')).map((r) => r.id);
  await store.sweep({ knownIds });
}

function probeLegacy(db, state) {
  import('../legacy/oldvault.js')
    .then((m) => m.probeOldVault())
    .then(async (found) => {
      state.set('legacy.found', found ?? null);
      let done = false;
      try {
        done = Boolean(db && (await db.kvGet('legacy-import-done')));
      } catch {
        done = false;
      }
      state.set('legacy.importDone', done);
    })
    .catch((e) => {
      warn('legacy probe failed', e);
      state.set('legacy.found', null);
    });
}

// ───────── single vault tab (§4.5)

/**
 * navigator.locks 'czd-vault-tab' (held for the page's lifetime) plus the 'yield' handoff over 'czd-lock'.
 * Without navigator.locks (or under Tauri) this tab is always the holder. Exported for tests.
 * @param {{locks: LockManager|null, BC: typeof BroadcastChannel|null, state: {TAB_ID?: string}, yieldWaitMs?: number}} opts
 * @returns {{onLost: (() => void)|null, isHolder(): boolean, acquire(): Promise<boolean>, takeOver(): Promise<boolean>, close(): void}}
 */
export function createTabLock({ locks, BC, state, yieldWaitMs = YIELD_WAIT_MS }) {
  const tab = {
    onLost: null,
    isHolder: () => true,
    acquire: async () => true,
    takeOver: async () => true,
    close() {},
  };
  if (!locks || typeof locks.request !== 'function') return tab;
  const tabId = state.TAB_ID ?? String(Math.random());
  let holder = false;
  let releaseLock = null;
  let channel = null;
  try {
    channel = typeof BC === 'function' ? new BC('czd-lock') : null;
  } catch {
    channel = null;
  }

  const lost = () => {
    if (!holder) return;
    holder = false;
    try {
      tab.onLost?.();
    } catch (e) {
      warn('tab handoff', e);
    }
  };

  const request = (opts) => new Promise((resolve) => {
    let settled = false;
    let granted = false;
    const settle = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    Promise.resolve()
      .then(() => locks.request('czd-vault-tab', opts, (lock) => {
        if (!lock) {
          settle(false);
          return undefined;
        }
        granted = true;
        holder = true;
        settle(true);
        return new Promise((r) => {
          releaseLock = () => {
            releaseLock = null;
            r();
          };
        });
      }))
      .then(() => settle(false), () => {
        // Stolen by another tab (AbortError) while this request held the lock → lost. A queued request that was
        // only cancelled (the yield wait ran out) never held it: it must not touch the state of one that does.
        if (granted) {
          releaseLock = null;
          lost();
        }
        settle(false);
      });
  });

  const onMessage = (e) => {
    const m = e?.data;
    if (!m || typeof m !== 'object' || m.cmd !== 'yield' || m.from === tabId || !holder) return;
    lost();
    releaseLock?.();
  };
  channel?.addEventListener('message', onMessage);

  tab.isHolder = () => holder;
  tab.acquire = () => request({ ifAvailable: true });
  let taking = null;
  const takeOver = async () => {
    try {
      channel?.postMessage({ cmd: 'yield', from: tabId });
    } catch (e) {
      warn('yield message', e);
    }
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ac?.abort(), yieldWaitMs);
    let ok = await request(ac ? { signal: ac.signal } : {});
    clearTimeout(timer);
    // The holder didn't answer (a frozen background tab): take the lock; it locks itself when it wakes up.
    if (!ok) ok = await request({ steal: true });
    return ok;
  };
  // One handoff at a time (a double click on "Use it here" must not queue a second request behind our own lock).
  tab.takeOver = () => {
    if (holder) return Promise.resolve(true);
    taking ??= takeOver().finally(() => {
      taking = null;
    });
    return taking;
  };
  tab.close = () => {
    channel?.removeEventListener('message', onMessage);
    channel?.close?.();
    holder = false;
    releaseLock?.();
  };
  return tab;
}

// ───────── desktop index mirror (§2.5)

async function mirrorPaths(fs) {
  const dir = await fs.join(await fs.appDataDir(), MIRROR_DIR);
  return { dir, file: await fs.join(dir, MIRROR_FILE), part: await fs.join(dir, `${MIRROR_FILE}.part`) };
}

/**
 * IndexedDB has no vault record but index.json exists → import it (thumbs are not mirrored). Exported for tests.
 * @returns {Promise<boolean>} rebuilt
 */
export async function rebuildFromMirror(db, fs) {
  if (await db.getMeta()) return false;
  const { dir, file } = await mirrorPaths(fs);
  if (!(await fs.exists(file))) return false;
  const ent = (await fs.list(dir)).find((e) => e.name === MIRROR_FILE);
  if (!ent || !(ent.size > 0)) return false;
  const snap = JSON.parse(fromUtf8(await fs.readAt(file, 0, ent.size)));
  await db.importSnapshot(snap);
  return true;
}

/**
 * Debounced atomic writes of db.exportSnapshot() (write .part, then rename over index.json); no vault → removed.
 * Exported for tests.
 * @returns {{schedule(now?: boolean): void, flush(): Promise<void>}}
 */
export function createMirror(db, fs) {
  let timer = null;
  let chain = Promise.resolve();
  const write = () => {
    chain = chain
      .then(async () => {
        const { dir, file, part } = await mirrorPaths(fs);
        const snap = await db.exportSnapshot();
        if (!snap.meta) {
          if (await fs.exists(file)) await fs.remove(file);
          return;
        }
        await fs.mkdir(dir);
        await fs.writeStream(part, [utf8(JSON.stringify(snap))]);
        await fs.rename(part, file);
      })
      .catch((e) => warn('index.json mirror write failed', e));
    return chain;
  };
  return {
    schedule(now = false) {
      clearTimeout(timer);
      timer = null;
      if (now) {
        write();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        write();
      }, MIRROR_DELAY_MS);
      timer?.unref?.();
    },
    flush() {
      if (timer === null) return chain;
      clearTimeout(timer);
      timer = null;
      return write();
    },
  };
}
