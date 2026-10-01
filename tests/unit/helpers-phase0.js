// Shared helpers for the phase-0 unit tests (repo root, recursive file listing).
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Repo-relative POSIX paths of every file under `dir` (relative to ROOT) whose name matches `re`. */
export function listFiles(dir, re = /\.js$/) {
  const out = [];
  const walk = (rel) => {
    for (const ent of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(child);
      else if (re.test(ent.name)) out.push(child);
    }
  };
  walk(dir);
  return out.sort();
}

/** Frontend JavaScript shipped to browsers: app/**\/*.js plus the root service-worker scripts. */
export function frontendJs() {
  return [...listFiles('app'), ...['sw.js', 'sw-stream.js', 'sw-assets.js']];
}
