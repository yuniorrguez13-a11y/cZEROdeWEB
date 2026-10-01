# Developing cZEROde

cZEROde 2 is one static frontend with two ways to ship it:

- **Web:** GitHub Pages serves the repository root as-is, at `https://yuniorrguez13-a11y.github.io/cZEROdeWEB/`.
- **Desktop:** Tauri 2 embeds a staged copy of the same files (`dist/`) for Windows, macOS and Linux.

There is no bundler, no transpiler and no runtime npm dependency. What you edit is what runs.

The rest of the documentation:

- [`docs/FORMAT.md`](FORMAT.md): every byte format (containers, text, vault records, backups, legacy).
- [`SECURITY.md`](../SECURITY.md): the security model.

---

## Repository layout

```
index.html  manifest.webmanifest  favicon.ico  .nojekyll        the web app entry (served as-is by Pages)
sw.js  sw-stream.js  sw-assets.js (generated)                   service worker: precache, share target, /czstream/
css/app.css                                                     tokens and shared components
css/{vault,viewer,player,upload,albums,send,text,legacy,settings,extras}.css   one owner each, prefixed selectors
assets/fonts/*.woff2 + OFL.txt    assets/icons/sprite.svg + PWA icons
app/main.js  app/theme-boot.js                                  browser entry points (not Node-importable)
app/{config,errors,types,platform,pwa,router,state,settings}.js
app/util/{bytes,format,dom,stream}.js
app/crypto/{kdf,kdf-worker,stealth,container,textfmt,passphrase,wordlist}.js + argon2.umd.min.js (vendored)
app/legacy/{v4,mixed,oldvault,oldczd}.js                        cZEROde 1 decoders (decode only)
app/vault/{db,store,opfs-worker,vault,backup,thumbs,autolock,boot}.js
app/media/media.js
app/ui/*.js                                                     views and UI components
src-tauri/                                                      desktop shell (Rust): lib.rs, stream.rs (czstream), tauri.conf.json, capabilities/, icons/, linux/
scripts/                                                        dev tools (never shipped): serve, stage-web, precache, gen-*
tests/unit/  tests/browser/  tests/e2e/  tests/fixtures/  tests/vectors/
docs/  README.md  SECURITY.md
```

`dist/`, `node_modules/`, `src-tauri/target/`, `src-tauri/gen/schemas/`, `test-results/` and `playwright-report/`
are git-ignored. `tests/`, `scripts/`, `docs/` and `src-tauri/` are never staged into `dist/` and never precached.

---

## Code rules

The tests enforce these, so a violation fails `npm test`.

- **Plain ES2022 modules, no build step.** No npm runtime dependencies. The only vendored files are listed under
  [Vendored files](#vendored-files).
- **Content Security Policy:** `index.html`'s `<meta>` CSP and `src-tauri/tauri.conf.json` `app.security.csp` must
  be equal directive by directive. The only difference allowed is `frame-ancestors 'none'`, which exists only in
  Tauri. `tests/unit/index-html.test.js` checks this.

  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:;
  media-src 'self' blob: czstream: http://czstream.localhost https://czstream.localhost; font-src 'self';
  connect-src 'self' ipc: http://ipc.localhost https://ipc.localhost; worker-src 'self'; manifest-src 'self';
  object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'
  ```

- **No HTML sinks and no inline code:**
  - no inline `<script>`/`<style>` and no `on*=` attributes;
  - no `eval` or `new Function`;
  - never `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`;
  - no `style=` attributes: use classes or CSSOM (`el.style.x = …`).

  Build the DOM with `h()` from `app/util/dom.js` and `textContent`. `tests/unit/sinks.test.js` greps `app/**`
  for these, comments included: name the rule, not the sink.
- **No network requests.** No CDNs and no Google Fonts; fonts are self-hosted.
- **`localStorage` only through `app/settings.js`** (keys `czd2.*`, every access in try/catch).
- **Untrusted strings** (names from containers, bundles, legacy records, backups and the file system) go
  through `format.safeFilename()` and are only ever rendered as text. MIME types used for Blobs, SW responses or
  viewer dispatch go through `format.safeMediaType()`. `format.kindOf(type, name)` is the only classifier; a
  container's own claims are never trusted.
- **Node-importable modules.** Every module except these must import in Node 22 without a DOM:
  - `app/main.js` and `app/theme-boot.js`;
  - the workers (`app/crypto/kdf-worker.js`, `app/vault/opfs-worker.js`);
  - the vendored UMD and the `sw*.js` scripts.

  So: no top-level `window`/`document`/`navigator`/`localStorage`. Touch them only inside functions, with
  `typeof` guards where needed.
- **Errors:** throw `new CzdError(code)` from `app/errors.js` with a code from `CODES`. `tests/unit/errors.test.js`
  checks that every code literal used is in `CODES`, and `userMessage(code)` holds the user-facing copy.
  Programming errors are `TypeError`/`RangeError`.
- **Style:** small focused modules, JSDoc on exports, comments only where they explain something non-obvious.

### Module ownership and contracts

Each module was written against a fixed contract: the exported names and signatures in the design spec (§10).
`tests/unit/contracts.json` lists every expected export with its kind (function, async function, async generator,
class, value) and arity. `tests/unit/contracts.test.js` checks that every `app/` module exists, exports exactly
that, and that `contracts.json` covers every importable module. When you change an exported signature, update
`contracts.json` in the same commit. Extra exports are fine; renames and arity changes are contract changes.

| area | modules |
|---|---|
| Foundations | `app/errors.js`, `config.js`, `types.js`, `util/bytes.js`, `util/stream.js`, `crypto/stealth.js`, `index.html`, `MemoryStore` |
| Crypto | `crypto/kdf.js`, `kdf-worker.js`, `container.js`, `textfmt.js`, `passphrase.js`, `wordlist.js`, `scripts/gen-vectors.mjs` |
| Legacy | `legacy/v4.js`, `mixed.js`, `oldvault.js`, `oldczd.js` |
| UI kit and shell | `theme-boot.js`, `css/app.css`, `css/extras.css`, `assets/`, `util/dom.js`, `util/format.js`, `ui/components.js`, `ui/shell.js`, `ui/easter.js`, `ui/codzilla.js`, `ui/tutorial.js`, `router.js`, `state.js`, `settings.js`, `main.js` |
| Platform and infra | `platform.js`, `pwa.js`, `sw.js`, `scripts/{stage-web,precache,serve,gen-fixtures}.mjs`, `manifest.webmanifest`, `src-tauri/` (base), `.github/workflows/`, `playwright.config.js`, `tests/browser/` harness |
| Storage | `vault/db.js`, `vault/store.js`, `vault/opfs-worker.js` |
| Vault | `vault/vault.js`, `backup.js`, `autolock.js`, `thumbs.js`, `boot.js`, `scripts/gen-backup-vector.mjs` |
| Media | `media/media.js`, `sw-stream.js`, `ui/viewer.js`, `ui/player.js`, `css/viewer.css`, `css/player.css` |
| Desktop native | `src-tauri/src/stream.rs`, the czstream helpers in `platform.js`, `scripts/gen-rust-vectors.mjs` |
| Views | `ui/vault-view.js` + `vault-grid.js` (`vault.css`); `ui/upload.js` + `albums.js` (`upload.css`, `albums.css`); `ui/send-view.js` + `text-view.js` (`send.css`, `text.css`); `ui/legacy-view.js` + `more-view.js` + `settings-view.js` (`legacy.css`, `settings.css`) |

Each CSS file declares only selectors with its own prefix: `.vv-` vault, `.vw-` viewer, `.pl-` player,
`.up-` upload, `.al-` albums, `.sd-` send, `.tx-` text, `.lg-` legacy, `.st-` settings/more/about, and `.cz-`
`.tu-` `.eg-` `.sh-` in `extras.css`. Shared components (`.btn`, `.card`, `.modal`, …) live in `app.css`.

---

## Running locally

You need **Node.js 22** or newer.

```sh
npm ci            # dev tools only: Playwright, the Tauri CLI, fake-indexeddb
npm run serve     # = node scripts/serve.mjs → http://127.0.0.1:4173/
```

Open <http://127.0.0.1:4173/>. The server serves the repository root like Pages does: correct MIME types,
single-range requests, no caching.

- `node scripts/serve.mjs --port 8080` picks another port (`PORT`/`HOST` environment variables work too).
- `node scripts/serve.mjs --base /cZEROdeWEB/` mounts the app under the same sub-path as GitHub Pages.
- `--verbose` logs every request.

`127.0.0.1` and `localhost` count as secure contexts, so the service worker, OPFS and WebCrypto all work there.
Opening the dev server from a phone over the LAN (`http://192.168.…`) is **not** a secure context: the service
worker won't register and parts of the app will refuse to run. Test phones against the Pages site or over HTTPS.

The service worker caches the app. After you edit a file, reload twice, or use DevTools → Application →
Service workers → "Update on reload".

---

## Tests

| what | command | notes |
|---|---|---|
| Unit (Node) | `npm test` (= `npm run test:unit` = `node --test "tests/unit/**/*.test.js"`) | ~650 tests, ~20 s. WebCrypto from Node, IndexedDB from `fake-indexeddb` (a fresh `new IDBFactory()` per test), `MemoryStore`, small Argon2 parameters. |
| One unit file | `node --test tests/unit/container.test.js` | |
| Browser units | `npm run test:browser` | Runs every `tests/browser/<suite>.test.js` in Chromium under the app's CSP (OPFS store, kdf worker, SW streaming, media, UI, vault, legacy). |
| One browser suite | `npx playwright test tests/e2e/browser-units.spec.js -g crypto` | |
| A suite by hand | `npm run serve`, then open `http://127.0.0.1:4173/tests/browser/index.html?suite=crypto` | Results show on the page and in `window.__results`. |
| End-to-end | `npm run test:e2e` (= `npx playwright test`) | ~160 tests, 4–6 min, real Chromium flows (vault, upload, viewer and SW streaming, send/open, text, legacy, settings, PWA). |
| One e2e file | `npx playwright test tests/e2e/send.spec.js` | Add `--headed` or `--debug` to watch. |
| Rust | `npm run stage`, then `cd src-tauri && cargo test` | `stream.rs` against the golden vectors, Range table, tamper cases. The build embeds `dist/`, so stage it first (any `npm run dev`/`build` also does). Needs the Linux system libraries below on Linux. |
| Rust lint | `cd src-tauri && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings` | What CI runs. |

- Playwright starts `scripts/serve.mjs` itself on port 4173, or `CZD_TEST_PORT` if set. It reuses a server that
  is already running there, except on CI.
- Every test gets a fresh browser context.
- Install the browser once with `npx playwright install chromium` (CI uses `--with-deps`).

**Before you commit:**

1. Run `node scripts/precache.mjs` whenever you changed anything that ships: `index.html`, `app/`, `css/`,
   `assets/`, `favicon.ico` or `manifest.webmanifest`.
2. Commit the regenerated `sw-assets.js`.

`node scripts/precache.mjs --check` (CI) fails when it is stale, and so do the unit test `precache.test.js` and
the smoke e2e tests. The service worker refuses files whose hash doesn't match.

### Fixtures and vectors

- `node scripts/gen-fixtures.mjs [--only a,b]` (`npm run fixtures`) rewrites `tests/fixtures/`.
  - Node writes PNG, WAV, PDF, text, the folder tree and the legacy `.czd`.
  - Playwright's Chromium and its bundled ffmpeg write the large JPEG and the VP8/Opus WebM files. Set `FFMPEG=`
    to use another ffmpeg.
  - No H.264, AAC or MP3: the app must not depend on them.
- Golden vectors (`tests/vectors/`) and how to regenerate them: [FORMAT.md §10](FORMAT.md#10-golden-vectors).
  - `node scripts/gen-vectors.mjs` (`npm run vectors`), `--big <dir>` for the 17 MB case.
  - `node scripts/gen-rust-vectors.mjs`.
  - `node scripts/gen-backup-vector.mjs [--out <dir>]`.

  **Regenerating a committed vector requires a dated note in [FORMAT.md §12](FORMAT.md#12-vector-history).** The
  czd2 and Rust generators use random keys, so they rewrite every file they own. The backup generator is
  deterministic.
- `tests/vectors/czd2/rust-ranges.json` is the Range contract shared by `sw-stream.js` and `stream.rs`. If you
  change the Range rules, update that table, `tests/unit/tauri-stream-vectors.test.js` (it checks `sw-stream.js`)
  and run `cargo test`.

---

## Desktop app (Tauri 2)

### Prerequisites

You need everything from [Running locally](#running-locally) plus Rust **1.90 or newer** (`rustup`, stable). Then,
per OS (see also Tauri's prerequisites guide, <https://v2.tauri.app/start/prerequisites/>):

| OS | install |
|---|---|
| Windows | Microsoft C++ Build Tools ("Desktop development with C++"); the WebView2 runtime (preinstalled on Windows 10/11); Rust with the MSVC toolchain |
| macOS | Xcode Command Line Tools (`xcode-select --install`). The app needs macOS 12 or newer. |
| Linux (Debian/Ubuntu) | `sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev` (enough for `cargo test` and a debug build); add `libappindicator3-dev patchelf` to bundle `.deb`/AppImage; `gstreamer1.0-plugins-good gstreamer1.0-libav` to play media |

### Commands

```sh
npm run dev                            # = tauri dev: stages the web app into dist/, builds, opens the app
npm run stage:watch                    # (2nd terminal) re-copies changed web files into dist/ while `npm run dev` runs
npm run build                          # = tauri build: release build + installers for this OS
npm run build -- --debug --no-bundle   # quick debug build, no installer (src-tauri/target/debug/czeroode)
npm run icons                          # = tauri icon src-tauri/icons/source.png → src-tauri/icons/*
```

- `tauri.conf.json` runs `node scripts/stage-web.mjs` before every dev and release build. It copies an allowlist
  (`index.html`, `app/`, `css/`, `assets/`, `favicon.ico`, `manifest.webmanifest`) into `dist/`. The service
  worker files are not staged, because the desktop app never registers a service worker.
- Release installers land in `src-tauri/target/release/bundle/` (`nsis/` on Windows, `deb/` and `appimage/` on
  Linux, `macos/` and `dmg/` on macOS).
- `npm run icons` regenerates the desktop icons from `src-tauri/icons/source.png` (256 px today; a 1024 px
  source looks better). It also writes `android/` and `ios/` folders that the desktop build doesn't use, so delete
  them. The PWA icons in `assets/icons/` are separate files.
- The build warns that the identifier `com.czeroode.app` ends with `.app`. That is deliberate: it is cZEROde 1's
  identifier, so the new app finds the old desktop vault in the same app-data folder (`$APPDATA/vault/*.czd`).
  Don't change it.
- Desktop specifics live in `src-tauri/`:
  - `capabilities/default.json`: dialogs; fs limited to `$APPDATA/vault2/**`, plus read-only access (`exists`,
    `stat`, `read-dir`, `read-file` command scopes) to the old `$APPDATA/vault/**`; the opener limited to the
    releases URL.
  - `.czd`/`.czb` file associations.
  - `tauri.linux.conf.json` sets the product name to `czeroode` on Linux only: Tauri names the Debian package after
    the product name in kebab case (`cZEROde` would become `c-zer-ode`), so the package, the `.deb`/AppImage file
    names and the `.desktop` file match the `czeroode` binary. The menu entry still says cZEROde
    (`linux/czeroode.desktop` hardcodes `Name=`), and Windows/macOS keep the product name `cZEROde`.
  - Single instance, with files forwarded from argv and macOS `Opened`.
  - The `czstream` protocol (`src/stream.rs`). It is refused on Linux, where previews use the in-memory path; see
    [FORMAT.md §9.3](FORMAT.md#93-desktop-czstream-protocol). Debug builds take `CZSTREAM_LINUX=1` and
    `CZSTREAM_WINDOW=<bytes>` for smoke tests.

---

## CI and releases

**`.github/workflows/ci.yml`** runs on pushes to `main`, on pull requests and by hand:

- `web` job (Ubuntu, Node 22): `npm ci`, `node scripts/precache.mjs --check`, unit tests,
  `npx playwright install --with-deps chromium`, then all Playwright tests (browser units + e2e). On failure it
  uploads the Playwright report.
- `rust` job: WebKitGTK libraries, stable Rust with clippy/rustfmt, stage the web app, then `cargo fmt --check`,
  `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --locked`.

**`.github/workflows/desktop.yml`** builds the installers with `tauri-action`. It runs on pushes to `main`
(except Markdown-only changes), on tags `v*`, on pull requests that touch `src-tauri/`, `scripts/` or
`package*.json`, and by hand (Actions → Desktop build → Run workflow).

Workflow hygiene (checked by `tests/unit/security-audit.test.js`): every `uses:` is pinned to a full commit SHA
with the tag in a comment (to update one, look up the new tag's commit with `git ls-remote --tags <repo>`), every
checkout sets `persist-credentials: false`, and the build step gets the repository-write `GITHUB_TOKEN` only on
`v*` tags. The build runs the build scripts of every npm and Cargo dependency; a branch or pull-request build must
never hold a token that could push to `main`, which GitHub Pages serves to every user.

| platform | bundles | required? |
|---|---|---|
| Windows (`windows-latest`) | NSIS `.exe` (per-user install) | yes |
| Linux (`ubuntu-22.04`) | `.deb`, AppImage | best effort |
| macOS (`macos-latest`, Apple silicon) | `.app`, `.dmg` | best effort |

**Getting installers from a run:**

1. Open the repository → Actions → "Desktop build" → a green run.
2. Scroll to **Artifacts** and download `cZEROde-<platform>-<arch>-<bundle>` (a zip; you must be signed in to
   GitHub).

**Releasing:**

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `app/config.js` (`VERSION`), and refresh
   `Cargo.lock` with a `cargo build`. `tauri.conf.json` reads `package.json`, and unit tests check that
   `package.json` and `config.js` agree.
2. Run `node scripts/precache.mjs` and commit.
3. Tag and push:

   ```sh
   git tag v2.0.1
   git push origin v2.0.1
   ```

The workflow creates a draft GitHub Release with generated notes and uploads every installer to it. It publishes
the release once the builds are done, as long as the required Windows build succeeded. If that build fails, the
release stays a draft. "Get the latest version" in the app opens
`https://github.com/yuniorrguez13-a11y/cZEROdeWEB/releases`.

The installers are not code-signed (the README explains the SmartScreen and Gatekeeper steps). There is no
auto-updater.

---

## GitHub Pages

- **Source:** Settings → Pages → "Deploy from a branch", branch `main`, folder `/ (root)`. Pages publishes the
  repository exactly as committed. Whatever is on `main` is live within a minute or two, so `main` must always
  have a fresh `sw-assets.js`.
- **`.nojekyll`** at the root turns off Jekyll, so every file is served as-is. Without it, files and folders
  starting with `_` would be dropped.
- **Everything in the repository is public on that origin,** including `tests/`, `scripts/` and `docs/`. Nothing
  outside the precache list is used by the app. Any HTML page under `tests/` that touches storage (the browser-unit
  runner, `tests/e2e/seed.html`) runs on the **real** origin if someone opens it there, and it would delete or
  overwrite real vault or cZEROde 1 data. Such pages must refuse to run anywhere but `localhost`/`127.0.0.1`.
  Never add a page that does not.
- **NEVER publish another GitHub Pages project from this account.** That includes the old `cZEROde` repository and
  any `<user>.github.io` site. Every Pages site of the account shares the origin
  `https://yuniorrguez13-a11y.github.io`. Any page published there (or a bug in one) could replace cZEROde's
  cached code, steal passphrases at the next unlock, and read, replace or delete vault data. See
  [SECURITY.md](../SECURITY.md#the-web-version-shares-its-address).
- **Moving to a custom domain later:** the new domain is a new origin with empty storage. Users move with
  Export backup on the old site, then Restore on the new one. Keep the old site up until they have.

---

## Vendored files

| file | source | licence | integrity |
|---|---|---|---|
| `app/crypto/argon2.umd.min.js` | npm `hash-wasm` 4.12.0, `dist/argon2.umd.min.js` | MIT (`app/crypto/LICENSE-hash-wasm.txt`) | sha256 `dcec617a2e1b700fa132d1583a186cb70611113395e869f2dd6cc82b415d3094`, asserted by `tests/unit/kdf.test.js`; an Argon2id known-answer test cross-checked with @noble/hashes |
| `app/crypto/wordlist.js` | npm `@scure/bip39` 2.4.0, `wordlists/english.js` (the standard BIP-0039 English list, 2048 words) | MIT (in the file header) | sha256 of the words joined by `\n`: `187db04a869dd9bc7be80d21a86497d692c0db6abd3aa8cb6be5d618ff757fae` |
| `assets/fonts/*.woff2` | Fontsource 5.3.0: `@fontsource/unifrakturmaguntia`, `rajdhani`, `dm-sans`, `noto-sans-georgian`, `noto-sans` (Cyrillic subset only); unmodified subsets | SIL OFL 1.1 (`assets/fonts/OFL.txt`, with each font's copyright) | below |

Font sha256 sums:

```
a467466874b50cd9ffbe10e5caccd9b261f2bc2252bcfa7d160c744ed9da6f15  unifrakturmaguntia-latin-400-normal.woff2
759a9000e47b028799d7a4ca602634a7ac7adf415775df070a335d18d9b66f38  rajdhani-latin-400-normal.woff2
23afdb9b5b89b878fab04d80cc30bf41bb4f3f7e8be88e5f16a7cc7671cdb2dc  rajdhani-latin-500-normal.woff2
433a7007e4747a02a790167a6efa2625855f013970ba49b9b739a5d3db8b2601  rajdhani-latin-600-normal.woff2
5b7e4a6f97163c2636724d4de90304fc895653dcfe64c67a7a22f26331ca5c5f  rajdhani-latin-700-normal.woff2
90721cae01bf677b419b28fec9896e50923c9e956817b85f4b6ab1e5ad028a56  rajdhani-latin-ext-400-normal.woff2
16fd373954f7569ad294444531caa2e7e5ffd1a6798c6df3f56b9faf691190c2  rajdhani-latin-ext-500-normal.woff2
f57c2b379ba92460d25730ef1f7b8745afb4eadb401d652900f2059f8ee2f2b6  rajdhani-latin-ext-600-normal.woff2
c6b9df58743ccca1236e9521720b135138309bc4149d5d027a9bd10183cc8ed5  rajdhani-latin-ext-700-normal.woff2
80f13c410ec41f210a5553e7f420f8a51f459180019274df0b3faea314916f90  dm-sans-latin-300-normal.woff2
4ab51eb2cd7305d177187908d6397474d4520663f6c6e572feb0a64f4fa80006  dm-sans-latin-400-normal.woff2
19bf1984956517c35c2bd35b6cdedac12a21d6fcd3596c614ecdfb88b648909d  dm-sans-latin-500-normal.woff2
6bb2b2645ba5eeaecf56322c543fa3a75b87b927977b9c03b1dabc4205089120  dm-sans-latin-600-normal.woff2
d45c7f5d73861db15ec16ba6c4a5e29fda548b32d382165a4afe3f9034ca13e2  dm-sans-latin-ext-300-normal.woff2
962730c6ff7595f9499b0d963a3bccb2139d793f0fb31fbd87aed1881c020e0a  dm-sans-latin-ext-400-normal.woff2
e0a1d21584ba00798a3dbe90ef5f8a162741d454f52ab66630f9dc41da372b3d  dm-sans-latin-ext-500-normal.woff2
6406eb05e2eb50779cb95ee8745c98ad23cce7e67d752822782453da7f6b4491  dm-sans-latin-ext-600-normal.woff2
d33ac947d1a2c4c608bfa76cbbad7f6a48d20fe22e4e88cdcb511a975c86fa99  noto-sans-georgian-georgian-400-normal.woff2
05af9e705d3b63aedba67197d19fb448b97353e1386930716c7e835b08f126ba  noto-sans-cyrillic-400-normal.woff2
```

To update a vendored file:

1. Copy it from the named npm package version without changes, together with its licence.
2. Update the hashes here and in the test that pins them.
3. Run `node scripts/precache.mjs`.
