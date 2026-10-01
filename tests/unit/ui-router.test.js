// app/router.js: pure helpers (parseHash, viewKey, navTop, hrefFor) and the view lifecycle against
// a fake location/history (same view key → update, else unmount + mount; unknown → fallback; overlays).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, viewKey, navTop, hrefFor, TOPS } from '../../app/router.js';

test('parseHash', () => {
  const r = parseHash('#/vault/item/0123abcd?x=1&y=two');
  assert.equal(r.top, 'vault');
  assert.deepEqual(r.parts, ['item', '0123abcd']);
  assert.equal(r.query.get('x'), '1');
  assert.equal(r.query.get('y'), 'two');
  assert.equal(r.hash, '#/vault/item/0123abcd?x=1&y=two');
  assert.deepEqual(parseHash('').top, '');
  assert.deepEqual(parseHash('#').parts, []);
  assert.equal(parseHash('#/SEND').top, 'send', 'top is lowercased');
  assert.deepEqual(parseHash('#//vault//album//x/').parts, ['album', 'x'], 'empty segments dropped');
  assert.deepEqual(parseHash('#/vault/a%20b/%E2%9C%93').parts, ['a b', '✓']);
  assert.deepEqual(parseHash('#/vault/%E0%A4%A').parts, ['%E0%A4%A'], 'bad escapes kept as typed');
  assert.equal(parseHash('#/incoming?share=abc').query.get('share'), 'abc');
  assert.equal(parseHash('vault').top, 'vault', 'tolerates a missing #');
  assert.equal(parseHash(undefined).top, '');
});

test('viewKey: open/incoming render the send view', () => {
  assert.equal(viewKey('open'), 'send');
  assert.equal(viewKey('incoming'), 'send');
  for (const t of ['vault', 'send', 'text', 'more', 'settings', 'about', 'legacy', 'codzilla']) assert.equal(viewKey(t), t);
});

test('navTop: §1.2 highlight rules', () => {
  for (const t of ['settings', 'about', 'legacy', 'codzilla', 'more']) assert.equal(navTop(t), 'more', t);
  for (const t of ['open', 'incoming', 'send']) assert.equal(navTop(t), 'send', t);
  assert.equal(navTop('vault'), 'vault');
  assert.equal(navTop('text'), 'text');
  assert.equal(navTop(''), '');
});

test('hrefFor encodes parts and query', () => {
  assert.equal(hrefFor('vault'), '#/vault');
  assert.equal(hrefFor('vault', 'item', 'ab/cd'), '#/vault/item/ab%2Fcd');
  assert.equal(hrefFor('incoming', { share: 'x y' }), '#/incoming?share=x+y');
  assert.equal(hrefFor('send', {}), '#/send');
});

test('TOPS lists every §1.2 top', () => {
  assert.deepEqual([...TOPS].sort(), ['about', 'codzilla', 'incoming', 'legacy', 'more', 'open', 'send', 'settings', 'text', 'vault']);
});

// ───────── lifecycle with a fake browser

function fakeBrowser(initialHash) {
  const handlers = {};
  const entries = [{ url: `http://x/app/${initialHash}`, state: null }];
  let idx = 0;
  const hashOf = (url) => (url.includes('#') ? url.slice(url.indexOf('#')) : '');
  const fire = (type, ev = {}) => (handlers[type] ?? []).forEach((f) => f(ev));
  const location = {
    get href() {
      return entries[idx].url;
    },
    get hash() {
      return hashOf(entries[idx].url);
    },
    set hash(h) {
      entries.splice(idx + 1);
      entries.push({ url: entries[idx].url.split('#')[0] + h, state: null });
      idx++;
      fire('popstate', { state: null });
      fire('hashchange');
    },
    replace(url) {
      entries[idx] = { url, state: null };
    },
  };
  const history = {
    get state() {
      return entries[idx].state;
    },
    pushState(s, _t, url) {
      entries.splice(idx + 1);
      entries.push({ url: url ?? entries[idx].url, state: s });
      idx++;
    },
    replaceState(s, _t, url) {
      entries[idx] = { url: url ?? entries[idx].url, state: s };
    },
    back() {
      if (idx === 0) return;
      const before = hashOf(entries[idx].url);
      idx--;
      setTimeout(() => {
        fire('popstate', { state: entries[idx].state });
        if (hashOf(entries[idx].url) !== before) fire('hashchange');
      }, 0);
    },
    get length() {
      return entries.length;
    },
  };
  globalThis.location = location;
  globalThis.history = history;
  globalThis.addEventListener = (type, fn) => {
    (handlers[type] ??= []).push(fn);
  };
  return { location, history, entries, idx: () => idx };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('view lifecycle, aliases, fallback and overlays (fake browser)', async () => {
  const env = fakeBrowser('#/nowhere');
  const router = await import('../../app/router.js');
  const state = await import('../../app/state.js');
  const log = [];
  const view = (name) => async () => ({
    mount(root, route, ctx) {
      log.push(`mount ${name} ${route.top}/${route.parts.join('/')}`);
      assert.equal(ctx.state, state);
      return {
        update(r) {
          log.push(`update ${name} ${r.top}/${r.parts.join('/')}`);
        },
        unmount() {
          log.push(`unmount ${name}`);
        },
      };
    },
  });
  const root = { replaceChildren() {}, focus() {} };
  const routes = { vault: view('vault'), send: view('send'), text: view('text'), broken: async () => { throw new Error('load failed'); } };
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a);
  try {
    router.start(root, routes, { fallback: 'vault' });
    await tick();
    assert.equal(env.location.hash, '#/vault', 'unknown top replaced by the fallback');
    assert.equal(env.entries.length, 1, 'replace: no extra history entry');
    assert.deepEqual(log, ['mount vault vault/']);
    assert.equal(state.get('route').top, 'vault');

    router.navigate('#/vault/item/abc');
    await tick();
    assert.deepEqual(log.slice(1), ['update vault vault/item/abc'], 'same top → update, no remount');

    router.navigate('#/send');
    await tick();
    router.navigate('#/open');
    await tick();
    router.navigate('#/incoming?share=1');
    await tick();
    assert.deepEqual(log.slice(2), ['unmount vault', 'mount send send/', 'update send open/', 'update send incoming/'], 'open/incoming reuse the send view');
    assert.equal(router.current().top, 'incoming');
    assert.equal(router.current().query.get('share'), '1');

    router.navigate('#/text', { replace: true });
    await tick();
    assert.deepEqual(log.slice(6), ['unmount send', 'mount text text/']);

    // Overlay: one history entry; Back closes it (onPop), close() removes it without onPop.
    const before = env.entries.length;
    let popped = 0;
    const o = router.pushOverlay(() => popped++);
    assert.equal(env.entries.length, before + 1);
    env.history.back();
    await tick();
    assert.equal(popped, 1, 'Back called onPop');
    const o2 = router.pushOverlay(() => popped++);
    o2.close();
    await tick();
    await tick();
    assert.equal(popped, 1, 'close() does not call onPop');
    assert.equal(env.location.hash, '#/text');
    o.close(); // already popped: no-op

    // Navigation right after close() waits for the history.back() to land.
    const o3 = router.pushOverlay(() => popped++);
    o3.close();
    router.navigate('#/vault');
    await tick();
    await tick();
    assert.equal(env.location.hash, '#/vault');
    assert.equal(log.at(-1), 'mount vault vault/');
    assert.equal(popped, 1);

    // A module that fails to load shows the error placeholder (no crash); the next route still works.
    router.navigate('#/broken');
    await tick();
    assert.equal(env.location.hash, '#/broken');
    assert.equal(log.at(-1), 'unmount vault');
    assert.ok(errors.some((a) => String(a[0]).includes('view failed')));
    router.navigate('#/text');
    await tick();
    assert.equal(log.at(-1), 'mount text text/');
  } finally {
    console.error = origErr;
  }
});
