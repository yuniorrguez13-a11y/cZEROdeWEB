# cZEROde · Web Edition

Encrypt text and files so they look like exotic Georgian & Cyrillic script. Everything runs entirely in your browser — no servers, no accounts, no data ever leaves your device.

---

## What It Is

cZEROde is a single-file, zero-dependency encryption tool. Encrypted text looks like random Georgian script (`ძღვევ ბჰიკლ`) so it doesn't even read as ciphertext to someone glancing at it.

**Text encryption** — type a message, set a PIN, get back exotic-looking ciphertext you can paste anywhere. Paste it back with the same PIN to recover the original.

**File encryption** — encrypt any file (images, audio, video, PDFs, anything). Files are stored encrypted in your browser's IndexedDB. Decrypt and play/view them inline without downloading first.

**Playlists** — group encrypted audio (up to 50 songs) or video (up to 10 clips) into playlists. Enter your PIN once to decrypt and play the whole queue in sequence.

**Spotdown tab** — quick-launch shortcut to spotdown.org for grabbing Spotify tracks.

---

## Encryption

| | |
|---|---|
| Algorithm | AES-256-GCM |
| Key derivation | PBKDF2-SHA256 · 100,000 iterations |
| Salt | 16 bytes · random per encryption |
| IV | 12 bytes · random per encryption |
| Ciphertext encoding | Base64 → Georgian/Cyrillic character substitution |
| Storage | Browser IndexedDB · local only |

Files ≥ 15 MB are split into 5 MB chunks and encrypted in batches with a live progress bar.

**Your PIN is never stored anywhere. If you lose it, the data is gone.**

---

## Versions

| | Name | Notes |
|---|---|---|
| v4 | cZEROde | AES-256-GCM · use this one |
| v3 | Mixed Script v3 | PIN-locked · Vigenère + shuffled alphabet · uncracked |
| v2 | Mixed Script v2 | 5 scramble methods · cracked by AI in ~30s 💀 |
| v1 | Mixed Script v1 | The original · visual only, no real encryption |
| ? | projerct codzilla | Quantum-resistant™ (prank) |

---

## Privacy & Security

- Nothing is ever uploaded. All encryption and storage happens locally in your browser.
- Encrypted data lives in IndexedDB and persists across reloads — but only on your device.
- Clearing browser site data will permanently delete your vault.
- There is exponential backoff on failed decryption attempts to slow down in-session brute force.
- Clipboard is auto-cleared 30 seconds after copying ciphertext.
- The Georgian/Cyrillic substitution is cosmetic obfuscation. The actual security is AES-256-GCM.

---

## Browser Support

Any modern browser with Web Crypto API + IndexedDB support — Chrome, Firefox, Edge, Safari 15+, mobile included. Not IE.
