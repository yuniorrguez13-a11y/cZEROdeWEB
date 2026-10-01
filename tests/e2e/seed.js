// Seeds the old cZEROde 1 web database (czeroode_db v2: stores vault/files/playlists, keyPath id) with every
// record of tests/vectors/legacy-web-vectors.json, exactly like the old app stored them. See seed.html.

import '../local-only.js';

const DB = 'czeroode_db';

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.onblocked = () => reject(new Error('blocked: close other tabs of this origin'));
});

async function seed() {
  await req(indexedDB.deleteDatabase(DB));
  if (new URLSearchParams(location.search).has('clear')) return { cleared: true };
  const web = await (await fetch(new URL('../vectors/legacy-web-vectors.json', import.meta.url))).json();
  const { db_name: name, db_version: version, stores } = web.indexeddb;
  const open = indexedDB.open(name, version);
  open.onupgradeneeded = () => {
    for (const [store, s] of Object.entries(stores)) open.result.createObjectStore(store, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
  };
  const db = await req(open);
  const records = {
    vault: web.vault.map((v) => v.record),
    files: [...web.files.single_real_constants, ...web.files.batched_reduced_constants.vectors].map((v) => v.record),
    playlists: [...web.playlists.real_constants, ...web.playlists.reduced_constants].map((p) => p.record),
  };
  const tx = db.transaction(Object.keys(records), 'readwrite');
  for (const [store, list] of Object.entries(records)) for (const r of list) tx.objectStore(store).put(r);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const counts = {};
  const rtx = db.transaction(Object.keys(records), 'readonly');
  for (const store of Object.keys(records)) counts[store] = await req(rtx.objectStore(store).count());
  db.close();
  return counts;
}

seed().then(
  (r) => {
    document.getElementById('status').textContent = `done ${JSON.stringify(r)}`;
    window.__seeded = r;
  },
  (e) => {
    document.getElementById('status').textContent = `failed: ${e}`;
    window.__seeded = { error: String(e) };
  },
);
