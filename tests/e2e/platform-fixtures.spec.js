// The committed media fixtures (scripts/gen-fixtures.mjs) decode in Chromium: images load, the WebM video has a
// finite duration and is seekable (Cues), the Opus WebM and WAV audio play. Served by scripts/serve.mjs.
import { test, expect } from '@playwright/test';

async function probe(page, kind, url) {
  return page.evaluate(async ([k, u]) => {
    const el = document.createElement(k);
    el.muted = true;
    el.preload = 'auto';
    const ready = new Promise((resolve, reject) => {
      el.addEventListener(k === 'img' ? 'load' : 'loadedmetadata', resolve, { once: true });
      el.addEventListener('error', () => reject(new Error(`${u}: ${el.error ? el.error.code : 'error'}`)), { once: true });
    });
    el.src = u;
    document.body.append(el);
    await ready;
    if (k === 'img') return { w: el.naturalWidth, h: el.naturalHeight };
    const seeked = new Promise((resolve) => el.addEventListener('seeked', resolve, { once: true }));
    el.currentTime = Math.min(3, el.duration / 2);
    await seeked;
    return { duration: el.duration, w: el.videoWidth ?? 0, h: el.videoHeight ?? 0, seekable: el.seekable.length > 0, at: el.currentTime };
  }, [kind, url]);
}

test('image fixtures decode', async ({ page }) => {
  await page.goto('/tests/e2e/seed.html?clear=1');
  expect(await probe(page, 'img', '/tests/fixtures/image.png')).toEqual({ w: 320, h: 200 });
  expect(await probe(page, 'img', '/tests/fixtures/large.jpg')).toEqual({ w: 4000, h: 3000 });
  expect(await probe(page, 'img', '/tests/fixtures/folder/photos/dot.png')).toEqual({ w: 16, h: 16 });
});

test('VP8/Opus WebM video: finite duration, seekable', async ({ page }) => {
  await page.goto('/tests/e2e/seed.html?clear=1');
  const v = await probe(page, 'video', '/tests/fixtures/clip.webm');
  expect(v.w).toBe(640);
  expect(v.h).toBe(360);
  expect(v.duration).toBeGreaterThan(4.5);
  expect(v.duration).toBeLessThan(5.6);
  expect(v.seekable).toBe(true);
  expect(v.at).toBeGreaterThan(2);
});

test('Opus WebM and WAV audio play', async ({ page }) => {
  await page.goto('/tests/e2e/seed.html?clear=1');
  const a = await probe(page, 'audio', '/tests/fixtures/audio.webm');
  expect(a.duration).toBeGreaterThan(4.5);
  expect(a.duration).toBeLessThan(5.6);
  const w = await probe(page, 'audio', '/tests/fixtures/tone.wav');
  expect(w.duration).toBeCloseTo(1.5, 2);
});
