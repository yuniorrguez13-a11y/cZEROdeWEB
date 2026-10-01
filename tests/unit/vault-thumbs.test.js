// app/vault/thumbs.js in Node: never throws, null without a DOM; with stand-ins for createImageBitmap and
// OffscreenCanvas, the JPEG fitting rules (long edge ≤ 320, ≤ 32 KiB: quality first, then size), the resize path,
// SVG never rendered, oversized images skipped, and every bitmap closed. Real decoding runs in tests/browser/vault.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeThumb } from '../../app/vault/thumbs.js';
import { CAPS } from '../../app/config.js';

test('never throws; null without DOM APIs or for unsupported input', async () => {
  for (const [f, t] of [[null, 'image/png'], ['x', 'image/png'], [new Blob([]), 'image/png'], [new Blob([new Uint8Array(4)]), 'image/png'],
    [new Blob([new Uint8Array(4)]), 'video/mp4'], [new Blob([new Uint8Array(4)]), 'audio/mpeg'], [new Blob([new Uint8Array(4)]), 'application/pdf'],
    [new File([new Uint8Array(4)], 'x.svg', { type: 'image/svg+xml' }), 'image/svg+xml']]) {
    assert.equal(await makeThumb(f, t), null);
  }
});

/** Installs fake createImageBitmap/OffscreenCanvas; jpegSize(w, h, q) decides the encoded size. */
async function withFakes({ width = 4000, height = 3000, jpegSize, resize = true, decodeFails = false }, fn) {
  const saved = { cib: globalThis.createImageBitmap, oc: globalThis.OffscreenCanvas };
  const log = { closed: 0, created: 0, canvases: [], qualities: [], decoded: 0 };
  globalThis.createImageBitmap = async (src, opts) => {
    if (src instanceof Blob) {
      log.decoded++;
      if (decodeFails) throw new DOMException('bad image', 'InvalidStateError');
      log.created++;
      return { width, height, close: () => log.closed++ };
    }
    log.created++;
    if (!resize) return { width, height, close: () => log.closed++ }; // options ignored (old engines)
    return { width: opts.resizeWidth, height: opts.resizeHeight, close: () => log.closed++ };
  };
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      log.canvases.push([w, h]);
    }

    getContext() {
      return { fillRect() {}, drawImage() {}, fillStyle: '' };
    }

    async convertToBlob({ type, quality }) {
      log.qualities.push(quality);
      return new Blob([new Uint8Array(jpegSize(this.width, this.height, quality))], { type });
    }
  };
  try {
    await fn(log);
  } finally {
    globalThis.createImageBitmap = saved.cib;
    globalThis.OffscreenCanvas = saved.oc;
  }
}

function img(name = 'p.jpg', size = 1000) {
  const u = new Uint8Array(size);
  u.set([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic: unknown bytes never reach a decoder
  return new File([u], name, { type: 'image/jpeg' });
}

test('image: long edge 320, q 0.7 when it fits; original size reported; bitmaps closed', async () => {
  await withFakes({ jpegSize: () => 20_000 }, async (log) => {
    const r = await makeThumb(img(), 'image/jpeg');
    assert.equal(r.jpeg.length, 20_000);
    assert.equal(r.w, 4000);
    assert.equal(r.h, 3000);
    assert.deepEqual(log.canvases, [[320, 240]]);
    assert.deepEqual(log.qualities, [0.7]);
    assert.equal(log.closed, log.created);
  });
});

test('image: lowers the quality, then the size, until ≤ 32 KiB; gives up (null) when nothing fits', async () => {
  await withFakes({ jpegSize: (w, h, q) => Math.round(w * h * q * 2) }, async (log) => {
    const r = await makeThumb(img(), 'image/jpeg');
    assert.ok(r.jpeg.length <= CAPS.thumbBytes);
    assert.equal(log.canvases[0][0], 320);
    assert.deepEqual(log.qualities.slice(0, 5), [0.7, 0.6, 0.5, 0.4, 0.3]);
    assert.ok(log.canvases.length > 1, 'shrunk after every quality was too big');
    assert.ok(log.canvases.at(-1)[0] < 320);
  });
  await withFakes({ jpegSize: () => 40_000 }, async (log) => {
    assert.equal(await makeThumb(img(), 'image/jpeg'), null);
    assert.equal(log.closed, log.created);
  });
});

test('image: small images keep their size; portrait long edge; resize options ignored → canvas scaling', async () => {
  await withFakes({ width: 100, height: 50, jpegSize: () => 1000 }, async (log) => {
    const r = await makeThumb(img(), 'image/jpeg');
    assert.deepEqual([r.w, r.h], [100, 50]);
    assert.deepEqual(log.canvases, [[100, 50]]);
  });
  await withFakes({ width: 1000, height: 4000, jpegSize: () => 1000, resize: false }, async (log) => {
    await makeThumb(img(), 'image/jpeg');
    assert.deepEqual(log.canvases, [[80, 320]]);
    assert.equal(log.closed, log.created);
  });
});

test('image: unknown bytes are not decoded at all; undecodable (no <img> fallback) or larger than CAPS.image → null', async () => {
  await withFakes({ jpegSize: () => 10 }, async (log) => {
    assert.equal(await makeThumb(new File([new Uint8Array(100)], 'zeros.png', { type: 'image/png' }), 'image/png'), null);
    assert.equal(log.decoded, 0);
  });
  await withFakes({ jpegSize: () => 10, decodeFails: true }, async () => {
    assert.equal(await makeThumb(img(), 'image/jpeg'), null);
  });
  await withFakes({ jpegSize: () => 10 }, async (log) => {
    const big = { __proto__: Blob.prototype, size: CAPS.image + 1, type: 'image/jpeg', name: 'huge.jpg' };
    assert.equal(await makeThumb(big, 'image/jpeg'), null);
    assert.equal(log.decoded, 0);
  });
});
