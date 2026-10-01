#!/usr/bin/env node
// Test fixtures for the e2e suites (DESIGN §8), committed under tests/fixtures/. Dev tool; never staged.
//
//   node scripts/gen-fixtures.mjs            (re)write every fixture
//   node scripts/gen-fixtures.mjs --only a,b  only the named fixtures (see FIXTURES below)
//
// Node writes the byte-exact ones (PNG, WAV, PDF, text, the folder tree, the legacy .czd from the vectors).
// Chromium (Playwright) renders the large JPEG and the video frames, and records the Opus audio with
// MediaRecorder; Playwright's ffmpeg build (VP8 encoder + WebM muxer only, no audio encoders) encodes the
// frames and muxes the recorded Opus by stream copy, so the WebM files have Cues and a duration (seekable).
// Chromium-made files are reproducible for a given Chromium build except the recorded audio.
// No H.264/AAC/MP3/OGG: this ffmpeg can't write them and the app must not depend on them.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'tests/fixtures');
const FFMPEG_CANDIDATES = [process.env.FFMPEG, '/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux', 'ffmpeg'].filter(Boolean);

// ───────── deterministic helpers

/** mulberry32 PRNG → bytes. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGBA → PNG (8-bit, color type 6, filter 0). */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A gradient with a red ring, like the app icon colours. */
function makePng(width = 320, height = 200) {
  const px = Buffer.alloc(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.38;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      const ring = Math.abs(d - r) < Math.max(3, r * 0.08);
      px[o] = ring ? 0xcc : Math.round((x / width) * 60);
      px[o + 1] = ring ? 0x22 : Math.round((y / height) * 40);
      px[o + 2] = ring ? 0x00 : 0x30;
      px[o + 3] = 0xff;
    }
  }
  return encodePng(width, height, px);
}

/** 16-bit PCM mono WAV: a 440 Hz tone with a 660 Hz second half. */
function makeWav(seconds = 1.5, rate = 44100) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const f = i < n / 2 ? 440 : 660;
    const env = Math.min(1, i / 2000, (n - i) / 2000);
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * f * i) / rate) * 0.4 * env * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A one-page PDF 1.4 with correct xref offsets. */
function makePdf(text = 'cZEROde test document') {
  const content = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const TEXT = [
  'cZEROde test notes',
  '',
  'Plain UTF-8 text with a few non-ASCII characters: ä ö ü ß, ქართული, Кириллица, 日本語, emoji 🔒💀.',
  'Line endings are LF. The last line ends with a newline.',
  '',
].join('\n');

/** The first old desktop .czd from the legacy vectors (UTF-8 JSON text, PIN 1234). */
function legacyCzd() {
  const v = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/legacy-desktop-vectors.json'), 'utf8'));
  const first = v.czd_files.find((f) => f.id === 'czd-1-red-dot');
  return { name: first.expected.saved_filename, pin: first.pin, text: first.expected.file_text };
}

// ───────── Chromium + ffmpeg

function findFfmpeg() {
  for (const bin of FFMPEG_CANDIDATES) {
    const r = spawnSync(bin, ['-hide_banner', '-version'], { stdio: 'ignore' });
    if (r.status === 0) return bin;
  }
  throw new Error('gen-fixtures: no ffmpeg found (set FFMPEG=/path/to/ffmpeg; Playwright ships one under PLAYWRIGHT_BROWSERS_PATH)');
}

function ffmpeg(args) {
  const r = spawnSync(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

async function withPage(fn) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>fixtures</title>');
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/** ~6 MB JPEG: 4000×3000 seeded noise + shapes at quality 0.9 (canvas.toBlob). */
async function makeLargeJpeg() {
  const b64 = await withPage((page) => page.evaluate(async () => {
    const w = 4000;
    const h = 3000;
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    const d = new Uint32Array(img.data.buffer);
    let s = 0x2545f491;
    for (let k = 0; k < d.length; k++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      d[k] = 0xff000000 | (s & 0x7f7f7f);
    }
    g.putImageData(img, 0, 0);
    g.fillStyle = '#cc2200';
    g.beginPath();
    g.arc(w / 2, h / 2, 900, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = 'bold 400px sans-serif';
    g.fillText('cZEROde', 900, 1650);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const u = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let k = 0; k < u.length; k += 8192) bin += String.fromCharCode(...u.subarray(k, k + 8192));
    return btoa(bin);
  }));
  return Buffer.from(b64, 'base64');
}

/** Records `seconds` of a two-tone WebAudio signal as Opus in WebM (MediaRecorder). */
async function recordOpus(page, seconds) {
  const b64 = await page.evaluate(async (secs) => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.2;
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + secs / 2);
    osc.connect(gain).connect(dest);
    const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 });
    const parts = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    osc.start();
    rec.start(250);
    await new Promise((r) => setTimeout(r, secs * 1000 + 300));
    rec.stop();
    await stopped;
    osc.stop();
    await ctx.close();
    const u = new Uint8Array(await new Blob(parts).arrayBuffer());
    let bin = '';
    for (let k = 0; k < u.length; k += 8192) bin += String.fromCharCode(...u.subarray(k, k + 8192));
    return btoa(bin);
  }, seconds);
  return Buffer.from(b64, 'base64');
}

/** JPEG frames (MJPEG stream) of a moving ring with a timestamp. */
async function renderFrames(page, { seconds, fps, width, height }) {
  const total = seconds * fps;
  const out = [];
  for (let start = 0; start < total; start += 25) {
    const frames = await page.evaluate(async ([s, n, f, w, h]) => {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d');
      const res = [];
      for (let i = s; i < s + n; i++) {
        const t = i / f;
        g.fillStyle = `hsl(${(i * 3) % 360} 40% 12%)`;
        g.fillRect(0, 0, w, h);
        g.strokeStyle = '#cc2200';
        g.lineWidth = 14;
        g.beginPath();
        g.arc(w / 2 + Math.sin(t * 2) * w * 0.25, h / 2, h * 0.3, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = '#ffffff';
        g.font = `bold ${Math.round(h / 6)}px sans-serif`;
        g.fillText(`t=${t.toFixed(2)}s`, w * 0.06, h * 0.9);
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        const u = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let k = 0; k < u.length; k += 8192) bin += String.fromCharCode(...u.subarray(k, k + 8192));
        res.push(btoa(bin));
      }
      return res;
    }, [start, Math.min(25, total - start), fps, width, height]);
    for (const fr of frames) out.push(Buffer.from(fr, 'base64'));
  }
  return Buffer.concat(out);
}

async function makeMedia(names) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'czd-fixtures-'));
  try {
    return await withPage(async (page) => {
      const out = {};
      const opus = path.join(tmp, 'rec.webm');
      writeFileSync(opus, await recordOpus(page, 5));
      if (names.has('audio.webm')) {
        const dst = path.join(tmp, 'audio.webm');
        ffmpeg(['-i', opus, '-map', '0:a', '-c:a', 'copy', '-fflags', '+bitexact', '-f', 'webm', dst]);
        out['audio.webm'] = readFileSync(dst);
      }
      if (names.has('clip.webm')) {
        const mjpeg = path.join(tmp, 'frames.mjpeg');
        writeFileSync(mjpeg, await renderFrames(page, { seconds: 5, fps: 25, width: 640, height: 360 }));
        const dst = path.join(tmp, 'clip.webm');
        ffmpeg(['-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '25', '-i', mjpeg, '-i', opus, '-map', '0:v', '-map', '1:a',
          '-c:v', 'libvpx', '-b:v', '1M', '-g', '25', '-threads', '1', '-c:a', 'copy', '-shortest', '-fflags', '+bitexact', '-f', 'webm', dst]);
        out['clip.webm'] = readFileSync(dst);
      }
      return out;
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ───────── fixture table

/** name → {mime, about, make(): Buffer|Promise<Buffer>} ; media files are produced together by makeMedia. */
export const FIXTURES = {
  'image.png': { mime: 'image/png', about: '320×200 PNG (Node encoder)', make: () => makePng() },
  'large.jpg': { mime: 'image/jpeg', about: '4000×3000 JPEG, ~6 MB (Chromium canvas)', make: makeLargeJpeg },
  'clip.webm': { mime: 'video/webm', about: '5 s 640×360 VP8 + Opus WebM with Cues (Chromium frames + MediaRecorder audio, ffmpeg)', media: true },
  'audio.webm': { mime: 'audio/webm', about: '5 s Opus in WebM with Cues (MediaRecorder, ffmpeg remux)', media: true },
  'tone.wav': { mime: 'audio/wav', about: '1.5 s 44.1 kHz 16-bit mono PCM (Node)', make: () => makeWav() },
  'doc.pdf': { mime: 'application/pdf', about: 'one-page PDF 1.4 with a valid xref (Node)', make: () => makePdf() },
  'notes.txt': { mime: 'text/plain', about: 'UTF-8 text with non-ASCII characters', make: () => Buffer.from(TEXT, 'utf8') },
  'folder/readme.txt': { mime: 'text/plain', about: 'folder import: top-level file', make: () => Buffer.from('top level file\n') },
  'folder/.hidden': { mime: 'application/octet-stream', about: 'folder import: dotfile (must be skipped)', make: () => Buffer.from('hidden\n') },
  'folder/photos/dot.png': { mime: 'image/png', about: 'folder import: nested PNG', make: () => makePng(16, 16) },
  'folder/photos/more/deep.txt': { mime: 'text/plain', about: 'folder import: depth 3', make: () => Buffer.from('deep file\n') },
  'legacy/red-dot.czd': { mime: 'application/x-czeroode', about: 'old desktop .czd (cZEROde 1, PIN 1234) from tests/vectors', make: () => Buffer.from(legacyCzd().text, 'utf8') },
};

/** Writes the selected fixtures and tests/fixtures/fixtures.json (sha256, size, mime, about). */
export async function generate({ only = null, out = OUT } = {}) {
  const names = new Set(only ?? Object.keys(FIXTURES));
  for (const n of names) if (!FIXTURES[n]) throw new Error(`unknown fixture ${n}`);
  const media = [...names].filter((n) => FIXTURES[n].media);
  const produced = media.length ? await makeMedia(new Set(media)) : {};
  for (const n of names) {
    const data = FIXTURES[n].media ? produced[n] : await FIXTURES[n].make();
    const file = path.join(out, n);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    console.log(`[fixtures] ${n} ${data.length} bytes`);
  }
  const index = {};
  for (const n of Object.keys(FIXTURES)) {
    const file = path.join(out, n);
    if (!existsSync(file)) continue;
    const data = readFileSync(file);
    index[n] = { size: data.length, sha256: createHash('sha256').update(data).digest('hex'), mime: FIXTURES[n].mime, about: FIXTURES[n].about };
  }
  const legacy = legacyCzd();
  index['legacy/red-dot.czd'].pin = legacy.pin;
  writeFileSync(path.join(out, 'fixtures.json'), `${JSON.stringify({ generator: 'scripts/gen-fixtures.mjs', files: index }, null, 2)}\n`);
  return index;
}

/** Every file under tests/fixtures (for tests). */
export function listFixtureFiles(dir = OUT) {
  const out = [];
  const walk = (rel) => {
    for (const ent of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(child);
      else if (statSync(path.join(dir, child)).isFile()) out.push(child);
    }
  };
  walk('');
  return out.sort();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const i = process.argv.indexOf('--only');
  const only = i >= 0 ? process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
  await generate({ only });
}
