// Container stores under a tiny storage quota (CDP Storage.overrideQuotaForOrigin): writes and stages that run
// out of space reject CzdError('quota-exceeded') and leave no partial container behind, for OpfsStore (the worker
// maps Chromium's short sync-access-handle writes) and IdbBlobStore. The page is the browser-unit harness (app CSP).
import { test, expect } from '@playwright/test';

test('quota exhaustion → quota-exceeded, nothing left behind (OPFS and IndexedDB stores)', async ({ page }) => {
  await page.goto('/tests/browser/index.html?suite=none');
  const origin = new URL(page.url()).origin;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 8 * 1024 * 1024 });
  const r = await page.evaluate(async () => {
    const { OpfsStore, IdbBlobStore } = await import('/app/vault/store.js');
    const { openVaultDb } = await import('/app/vault/db.js');
    const outcome = async (p) => {
      try {
        await p;
        return 'resolved';
      } catch (e) {
        return e.code ?? `${e.name}: ${e.message}`;
      }
    };
    const big = () => new Uint8Array(20 * 2 ** 20);
    const out = { quota: (await navigator.storage.estimate()).quota };
    const opfs = new OpfsStore();
    await opfs.init();
    out.opfsWrite = await outcome(opfs.write('a'.repeat(32), big()));
    out.opfsStage = await outcome(opfs.stage('big.czd', big()));
    out.opfsItems = (await opfs.list()).length;
    const root = await navigator.storage.getDirectory();
    const tmp = await (await (await root.getDirectoryHandle('czd')).getDirectoryHandle('v1')).getDirectoryHandle('tmp');
    out.opfsTmp = [];
    for await (const name of tmp.keys()) out.opfsTmp.push(name);
    out.opfsSmall = await outcome(opfs.write('c'.repeat(32), new Uint8Array(1000)));
    opfs.close();
    const db = await openVaultDb();
    const idb = new IdbBlobStore(db);
    await idb.init();
    out.idbWrite = await outcome(idb.write('b'.repeat(32), big()));
    out.idbStage = await outcome(idb.stage('big.czd', big()));
    out.idbRows = await db.tx(['blobs'], 'readonly', (tx) => {
      const k = tx.objectStore('blobs').getAllKeys();
      return () => k.result.length;
    });
    db.close();
    return out;
  });
  expect(r).toEqual({
    quota: 8 * 1024 * 1024,
    opfsWrite: 'quota-exceeded',
    opfsStage: 'quota-exceeded',
    opfsItems: 0,
    opfsTmp: [],
    opfsSmall: 'resolved',
    idbWrite: 'quota-exceeded',
    idbStage: 'quota-exceeded',
    idbRows: 0,
  });
});

test('a full origin still opens an existing OPFS store: reads and deletes work, writes reject quota-exceeded', async ({ page }) => {
  await page.goto('/tests/browser/index.html?suite=none');
  const origin = new URL(page.url()).origin;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 8 * 1024 * 1024 });
  const r = await page.evaluate(async () => {
    const { OpfsStore, openStore } = await import('/app/vault/store.js');
    const outcome = async (p) => {
      try {
        await p;
        return 'resolved';
      } catch (e) {
        return e.code ?? `${e.name}: ${e.message}`;
      }
    };
    const s = new OpfsStore();
    await s.init();
    const ids = [];
    // fill the quota down to the last bytes
    for (const n of [2 ** 20, 2 ** 18, 2 ** 15, 4096, 512, 64, 8, 1]) {
      for (;;) {
        const id = ids.length.toString(16).padStart(32, '0');
        try {
          await s.write(id, new Uint8Array(n).fill(7));
        } catch {
          break;
        }
        ids.push(id);
      }
    }
    s.close();
    const out = { filled: ids.length > 5 };
    let s2 = null;
    out.open = await outcome(openStore('opfs').then((x) => {
      s2 = x;
    }));
    if (s2) {
      out.read = await outcome(s2.source(ids[0]).then((src) => src.readAt(0, 4)));
      out.write = await outcome(s2.write('f'.repeat(32), new Uint8Array(2 ** 20)));
      out.del = await outcome(s2.delete(ids[0]));
      out.writeAfterDelete = await outcome(s2.write('e'.repeat(32), new Uint8Array(1000)));
      s2.close();
    }
    return out;
  });
  expect(r).toEqual({ filled: true, open: 'resolved', read: 'resolved', write: 'quota-exceeded', del: 'resolved', writeAfterDelete: 'resolved' });
});
