// Browser units for the integration phase (runner: tests/browser/index.html?suite=integration, app CSP): the vault
// grid hands back exactly one thumbnail reference per URL it got (vault.thumbUrl/releaseThumb are reference-counted
// since several views share a thumbnail): a load that finishes after its card went away, a removed card, a destroyed
// grid. (Album pieces sharing a thumbnail with others: tests/e2e/upload-albums.spec.js.)
import { grid } from '../../app/ui/vault-grid.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = performance.now();
  while (!fn()) {
    if (performance.now() - t0 > ms) throw new Error('timed out');
    await wait(10);
  }
}

/** 1×1 PNG. */
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

function info(id, name) {
  return { id, name, type: 'image/png', kind: 'image', size: 10, addedAt: 1_700_000_000_000, storedBytes: 100, fav: false, hasThumb: true };
}

/**
 * A vault stand-in that counts thumbnail references like the real one: every non-null thumbUrl() is one handed-out
 * reference, every releaseThumb() gives one back. thumbUrl resolves when `gate` opens (a slow decrypt); `asked` counts
 * the calls (the grid asks once a card is on screen, after an IntersectionObserver callback).
 */
function fakeVault(items) {
  const v = {
    status: 'unlocked',
    list: items,
    asked: 0,
    handed: 0,
    released: 0,
    open: null,
    gate: Promise.resolve(),
    items: () => v.list.slice(),
    item: (id) => v.list.find((i) => i.id === id),
    lists: () => [],
    addEventListener() {},
    removeEventListener() {},
    async thumbUrl(id) {
      v.asked++;
      const known = v.list.some((i) => i.id === id);
      await v.gate;
      if (!known) return null;
      v.handed++;
      return URL.createObjectURL(new Blob([PNG], { type: 'image/png' }));
    },
    releaseThumb() {
      v.released++;
    },
  };
  return v;
}

export default async function (t) {
  t.test('grid: a card removed while its thumbnail loads hands the late reference back once', async () => {
    const v = fakeVault([info('a'.repeat(32), 'a.png'), info('b'.repeat(32), 'b.png')]);
    let open;
    v.gate = new Promise((r) => (open = r));
    const g = grid({ vault: v, filter: { sort: 'new', view: 'grid' } });
    document.body.append(g.el);
    g.update();
    await until(() => v.asked === 2); // both cards are visible: their thumbnails are loading
    v.list = v.list.slice(1); // 'a' goes away (deleted) while its decrypt runs
    g.update();
    open();
    await until(() => document.querySelectorAll('.vv-img').length === 1);
    await wait(50);
    t.equal(v.handed, 2, 'two URLs handed out');
    t.equal(v.released, 1, 'the removed card gave its late URL back exactly once');
    g.destroy();
    t.equal(v.released, 2, 'destroying the grid gives back the shown one');
  });

  t.test('grid: destroy while thumbnails load releases each late reference once, never more', async () => {
    const v = fakeVault([info('c'.repeat(32), 'c.png'), info('d'.repeat(32), 'd.png'), info('e'.repeat(32), 'e.png')]);
    let open;
    v.gate = new Promise((r) => (open = r));
    const g = grid({ vault: v, filter: { sort: 'new', view: 'grid' } });
    document.body.append(g.el);
    g.update();
    await until(() => v.asked === 3);
    g.destroy();
    open();
    await until(() => v.released >= 3);
    await wait(50); // any extra release would have happened by now
    t.equal(v.handed, 3);
    t.equal(v.released, 3, 'one release per URL handed out');
  });
}
