#!/usr/bin/env node
// Local static server for development and tests (Playwright webServer). Serves the repo root as-is, like
// GitHub Pages: correct MIME types (.js/.mjs/.wasm/.webmanifest/.czd …), single-range requests, HEAD, and
// no caching. Never used in production.
//
//   node scripts/serve.mjs [--port 4173] [--host 127.0.0.1] [--base /cZEROdeWEB/] [--verbose]
//   (PORT / HOST environment variables work too; --base mounts the repo under a sub-path like Pages does)
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 4173;

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.czd': 'application/x-czeroode',
  '.czb': 'application/x-czeroode-backup',
});

/** Content-Type for a file name (application/octet-stream when unknown). */
export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Parses a single-range `Range` header against `size`.
 * @returns {{start: number, end: number}|null|'invalid'} null = no/ignored range, 'invalid' = 416
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // multi-range or garbage: serve the whole file
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/**
 * @param {{root?: string, base?: string, verbose?: boolean}} [opts]
 * @returns {http.Server}
 */
export function createServer({ root = ROOT, base = '/', verbose = false } = {}) {
  const prefix = `/${String(base).replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
  return http.createServer((req, res) => {
    const done = (status, headers = {}, body = '') => {
      res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
      if (verbose) console.log(status, req.method, req.url);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return done(405, { Allow: 'GET, HEAD' });
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return done(400);
    }
    if (prefix !== '/' && pathname === prefix.slice(0, -1)) return done(301, { Location: prefix });
    if (!pathname.startsWith(prefix)) return done(404, { 'Content-Type': 'text/plain' }, 'not found');
    const rel = pathname.slice(prefix.length);
    let file = path.resolve(root, `./${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) return done(403);
    let st;
    try {
      st = statSync(file);
      if (st.isDirectory()) {
        if (!pathname.endsWith('/')) return done(301, { Location: `${pathname}/` });
        file = path.join(file, 'index.html');
        st = statSync(file);
      }
    } catch {
      return done(404, { 'Content-Type': 'text/plain' }, 'not found');
    }
    const headers = {
      'Content-Type': mimeFor(file),
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
    };
    const range = parseRange(req.headers.range, st.size);
    if (range === 'invalid') return done(416, { ...headers, 'Content-Range': `bytes */${st.size}` });
    const { start, end } = range ?? { start: 0, end: st.size - 1 };
    const length = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, {
      'Cache-Control': 'no-store',
      ...headers,
      'Content-Length': String(length),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}),
    });
    if (verbose) console.log(range ? 206 : 200, req.method, req.url);
    if (req.method === 'HEAD' || length === 0) return res.end();
    createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(arg('--port') ?? process.env.PORT ?? DEFAULT_PORT);
  const host = arg('--host') ?? process.env.HOST ?? '127.0.0.1';
  const base = arg('--base') ?? '/';
  const server = createServer({ base, verbose: process.argv.includes('--verbose') });
  server.listen(port, host, () => {
    const b = `/${base.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
    console.log(`[serve] http://${host}:${port}${b}`);
  });
}
