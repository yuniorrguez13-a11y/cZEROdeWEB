// Legacy decoders in a real browser: Chromium's IndexedDB (probing must never create czeroode_db, with and
// without indexedDB.databases()), WebCrypto PBKDF2/AES-GCM/AES-CTR, Blob output.
import { decodeOldItem, deleteOldDb, forgetPins, listOldItems, listOldPlaylists, probeOldVault, setIdb, tryPin } from '../../app/legacy/oldvault.js';
import { decryptV4Text, pinMatchesV4 } from '../../app/legacy/v4.js';
import { decodeV2, decodeV3, detectLegacyText } from '../../app/legacy/mixed.js';
import { isOldCzd, openOldCzd } from '../../app/legacy/oldczd.js';
import { CzdError } from '../../app/errors.js';

const DB = 'czeroode_db';

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

async function dbNames() {
  return (await indexedDB.databases()).map((d) => d.name);
}

async function seed(web) {
  await req(indexedDB.deleteDatabase(DB));
  const open = indexedDB.open(web.indexeddb.db_name, web.indexeddb.db_version);
  open.onupgradeneeded = () => {
    for (const [name, s] of Object.entries(web.indexeddb.stores)) open.result.createObjectStore(name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
  };
  const db = await req(open);
  const tx = db.transaction(['vault', 'files', 'playlists'], 'readwrite');
  for (const v of web.vault) tx.objectStore('vault').put(v.record);
  for (const v of [...web.files.single_real_constants, ...web.files.batched_reduced_constants.vectors]) tx.objectStore('files').put(v.record);
  for (const p of [...web.playlists.real_constants, ...web.playlists.reduced_constants]) tx.objectStore('playlists').put(p.record);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
}

async function sha256(blob) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function rejectsWith(t, promise, code, msg) {
  try {
    await promise;
    t.assert(false, `${msg}: expected ${code}`);
  } catch (e) {
    t.equal(e instanceof CzdError ? e.code : String(e), code, msg);
  }
}

export default async function (t) {
  const load = async (f) => (await fetch(new URL(`../vectors/${f}`, import.meta.url))).json();
  const web = await load('legacy-web-vectors.json');
  const desk = await load('legacy-desktop-vectors.json');

  await t.test('probe never creates czeroode_db (databases() and the open/abort fallback)', async () => {
    await req(indexedDB.deleteDatabase(DB));
    setIdb(null);
    t.equal(await probeOldVault(), null, 'probe');
    await rejectsWith(t, listOldItems(), 'legacy-no-db', 'list without a db');
    t.assert(!(await dbNames()).includes(DB), 'not created via databases() path');
    let opens = 0;
    setIdb({
      open: (...a) => { opens++; return indexedDB.open(...a); },
      deleteDatabase: (n) => indexedDB.deleteDatabase(n),
      cmp: (a, b) => indexedDB.cmp(a, b),
    });
    t.equal(await probeOldVault(), null, 'probe (fallback)');
    t.assert(opens > 0, 'fallback opened the database');
    t.assert(!(await dbNames()).includes(DB), 'not created via the fallback path');
    setIdb(null);
  });

  await t.test('old web vault: list, unlock, decode files and notes, playlists, delete', async () => {
    await seed(web);
    setIdb(null);
    const files = [...web.files.single_real_constants, ...web.files.batched_reduced_constants.vectors];
    t.deepEqual(await probeOldVault(), { notes: web.vault.length, files: files.length, playlists: 2 }, 'counts');
    const items = await listOldItems();
    t.equal(items.length, web.vault.length + files.length, 'item count');
    for (const pin of new Set(files.map((v) => v.pin))) await tryPin(pin);
    for (const v of files) {
      const r = await decodeOldItem(`files:${v.record.id}`);
      t.equal(await sha256(r.blob), v.expected_plaintext_sha256, v.label);
    }
    await tryPin(web.vault[0].pin);
    t.equal((await decodeOldItem(`vault:${web.vault[0].record.id}`)).note.body, web.vault[0].plaintext, 'v4 note');
    t.equal((await decodeOldItem(`vault:${web.vault[1].record.id}`)).plaintextNote, true, 'plaintext note');
    const lists = await listOldPlaylists();
    t.deepEqual(lists.map((l) => l.itemIds.length).sort(), [1, 2], 'playlist items (dangling id dropped)');
    forgetPins();
    await rejectsWith(t, decodeOldItem(`files:${files[0].record.id}`), 'legacy-wrong-pin', 'after forgetPins');
    await deleteOldDb();
    t.assert(!(await dbNames()).includes(DB), 'deleted');
    t.equal(await probeOldVault(), null, 'probe after delete');
  });

  await t.test('deleteOldDb blocked by an old-app tab: other-tab, then completes when that tab closes', async () => {
    await seed(web);
    setIdb(null);
    const blocker = await req(indexedDB.open(DB)); // like the old app: never handles versionchange
    await rejectsWith(t, deleteOldDb(), 'other-tab', 'blocked delete');
    blocker.close();
    for (let i = 0; i < 100 && (await dbNames()).includes(DB); i++) await new Promise((r) => setTimeout(r, 20));
    t.assert(!(await dbNames()).includes(DB), 'deleted once unblocked');
    t.equal(await probeOldVault(), null, 'probe after delete');
  });

  await t.test('forgetPins while a tryPin is running remembers nothing', async () => {
    await seed(web);
    setIdb(null);
    const v = web.files.single_real_constants[0];
    const pending = tryPin(v.pin);
    forgetPins();
    t.deepEqual(await pending, [], 'nothing unlocked');
    await rejectsWith(t, decodeOldItem(`files:${v.record.id}`), 'legacy-wrong-pin', 'still locked');
    await deleteOldDb();
  });

  await t.test('v4 text, precheck, Mixed Script, desktop .czd', async () => {
    for (const v of web.v4.vectors) t.equal(await decryptV4Text(v.ciphertext, v.pin), v.plaintext, v.plaintext.slice(0, 20));
    for (const v of desk.v4_text) t.equal(await decryptV4Text(`${v.ciphertext}\n`, v.pin), v.plaintext, v.id);
    const rec = web.files.single_real_constants[0];
    t.equal(await pinMatchesV4(rec.record.cipher, rec.pin), true, 'precheck right pin');
    t.equal(await pinMatchesV4(rec.record.cipher, 'nope'), false, 'precheck wrong pin');
    t.equal(decodeV2(desk.legacy_text.v2[0].ciphertext).text, desk.legacy_text.v2[0].corrected_decode, 'v2 method III');
    t.equal(decodeV3(desk.legacy_text.v3[0].ciphertext, desk.legacy_text.v3[0].pin).text, desk.legacy_text.v3[0].original_v3sdec, 'v3');
    t.equal(detectLegacyText(web.v4.vectors[0].ciphertext), 'v4', 'detect v4');
    for (const v of desk.czd_files.filter((x) => !x.crafted)) {
      const text = v.expected.file_text;
      t.assert(isOldCzd(new TextEncoder().encode(text).subarray(0, 8)), `${v.id} sniff`);
      const r = await openOldCzd(text, v.pin);
      t.equal(r.type, v.expected.mime, v.id);
      t.equal(r.blob.size, v.input.file_size, v.id);
    }
  });
}
