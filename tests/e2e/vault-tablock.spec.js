// Single active vault tab (DESIGN §4.5) with the real navigator.locks + BroadcastChannel: two tabs of one browser
// profile — the second one is 'other-tab' and can't unlock; "Use it here" moves the vault (the holder locks and
// shows other-tab); a user lock in one tab locks the other, while another tab's own idle/hidden purge does not.
import { test, expect } from '@playwright/test';

const PASS = 'tab lock e2e passphrase';

const status = (page) => page.evaluate(async () => (await import('./app/vault/vault.js')).vault?.status ?? null);

/** vault.<method>(arg) in the page → {ok, status} | {ok:false, code}. */
function call(page, method, arg) {
  return page.evaluate(async ([name, a]) => {
    const { vault } = await import('./app/vault/vault.js');
    try {
      if (name === 'create') await vault.create(a, { recovery: false });
      else if (name === 'unlock') await vault.unlock(a);
      else if (name === 'useHere') await vault.useHere();
      else if (name === 'useHereTwice') await Promise.all([vault.useHere(), vault.useHere()]);
      else throw new Error(`unknown ${name}`);
      return { ok: true, status: vault.status };
    } catch (e) {
      return { ok: false, code: e?.code ?? String(e) };
    }
  }, [method, arg]);
}

const purge = (page, reason) => page.evaluate(async (r) => (await import('./app/state.js')).purge(r), reason);

test('two tabs: other-tab, "Use it here" handoff both ways, remote user lock; passive purges ignored', async ({ context }) => {
  const a = await context.newPage();
  await a.goto('/');
  await expect.poll(() => status(a)).toBe('none');
  expect(await call(a, 'create', PASS)).toEqual({ ok: true, status: 'unlocked' });

  const b = await context.newPage();
  await b.goto('/');
  await expect.poll(() => status(b)).toBe('other-tab');
  expect(await call(b, 'unlock', PASS)).toEqual({ ok: false, code: 'other-tab' });
  expect(await status(a)).toBe('unlocked');

  // "Use it here" in B: A locks and shows other-tab, B can unlock.
  expect(await call(b, 'useHere')).toEqual({ ok: true, status: 'locked' });
  await expect.poll(() => status(a)).toBe('other-tab');
  expect(await call(b, 'unlock', PASS)).toEqual({ ok: true, status: 'unlocked' });

  // Another tab's own idle/hidden purge does not lock the vault tab; a user lock does.
  await purge(a, 'idle');
  await purge(a, 'hidden');
  await b.waitForTimeout(200);
  expect(await status(b)).toBe('unlocked');
  await purge(a, 'user');
  await expect.poll(() => status(b)).toBe('locked');

  // And back: A takes over again (two overlapping calls, like a double click), B shows other-tab.
  expect(await call(a, 'useHereTwice')).toEqual({ ok: true, status: 'locked' });
  await expect.poll(() => status(b)).toBe('other-tab');
  expect(await call(a, 'unlock', PASS)).toEqual({ ok: true, status: 'unlocked' });
  await a.waitForTimeout(3500); // past the yield wait: the second request must not have cost A the lock
  expect(await status(a)).toBe('unlocked');
  expect(await status(b)).toBe('other-tab');
});
