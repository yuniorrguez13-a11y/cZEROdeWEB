# Security

This page explains what cZEROde protects and what it doesn't. The first part is in plain language. The
technical summary comes after it, and the exact byte formats are in [docs/FORMAT.md](docs/FORMAT.md).

cZEROde has no accounts, no servers and no analytics, and it makes no network requests. Your files, keys and
passphrases never leave your device unless you send a `.czd` file yourself.

---

## In plain language

### What cZEROde protects

- **Your vault, at rest.** Photos, videos, music, documents and notes are encrypted with AES-256-GCM, each with
  its own random key. Names, types and sizes are encrypted too, and sizes are padded. Changes, swapped files and
  files cut short are detected; cZEROde refuses to show them.
- **Files you send.** A `.czd` is locked with a passphrase through Argon2id (64 MiB of memory per guess), and its
  contents are authenticated. Its header commits to the key, so a wrong passphrase can never open it into
  garbage: it just says "Wrong passphrase".
- **Secret messages.** Text messages use Argon2id + AES-GCM with key commitment. The Georgian/Cyrillic look is
  camouflage only. The passphrase is what protects the message.
- **Backups.** A `.czb` backup is your vault as it is, still encrypted, and authenticated as a whole. It opens
  with your passphrase or your recovery code.

### What it does NOT protect against

- **Weak passphrases.** cZEROde estimates strength and warns you, but a guessable passphrase can be guessed, and
  anyone holding a copy of your `.czd`, vault or backup can try as many times as they like. Use the generated
  passphrases (5 or 6 random words) when you can.
- **Malware and keyloggers.** Anything that can watch your screen or keyboard can watch you unlock.
- **Someone using your unlocked device.** While the vault is open, whoever holds the device sees what you see.
  Auto-lock helps; it isn't magic.
- **The browser and the operating system.** cZEROde runs inside them and has to trust them.
- **Whoever controls the code delivery.** The GitHub repository, GitHub Pages and the installers deliver the
  app. If any of them is compromised, so is the app (see [Code delivery](#code-delivery-and-trust)).
- **Metadata.** Someone with access to your device or files can see:
  - how many items you have and roughly how big they are;
  - when they were written;
  - that a file is a cZEROde file.

### Things you should know

- Previews are decrypted in memory. The browser may swap very large previews to its own temporary files.
- Deleting removes data from the app, but the browser may keep old copies on disk until it compacts its
  storage. The cZEROde 1 web vault also stored names and PIN lengths in plain text.
- Changing your passphrase doesn't revoke the old one from anyone who already has a copy of your vault or a
  backup. In the app's words: "This changes what unlocks the vault on this device. If someone may know your old
  passphrase AND has a copy of your vault or a backup, changing it is not enough — they could still open what they
  copied."
- Your recovery code opens your vault, and every backup made while that code was active, without the passphrase.
  Keep it away from the device.
- The camouflage script is cosmetic. The protection is the passphrase.
- Old Mixed Script v1–v3 were never encryption, and v4 used a weak PIN key. Re-encrypt anything important in the
  new vault.
- Each browser and each app install has its own vault. Move it with a backup (`.czb`), or send files to
  yourself as a `.czd` and add them to the other vault.
- Uninstalling the app or clearing the site's data deletes the vault. Only a `.czb` backup survives that.
- "Locking drops keys and clears the screen; JavaScript can't guarantee every secret is wiped from memory."
- When you copy a secret, cZEROde tries to clear the clipboard after 30 s (adjustable), but only while it's the
  app in front. Clipboard history apps may keep a copy.

---

## The web version shares its address

The web app lives at `https://yuniorrguez13-a11y.github.io/cZEROdeWEB/`. Browsers isolate sites by
**origin** (scheme + host), not by path, and every GitHub Pages project of an account shares one origin:

> Every GitHub Pages site of this account shares https://yuniorrguez13-a11y.github.io. Any page published there
> (or a bug in one) can take over cZEROde web: replace its cached code so your passphrase is stolen at the next
> unlock, control an open cZEROde tab, and read, replace or delete vault data. Never publish another GitHub
> Pages project from this account. The desktop app is not affected.

This is why the repository's developer guide forbids publishing any other Pages project from this account.

**Roadmap:** move cZEROde web to its own domain. Your data can't follow automatically, because the new domain is
a new origin with empty storage. Moving will mean exporting a `.czb` backup on the old site and restoring it on
the new one.

---

## Code delivery and trust

cZEROde is a static app: the code you run is the code in this repository, delivered by GitHub.

- **Web.**
  - GitHub Pages serves the repository's files as-is (no build step).
  - The service worker caches every app file and checks each one against a SHA-256 list (`sw-assets.js`) once
    per worker lifetime. A changed cached file is fetched again and verified, and if it still doesn't match it is
    refused. This protects against a corrupted or tampered cache. It **does not** protect against a malicious
    change to the repository or to Pages, because the hash list comes from the same place as the code.
  - New versions download in the background, and the app shows "Update ready". The new code is applied only when
    you choose to reload, and never while the vault is unlocked or a job is running.
- **Desktop.**
  - Installers are built by GitHub Actions from this repository (`.github/workflows/desktop.yml`) and published
    as workflow artifacts and GitHub Releases.
  - They are **not code-signed**, so Windows SmartScreen and macOS Gatekeeper warn about them. Download them
    only from `https://github.com/yuniorrguez13-a11y/cZEROdeWEB/releases` or from this repository's Actions runs.
  - There is no auto-updater. "Get the latest version" only opens the releases page.
- **Third-party code.** cZEROde has no runtime npm dependencies. The only vendored code is the hash-wasm Argon2
  build, whose SHA-256 a unit test pins. The BIP39 word list and the fonts are vendored too, all with their
  licences (see [docs/DEVELOPING.md](docs/DEVELOPING.md#vendored-files)).
- **Content Security Policy.** Scripts, styles, fonts, workers and connections are `'self'` only, plus
  `wasm-unsafe-eval` for Argon2 and the desktop IPC/stream endpoints. There are no inline scripts or styles and
  no `eval`, and a unit test greps the code for HTML-injection sinks. Framed pages refuse to start.

---

## Desktop vs web

| | Web (browser or installed PWA) | Desktop (Windows, macOS, Linux) |
|---|---|---|
| Origin | `https://yuniorrguez13-a11y.github.io`, shared with every Pages site of the account | the app's own (`tauri://localhost` / `https://tauri.localhost`): **not** affected by the Pages warning |
| Where the vault lives | IndexedDB + the origin private file system of that browser profile | `<app data>/com.czeroode.app/vault2/` (containers + an `index.json` mirror of the encrypted index) plus the webview's IndexedDB |
| Can the browser delete it? | Yes, under storage pressure unless "Keep my data" (persistent storage) is granted; Safari can erase a vault in a Safari **tab** after 7 days without use (install the app first on iPhone/iPad) | No; uninstalling may |
| Big video playback | streamed through the service worker, decrypted chunk by chunk | streamed from disk by the `czstream` protocol (Windows, macOS); **Linux** decrypts previews in memory up to 512 MB |
| File access | only files you pick | files you pick plus its own `vault2` folder and the old cZEROde 1 `vault` folder (read only by convention) |
| Updates | service worker, applied on your tap | download a new installer from Releases |
| Code signing | HTTPS from GitHub Pages | none (SmartScreen / Gatekeeper warnings) |

---

## Technical summary

### Keys and passphrases

- **KDF:** Argon2id v1.3 (vendored hash-wasm 4.12.0), 32-byte output.
  - Default `m = 64 MiB, t = 3, p = 1`.
  - On devices that run out of memory, and only after you agree: `m = 19 MiB, t = 2, p = 1` (weaker).
  - A file can't make cZEROde run Argon2 with arbitrary parameters. Above 2× the default cost cZEROde asks first;
    above 16× (or more than 1 GiB) it refuses. Each derivation runs in a fresh worker.
- **Passphrase canonicalization:** Unicode NFC, outer whitespace trimmed and inner whitespace runs collapsed to one
  space, then UTF-8. Capitals matter.
- **Generated passphrases:** BIP39 English words. 5 words (55 bits) for the vault, 6 words (66 bits) for Send and
  Text. Typed passphrases get an estimate, and the vault requires at least 10 characters and an estimated
  45 bits.
- **Key hierarchy:**
  - A random 256-bit vault master key (VMK) is wrapped with AES-256-GCM under the passphrase key, and optionally
    a second time under the recovery code (160 random bits).
  - HKDF-SHA256 of the VMK gives the item-wrapping key, the index key and the backup MAC key.
  - An unlocked vault holds the VMK only as a non-extractable WebCrypto key. Unlocking uses `unwrapKey`, so the
    raw bytes never reach JavaScript then. Creating the vault, changing the passphrase and making a recovery code
    handle the raw bytes briefly and zero-fill them afterwards.
- **Per-file keys:**
  - Every vault item and every `.czd` has its own random 256-bit file key, wrapped by its stanza: the vault
    stanza binds the vault id and item id, the passphrase stanza holds Argon2id parameters and a salt.
  - HKDF-SHA256 of the file key gives three 32-byte subkeys: a header MAC key, a metadata key and a payload key.

### Containers (`.czd`, vault items)

- **Header:** HMAC-SHA256 over the whole header, stanzas included, verified before anything else is decrypted.
  This is the key commitment: a wrong key or a swapped stanza fails here.
- **Metadata:** name, type, size, dates and the bundle entry list, all AES-256-GCM encrypted and padded to
  256-byte steps.
- **Payload:** AES-256-GCM in 256 KiB chunks (the STREAM construction). Each nonce holds the chunk counter and
  a final-chunk flag, so reordering, truncation and appended data are detected. The plaintext is padded to the
  Padmé length, which leaks at most O(log log size) bits of the size.
- **Freshness:** every write uses a fresh file key and salts. Edits and imports create a new container; nothing is
  re-encrypted in place.
- **Vault index:** item names, types, sizes, dates, favourites and albums are AES-256-GCM records. Each record's
  AAD binds its kind and id. Each item's index record stores its container's header MAC, so a container swapped
  on disk is detected (`item-tampered`).
- **Thumbnails:** encrypted with the index key.

### Text messages

Argon2id (fresh salt per message) → HKDF → AES-256-GCM key + a 128-bit key commitment that is checked before
decryption. The plaintext is padded to a multiple of 16 bytes. The result is written in a Georgian/Cyrillic alphabet behind
the marker `ჶ`.

### Backups

A `.czb` holds:

- the wrapped vault key (passphrase and recovery wraps);
- every encrypted index record, each with its SHA-256;
- every container verbatim, each with its header MAC.

The whole table is authenticated with HMAC-SHA256 under a key derived from the vault key. Restoring verifies
everything before anything becomes visible. Merging from another vault re-encrypts every item into fresh
containers.

### What is visible without the passphrase

| what | visible to someone who has… |
|---|---|
| that a file is a cZEROde `.czd` / `.czb` (magic bytes) | the file |
| Argon2 parameters and salt, the number and kind of stanzas | the file |
| the padded size (and so the size within a few %), the metadata length in 256-byte steps | the file |
| the number of items and albums, each item's stored size, write times, the lengths of encrypted index records (which hint at name lengths), the vault's KDF settings, whether a recovery code exists | the device's storage (or a backup) |
| device-local settings, banner dismissals, which cZEROde 1 items were imported (ids only) | the device's storage |
| **not** visible: file names, types, exact sizes, dates, album names, notes, thumbnails, contents | — |

### Legacy data (cZEROde 1)

cZEROde 2 can read the old formats but never writes them.

| format | why it is weak |
|---|---|
| Mixed Script v1–v3 | letter substitution, no real encryption |
| v4 text and files | AES-256-GCM, but the key is PBKDF2-SHA256 with 100,000 iterations over a short PIN, so PINs are cheap to guess |
| old web vault | stored names, sizes, dates and PIN lengths in plain text |

Old data is never deleted automatically. The Legacy page offers to import it into the new vault and then delete
it.

---

## Known limitations

- **Memory wiping is best effort.** cZEROde keeps keys non-extractable where WebCrypto allows it, zero-fills raw
  key bytes it holds, and drops every key, decrypted preview, object URL and text field on lock. JavaScript
  strings (passphrases, decrypted notes) cannot be wiped, and garbage collection decides when copies disappear.
  The desktop stream reader (Rust) zeroizes its keys and buffers, but the copy of the file key that passes
  through Tauri's IPC cannot be wiped.
- **Browser paging.** Previews that use the in-memory path, and very large Blobs, can be paged to the browser's
  temporary files by the browser itself. The service-worker streaming path keeps only the chunks it is playing.
- **Linux desktop media.** WebKitGTK cannot play media from the app's `czstream` protocol, so on Linux audio and
  video previews are decrypted into memory (up to 512 MB). Bigger files: use "Save decrypted copy" and your own
  player.
- **Deleted data can linger** in the browser's storage files, or on SSDs, until the browser or OS reuses the
  space. cZEROde cannot securely erase storage.
- **Storage eviction (web).** Browsers can clear site data. Ask for persistent storage ("Keep my data"),
  install the app, and keep `.czb` backups.
- **Lower-memory vaults.** A vault created with the low-memory parameters stays that way. There is no automatic
  upgrade and no vault key rotation in 2.0.
- **Shared-origin risk (web)**, see [above](#the-web-version-shares-its-address).
- **Unsigned installers**, see [Code delivery](#code-delivery-and-trust).
- **Legacy formats are weak**, see [Legacy data](#legacy-data-czerode-1).

---

## Reporting a vulnerability

Please report security problems on GitHub, at
[github.com/yuniorrguez13-a11y/cZEROdeWEB/issues](https://github.com/yuniorrguez13-a11y/cZEROdeWEB/issues):

- Open an issue with **`[security]`** at the start of the title.
- If the details could put users at risk before a fix ships, don't post them publicly. Do one of these instead:
  - use the repository's private vulnerability reporting (Security tab → "Report a vulnerability"), if it is
    turned on;
  - or open an issue that only says you have a security report, and ask the repository owner how to send the
    details privately.

Please include the version (More → About, or the desktop installer's version), the platform and browser, and
steps to reproduce. Test only against your own data and devices.
