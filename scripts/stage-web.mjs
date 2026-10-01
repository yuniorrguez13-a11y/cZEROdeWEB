#!/usr/bin/env node
// Copies the static web app (served as-is by GitHub Pages from the repo root) into ./dist so Tauri can
// embed it (DESIGN §2.1). No bundling, no transpiling: byte-for-byte copies of an allowlist.
// The service worker scripts are NOT staged: the desktop app never registers a service worker.
// The same file list is the web precache (scripts/precache.mjs).
//
//   node scripts/stage-web.mjs          one-shot copy (tauri beforeBuildCommand / beforeDevCommand)
//   node scripts/stage-web.mjs --watch  keep re-copying on change (2nd terminal during `tauri dev`)
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = path.join(ROOT, 'dist');

/** What the app is made of. Anything else (README, src-tauri, scripts, tests, node_modules, sw*.js …) is not staged. */
export const INCLUDE = Object.freeze(['index.html', 'app', 'css', 'assets', 'favicon.ico', 'manifest.webmanifest']);

/**
 * Repo-relative POSIX paths of every file the stage copies, sorted. Dotfiles and dot-directories are skipped.
 * @param {string} [root]
 * @returns {string[]}
 */
export function listStagedFiles(root = ROOT) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const ent of readdirSync(abs, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        walk(`${rel}/${ent.name}`);
      }
    } else {
      out.push(rel);
    }
  };
  for (const entry of INCLUDE) walk(entry);
  return out.sort();
}

/**
 * Rebuilds `out` (default ./dist) from the allowlist.
 * @param {{root?: string, out?: string, quiet?: boolean}} [opts]
 * @returns {string[]} the staged files
 */
export function stage({ root = ROOT, out = DIST, quiet = false } = {}) {
  const files = listStagedFiles(root);
  if (!files.includes('index.html')) throw new Error('stage-web: index.html missing at repo root');
  rmSync(out, { recursive: true, force: true });
  for (const rel of files) {
    const dest = path.join(out, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(root, rel), dest);
  }
  if (!quiet) console.log(`[stage-web] ${files.length} files -> ${path.relative(root, out) || out}/`);
  return files;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  stage();
  if (process.argv.includes('--watch')) {
    let timer = null;
    const again = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          stage();
        } catch (e) {
          console.error(e);
        }
      }, 150);
    };
    for (const entry of INCLUDE) {
      const src = path.join(ROOT, entry);
      if (existsSync(src)) watch(src, { recursive: true }, again);
    }
    console.log('[stage-web] watching for changes (Ctrl+C to stop)');
  }
}
