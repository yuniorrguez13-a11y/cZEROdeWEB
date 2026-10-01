# cZEROde file and storage formats

This document specifies every byte cZEROde 2.0 writes or reads. It is normative: it describes what the code does
today. When this document and the code disagree, that is a bug in one of them, and the golden vectors in
`tests/vectors/` decide which one.

| Format | Where it is implemented |
|---|---|
| Passphrase canonicalization, Argon2id, parameter bounds | `app/crypto/kdf.js` |
| czd2 container, FORMAT v2 (vault items and `.czd` files) | `app/crypto/container.js` |
| Text v2 (camouflage messages) | `app/crypto/textfmt.js`, `app/crypto/stealth.js` |
| Vault key model and IndexedDB records | `app/vault/vault.js`, `app/vault/db.js`, `app/vault/store.js` |
| Desktop index mirror (`index.json`) | `app/vault/db.js` (snapshot), `app/vault/boot.js` (mirror) |
| Backup `.czb` v1 | `app/vault/backup.js` |
| Streaming Range semantics | `sw-stream.js` (web), `src-tauri/src/stream.rs` (desktop) |
| Legacy formats (decode only) | `app/crypto/stealth.js`, `app/legacy/*.js` |

Contents:

1. [Conventions](#1-conventions)
2. [Passphrases and the KDF](#2-passphrases-and-the-kdf)
3. [czd2 container (FORMAT v2)](#3-czd2-container-format-v2)
4. [Text format v2](#4-text-format-v2)
5. [The stealth alphabet](#5-the-stealth-alphabet)
6. [Vault storage](#6-vault-storage)
7. [Desktop index mirror](#7-desktop-index-mirror-indexjson)
8. [Backup `.czb` v1](#8-backup-czb-v1)
9. [Streaming and Range semantics](#9-streaming-and-range-semantics)
10. [Golden vectors](#10-golden-vectors)
11. [Legacy formats (decode only)](#11-legacy-formats-decode-only)
12. [Vector history](#12-vector-history)

---

## 1. Conventions

- Integers are **unsigned big-endian**: `u8`, `u16`, `u32`, `u64`. Every length a reader accepts is also a
  JavaScript safe integer (≤ 2^53 − 1).
- `ASCII("…")` is the ASCII bytes of the string, with no terminator. `‖` is concatenation. `∅` is an empty byte
  string.
- **AES-256-GCM** always uses a 12-byte nonce and a 16-byte tag appended to the ciphertext (the WebCrypto
  layout: `ciphertext ‖ tag`). "aad = ∅" means no additional data.
- **HKDF** is HKDF-SHA256 (RFC 5869). Every HKDF output in this document is **32 bytes** unless a length is
  stated. That includes HMAC keys: WebCrypto would otherwise derive a 64-byte HMAC-SHA256 key, so readers in
  other languages must use 32.
- **Ids** are 16 random bytes. IndexedDB keys and file names use them as 32 lowercase hex characters. AADs use
  the raw 16 bytes.
- JSON is UTF-8 without a BOM.
- Readers report bad data only as `CzdError(code)` with a code from `app/errors.js` (`CODES`). Programming
  errors (a missing argument, an out-of-range `decryptRange` call) are `TypeError`/`RangeError`.

---

## 2. Passphrases and the KDF

### 2.1 Canonical passphrase bytes

Every format that cZEROde 2 writes (vault, czd2 passphrase stanzas, text v2) hashes the passphrase as:

```
passphraseBytes(s) = UTF-8( s.normalize('NFC').trim().replace(/\s+/gu, ' ') )
```

`trim()` and `\s` are the ECMAScript whitespace and line-terminator sets. So `"  Tést  phrase "` typed with a
decomposed `é` and `"Tést phrase"` are the same passphrase. Capital letters still matter. An empty result is
never accepted: writers throw `TypeError`, readers answer `wrong-passphrase` without running Argon2.

Recovery codes are not passphrases (§6.1). Legacy PINs are used exactly as typed (§11.1).

### 2.2 Argon2id

- **Argon2id, version 1.3** (RFC 9106), 32-byte output. KDF id `1` is the only one defined.
- Parameters: `m` = memory in KiB, `t` = passes, `p` = lanes.
- `POLICY = {m: 65536, t: 3, p: 1}` (64 MiB). Every new vault, `.czd` and message uses it.
- `FLOOR = {m: 19456, t: 2, p: 1}` (19 MiB). Used only after a real out-of-memory error, when the user agrees
  ("Low memory: use lighter protection?"). What carries the parameters:
  - a vault created this way has `floor: true` (and FLOOR in its `kdf`);
  - a `.czd` carries them in its passphrase stanza;
  - a text message made with FLOOR uses preset 2.
- There is no automatic parameter upgrade.

### 2.3 Parameter bounds and cost gating

A reader takes the parameters from the file, so it checks them before it runs anything (`checkParams`):

```
valid   ⇔ m, t, p integers, 1 ≤ p ≤ 8, m ≥ 8·p, m ≤ 1,048,576 (1 GiB), 1 ≤ t ≤ 16
cost    = m · t
'ok'      if m ≤ 131,072 and cost ≤ 393,216          (up to 2 × POLICY)
'confirm' if cost ≤ 3,145,728                         (up to 16 × POLICY)
otherwise → CzdError('kdf-params-out-of-range')
```

- An invalid parameter set is also `kdf-params-out-of-range`.
- `'confirm'` means the app asks first, for example "This file needs ~N MiB and ~T s to unlock. Continue?".
  Declining is `kdf-declined`. A caller that gives no confirmation callback gets `kdf-params-out-of-range`.
- A failed memory allocation inside Argon2 is `kdf-out-of-memory`.

---

## 3. czd2 container (FORMAT v2)

One container holds one file (or one bundle of files). The same format is used for vault items on disk and for
`.czd` files people send each other. A random 32-byte **fileKey** per container is wrapped by one or more
**stanzas**. HKDF subkeys of the fileKey authenticate the header, encrypt the metadata and encrypt the payload.

### 3.1 Layout

```
offset  size     field
0       8        magic          89 43 5A 44 0D 0A 1A 0A   ("\x89CZD\r\n\x1a\n")
8       1        version        0x02
9       1        flags          0x00
10      1        chunkExp e     12..24 (cZEROde writes 18: 256 KiB chunks)
11      1        stanzaCount k  1..4
12      16       streamSalt     random per container
28      …        k × stanza     type u8 | bodyLen u16 | body[bodyLen]
…       12       metaNonce      random per container
…       4        metaLen u32    (metaLen − 16) mod 256 = 0, 272 ≤ metaLen ≤ 1,048,592 (1 MiB + 16)
…       metaLen  metaCT         AES-256-GCM(metaKey, metaNonce, metaPT, aad = ∅)
…       32       headerMAC      HMAC-SHA256(macKey, every header byte before this field)
…       …        payload        n encrypted chunks (§3.6)

headerLen = 28 + Σ(3 + bodyLen) + 16 + metaLen + 32
```

With one passphrase stanza and the smallest metadata, `headerLen = 437`. With one vault stanza it is 443.

### 3.2 Stanzas

| type | name | bodyLen | used by |
|---|---|---|---|
| `0x01` | passphrase | exactly 86 | `.czd` files made with Send |
| `0x02` | vault | exactly 92 | vault items |
| other | unknown | ≤ 1024 | skipped by readers (forward compatibility) |

Counts: at least 1 and at most 4 stanzas, of which at most 2 passphrase stanzas and at most 1 vault stanza.

**Passphrase stanza body (86 bytes):**

```
0   1   kdfId     1 = Argon2id v1.3
1   4   m u32     KiB
5   4   t u32
9   1   p u8
10  16  salt
26  12  wrapNonce
38  48  wrapped   = AES-256-GCM(KEK, wrapNonce, fileKey, aad = ASCII("cZEROde czd2 pass"))

KEK = Argon2id(passphraseBytes(passphrase), salt, m, t, p) → 32 bytes, used as an AES-256-GCM key
```

**Vault stanza body (92 bytes):**

```
0   16  vaultId
16  16  itemId
32  12  wrapNonce
44  48  wrapped   = AES-256-GCM(itemWrapKey, wrapNonce, fileKey, aad = ASCII("cZEROde czd2 vault") ‖ vaultId ‖ itemId)
```

`itemWrapKey` comes from the vault master key (§6.1). Binding `vaultId` and `itemId` into the AAD means a
container moved to another item id, or into another vault, does not open.

### 3.3 Subkeys

```
macKey  = HKDF-SHA256(ikm = fileKey, salt = streamSalt, info = ASCII("cZEROde czd2 header mac"))   HMAC-SHA256 key
metaKey = HKDF-SHA256(ikm = fileKey, salt = streamSalt, info = ASCII("cZEROde czd2 meta"))         AES-256-GCM key
payKey  = HKDF-SHA256(ikm = fileKey, salt = streamSalt, info = ASCII("cZEROde czd2 payload"))      AES-256-GCM key
```

All three are 32 bytes. The header MAC is verified before the metadata is decrypted. It covers the stanzas,
so it commits the container to its fileKey: a wrong key can never open it into garbage. It also covers
`chunkExp` and `streamSalt`.

### 3.4 Metadata

```
metaPT  = jsonLen u32 ‖ UTF-8 JSON (jsonLen bytes) ‖ zero bytes up to a multiple of 256
          (writer: |metaPT| = ceil((4 + jsonLen) / 256) · 256, so at least 256)
metaLen = |metaPT| + 16
```

Padding the metadata to 256-byte steps hides the exact length of the file name.

**Single file:** `{"name": string, "type": string, "mtime"?: integer, "v": 1, "size": integer}`. The writer
emits `{...meta, v: 1, size}`, so `v` and `size` always reflect the payload. `mtime` is milliseconds since the
epoch. Send writes it only when "Keep file dates" is on.

**Bundle** (several files in one container, the default when sending two or more):

```json
{"v": 1, "name": "<N> files", "type": "application/x-czd-bundle", "size": <Σ entry sizes>,
 "entries": [{"name": "...", "type": "...", "size": 123, "off": 0, "mtime": 1767225600000}, ...]}
```

- 1 to 2000 entries. Each `off` is the entry's offset in the plaintext: the first is 0 and each next one is
  the previous `off + size`. `Σ size = size`.
- The payload is the entries' bytes concatenated in order. Entry *i* is plaintext `[off, off + size)`, read
  with random access (§3.6).

**Vault notes** are containers with `type = "application/x-czd-note"`, `name` = the title, and the payload
`UTF-8 JSON {"v":1,"title":string,"body":string}`. When a note is sent or saved it becomes
`"<title>.txt"` (`text/plain`, body only).

**Limits:** `jsonLen` ≤ 65,536 bytes for a single file and ≤ 1,048,576 bytes for a bundle (and `metaLen` ≤
1 MiB + 16 always holds).

### 3.5 Reading the metadata

Readers never trust metadata as-is:

| field | rule |
|---|---|
| `jsonLen` | ≤ `|metaPT| − 4`, else `bad-meta`. Every byte after the JSON must be zero, else `bad-meta`. |
| JSON | strict UTF-8, must parse to a plain object (not an array or `null`), else `bad-meta`. |
| `size` | safe integer ≥ 0, else `bad-meta`. |
| `type` | must match `/^[a-z0-9.+-]{1,60}\/[a-z0-9.+-]{1,60}$/i` (no parameters) and is lower-cased; anything else becomes `application/octet-stream`. A container is a bundle when the cleaned type is `application/x-czd-bundle`. |
| `name` | passed through `safeFilename` (§3.5.1); a missing name becomes `file`. |
| `mtime` | kept only if it is a safe integer in `[0, now + 86,400,000]`. |
| `entries` | bundles only: an array of 1..2000 plain objects, each with a safe-integer `size` ≥ 0 and `off` equal to the running sum, and the sum must equal `size`; else `bad-meta`. Entry `name`, `type` and `mtime` are cleaned like the top-level ones. |
| other keys | ignored and dropped. |

The resulting `containerSize(size, chunkExp, headerLen)` (§3.6) must be a safe integer, else `size-mismatch`.

#### 3.5.1 `safeFilename`

Every name that comes from a file (containers, bundles, backups, legacy records, the file system) goes through
`app/util/format.js` `safeFilename` and is only ever shown as text:

1. Lone surrogates become U+FFFD.
2. These are removed: C0/C1 controls, DEL, U+00AD, U+034F, U+061C, U+115F, U+1160, U+17B4, U+17B5,
   U+180B–U+180F, U+200B–U+200F, U+2028–U+202E, U+2060–U+2064, U+2066–U+206F, U+3164, U+FEFF, U+FFA0 and
   U+FFF9–U+FFFB (zero-width, bidi, filler and other invisible characters).
3. The name is NFC-normalized.
4. `/ \ : * ? " < > |` become `_`.
5. Every run of whitespace (any Unicode space, including no-break spaces and U+2800) becomes one space, so blank
   padding can't push the real extension out of view (`invoice.pdf      …` for `invoice.pdf<blanks>.exe`).
6. Leading and trailing dots and spaces are trimmed.
7. The name is capped at 200 UTF-16 units, keeping the extension.
8. Windows device names (`CON`, `PRN`, `AUX`, `NUL`, `COM0-9`, `LPT0-9`) get a `_` prefix.
9. An empty name becomes `file`.

### 3.6 Payload

```
paddedSize = padme(size)
CS         = 2^chunkExp
n          = max(1, ceil(paddedSize / CS))          // uses paddedSize, NOT size
plaintext  = data ‖ zero bytes up to paddedSize, cut into n chunks:
             |pt_i| = CS for i < n−1;  |pt_(n−1)| = paddedSize − (n−1)·CS   (0 only when paddedSize = 0)
nonce_i    = BE88(i) ‖ (i = n−1 ? 0x01 : 0x00)       // 11-byte big-endian counter, then the final flag
ct_i       = AES-256-GCM(payKey, nonce_i, pt_i, aad = ∅)        // |pt_i| + 16 bytes
chunk i starts at file offset headerLen + i · (CS + 16)
containerSize(size, chunkExp, headerLen) = headerLen + paddedSize + 16 · n
```

This is the STREAM construction: the counter in the nonce detects reordering, and the final flag detects
truncation at a chunk boundary.

**padme** (Padmé, leaks O(log log L) bits about the size):

```
padme(L) = L                          if L < 2
           E = floor(log2 L)
           S = floor(log2 E) + 1
           z = E − S
           round L up to a multiple of 2^z
```

Compute it with arithmetic, not 32-bit bit operations: sizes go above 2^31. Examples:

| size | padme | size | padme |
|---|---|---|---|
| 0 | 0 | 4,097 | 4,352 |
| 1 | 1 | 262,143 | 262,144 |
| 3 | 3 | 262,145 | 270,336 |
| 100 | 104 | 1,000,000 | 1,015,808 |
| 1,000 | 1,024 | 17,039,359 | 17,301,504 |

`17,039,359 = 65·CS − 1` pads to `66·CS`: the last chunk then holds only padding. Readers must handle it.

**Reading the payload:**

- Sequential (`decryptStream` / `decryptSource`): every chunk has its exact length. Data that ends before
  chunk n−1 is `truncated`. Bytes after the last chunk are `trailing-data`. A failed tag is `chunk-auth`, or
  `truncated-or-corrupt` on the last chunk. Plaintext past `size` must be zero, else `bad-padding`.
  Plaintext is released chunk by chunk before the end is verified, so it is provisional until the stream ends
  without an error.
- Random access (`decryptRange(start, endInclusive)`): reads and authenticates only the chunks that cover the
  range. The nonce uses the chunk's own index and final flag, so each chunk is checked exactly as in a full
  read, including the padding check.
- When reading from a byte source, the total length must equal `containerSize(...)` before anything is shown,
  else `size-mismatch`.

### 3.7 Writer rules

- `encryptStream` **always** draws a fresh random fileKey (32 bytes) and streamSalt (16 bytes). Callers cannot
  pass them. The test-only `_encryptStreamWith` can, and a unit test makes sure no app module imports it.
- `metaNonce` and every `wrapNonce` are random.
- Content changes (note edits, imports, sends, merges) always create a NEW container. There is no rewrap.
- Vault items have exactly one vault stanza. Send outputs have exactly one passphrase stanza.
- **Send batches:** one Argon2 run per batch (`makePassKek`: one fresh salt, POLICY or, after an out-of-memory
  error, FLOOR). Every container of the batch gets a passphrase stanza with that salt and those parameters, but
  its own fileKey and wrapNonce.
- The app writes `chunkExp = 18`. Readers accept 12..24.
- The raw fileKey is wiped as soon as the subkeys exist. On the read side `release(opened)` wipes it, and every
  caller must call `release`.

### 3.8 Reader validation order

A reader checks every bound before any KDF runs. All errors are `CzdError`:

| step | check | error |
|---|---|---|
| 1 | the first (up to) 8 bytes are the magic | `not-czd2` |
| 2 | at least 28 bytes | `short-header` |
| 3 | `version = 2` | `unsupported-version` |
| 4 | `flags = 0` | `unknown-flags` |
| 5 | `12 ≤ chunkExp ≤ 24` | `bad-chunk-size` |
| 6 | `k ≥ 1` | `bad-stanza-count` |
| 7 | `k ≤ 4`, ≤ 2 passphrase stanzas, ≤ 1 vault stanza | `too-many-stanzas` |
| 8 | stanza body lengths (86 / 92 / ≤ 1024) | `bad-stanza` |
| 9 | `metaLen` range and alignment | `bad-meta` |
| 10 | the whole header is present | `short-header` |
| 11 | unlock a stanza (below) | see below |
| 12 | the unwrapped fileKey is 32 bytes | `bad-stanza` |
| 13 | header MAC (constant-time `subtle.verify`) | `header-mac` |
| 14 | metadata decrypts | `meta-auth` |
| 15 | metadata rules (§3.5) | `bad-meta` / `size-mismatch` |
| 16 | source length = `containerSize` | `size-mismatch` |

**Unlocking with the vault key** (vault items): the first vault stanza is used (none: `no-usable-stanza`).
`vaultId` must match (`other-vault`), then `itemId` (`item-mismatch`); both are always compared, and the caller
must pass the item id. An unwrap failure is `vault-unwrap-failed`. If the caller also passed a passphrase and the
container has passphrase stanzas, the reader then tries those.

**Unlocking with a passphrase** (`.czd` files):

1. No passphrase stanza at all: `no-usable-stanza`. None with `kdfId = 1`: `unsupported-kdf`.
2. `checkParams` runs on **every** usable stanza before any Argon2 (§2.3).
3. An empty canonical passphrase is `wrong-passphrase` without running Argon2.
4. Stanzas are tried in order, with at most one Argon2 run per distinct `(salt, m, t, p)`.
5. If none unwraps: `wrong-passphrase`.

### 3.9 Limits (`container.LIMITS`)

| limit | value |
|---|---|
| `chunkExp` | 12..24 |
| stanzas | 1..4; ≤ 2 passphrase, ≤ 1 vault |
| unknown stanza body | ≤ 1024 bytes |
| passphrase / vault stanza body | 86 / 92 bytes |
| `metaLen` | 272 .. 1,048,592, `(metaLen − 16) mod 256 = 0` |
| meta JSON | ≤ 65,536 bytes (single), ≤ 1,048,576 bytes (bundle) |
| bundle entries | 1..2000 |
| sizes | safe integers (≤ 2^53 − 1), including `containerSize` |

---

## 4. Text format v2

Camouflage messages ("Text" tab). The output looks like Georgian and Cyrillic letters.

```
text   = "ჶ" (U+10F6) ‖ bytesToScript(blob)            // stealth alphabet, §5
blob   = 0x02 | preset u8 | salt[16] | nonce[12] | commit[16] | ct
         offsets: 0 version, 1 preset, 2..17 salt, 18..29 nonce, 30..45 commit, 46.. ct
bits   = Argon2id(passphraseBytes(passphrase), salt, PRESET[preset]) → 32 bytes
encKey = HKDF-SHA256(ikm = bits, salt = ∅, info = ASCII("cZEROde text v2 key"))          AES-256-GCM key
commit = HKDF-SHA256(ikm = bits, salt = ∅, info = ASCII("cZEROde text v2 commit")), first 16 bytes
pt     = UTF-8(message exactly as typed) ‖ 0x80 ‖ 0x00… up to the next multiple of 16 (always 1..16 bytes added)
ct     = AES-256-GCM(encKey, nonce, pt, aad = blob[0..2) = 0x02 ‖ preset)
PRESET = {1: POLICY, 2: FLOOR}
```

`salt = ∅` is a zero-length HKDF salt, which RFC 5869 treats as 32 zero bytes. Every message gets a fresh salt
and nonce.

**Decrypting:**

1. Remove every ECMAScript whitespace and line-terminator character anywhere in the text.
2. The text must start with `ჶ`, else `not-cz-text`.
3. The rest must be stealth characters only (raw base64 is **not** accepted here), else `not-cz-text`.
4. `blob[0] > 2` is `text-preset-unknown`, `blob[0] < 2` is `not-cz-text`. A preset other than 1 or 2 is
   `text-preset-unknown`.
5. `|ct|` must be ≥ 32 and a multiple of 16, else `not-cz-text`.
6. Derive `bits`, then compare `commit` in constant time **before** AES-GCM. A mismatch is `wrong-passphrase`,
   so a wrong passphrase never reaches the cipher.
7. A GCM failure after a matching commit means the text was changed: `not-cz-text`.
8. Remove the `0x80 0x00…` padding (it must be there and be ≤ 16 bytes), then decode strict UTF-8. Any problem
   is `not-cz-text`.

**Detection** (`detectText`, used by the Text tab's Auto mode), after stripping whitespace:

- `'v2'`: starts with `ჶ`.
- `'v4'` (legacy, §11.1): all of these hold:
  - ≥ 60 characters, and ≥ 85 % of them are stealth characters;
  - at least one letter that Mixed Script never produces, one of `თჟქღშჩძჭБЙПЦЩЪЫЬЭЮ`;
  - Georgian and Cyrillic each make up ≥ 1/8 of the stealth characters.
- `'mixed'`: the legacy detector recognises Mixed Script v1–v3.
- otherwise `null`.

---

## 5. The stealth alphabet

Text v2 and legacy v4 write bytes as **unpadded standard base64** (`A–Z a–z 0–9 + /`, trailing `=` removed), then
replace base64 digit *i* with `SA[i]`:

```
SA[i] = U+10D0 + i          for i = 0..32    (Georgian ა … ჰ)
SA[i] = U+0410 + (i − 33)   for i = 33..63   (Cyrillic А … Ю; Я and Ё are not used)
```

Decoding (`scriptToBytes`) ignores whitespace anywhere. It accepts non-canonical trailing bits (forgiving
base64) and rejects a digit count ≡ 1 (mod 4). With `allowRawBase64` (legacy only), it also accepts plain base64
digits and trailing `=`. Anything else is `legacy-not-ciphertext` (text v2 reports it as `not-cz-text`). The
Georgian/Cyrillic look is cosmetic. The security comes from the cipher.

---

## 6. Vault storage

Each browser profile (web) or app install (desktop) has its own vault: one IndexedDB database `czd-vault` plus a
container store. Nothing is stored in plaintext.

### 6.1 Key model

```
VMK    = 32 random bytes (vault master key); in JS only ever a non-extractable HKDF key
KEK    = Argon2id(passphraseBytes(passphrase), kdf.salt, kdf.m, kdf.t, kdf.p) → AES-256-GCM key
wrap   = AES-256-GCM(KEK, wrap.iv, VMK, aad = ASCII("cZEROde vault v1") ‖ vaultId)           → {iv[12], ct[48]}
RK     = HKDF-SHA256(ikm = code (20 bytes), salt = vaultId, info = ASCII("cZEROde recovery")) → AES-256-GCM key
rwrap  = AES-256-GCM(RK, rwrap.iv, VMK, aad = ASCII("cZEROde recovery v1") ‖ vaultId)       → {iv[12], ct[48]}

itemWrapKey = HKDF-SHA256(ikm = VMK, salt = vaultId, info = ASCII("cZEROde czd2 vault item-wrap"))  AES-256-GCM
indexKey    = HKDF-SHA256(ikm = VMK, salt = vaultId, info = ASCII("cZEROde vault index"))          AES-256-GCM
backupKey   = HKDF-SHA256(ikm = VMK, salt = vaultId, info = ASCII("cZEROde backup"))               HMAC-SHA256
```

- **Unlock** uses `unwrapKey('raw', wrap.ct, KEK, AES-GCM{iv, aad}, 'HKDF', non-extractable)`, so the raw VMK
  never reaches JavaScript. A failure is `wrong-passphrase`.
- **Recovery code:** 20 random bytes (160 bits), shown as RFC 4648 base32 without padding, 32 characters in 8
  groups of 4 joined by `-` (for example `CU2H-UNOK-OWIF-VJSC-6RLL-AS73-3KJ2-EROT`). Parsing ignores case, spaces,
  `-` and trailing `=`, and reads `0` as `O`, `1` as `I` and `8` as `B`. Anything that is not 20 bytes is
  `recovery-wrong`, and so is a vault without `rwrap`. The code is shown once and never stored.
- **Changing the passphrase**, and unlocking with the recovery code (which sets a new passphrase), re-wrap the same
  VMK into a new `wrap` under a new salt. The KDF parameters stay the same.
- **Setting the recovery code** writes a new `rwrap`, with a new code and a new iv. **Removing it** sets `rwrap`
  to `null`.
- All of these run under `navigator.locks` `'czd-vault-record'` and a compare-and-swap on `wrap.ct`, so a change
  made in another tab meanwhile is `vault-changed`.
- The VMK itself never changes, so old backups keep opening with the passphrase (and recovery code) that was
  current when they were made.

### 6.2 IndexedDB `czd-vault`, version 1

| store | key | value |
|---|---|---|
| `meta` | `'vault'` | the vault record (below) |
| `items` | `id` (32 hex, in-line) | `{id, iv: U8[12], enc: U8, storedBytes: int}` |
| `lists` | `id` (in-line) | `{id, iv, enc}` (albums) |
| `thumbs` | `id` (in-line; = the item id) | `{id, iv, enc}` |
| `kv` | string | any structured-clone value (device-local, never secret) |
| `blobs` | `[key, seg]` | Blob (IdbBlobStore only, §6.3) |

**Vault record** (`meta['vault']`):

```
{ v: 1,
  vaultId: U8[16],
  kdf: { id: 1, m, t, p, salt: U8[16] },
  floor: boolean,
  wrap: { iv: U8[12], ct: U8[48] },
  rwrap: null | { iv: U8[12], ct: U8[48] },
  storeKind: 'opfs' | 'idb' | 'tauri-fs',
  createdAt: int (ms),
  lastBackupAt: int | null }
```

**Encrypted index records.** Each is `enc = AES-256-GCM(indexKey, iv, plaintext, aad = PREFIX ‖ id16)` with a
fresh 12-byte iv. `id16` is the raw 16 bytes of the record id:

| store | AAD prefix | plaintext |
|---|---|---|
| `items` | `ASCII("item:")` | UTF-8 JSON **ItemIndex** |
| `lists` | `ASCII("list:")` | UTF-8 JSON `{name, itemIds: [hex], cover?: hex, createdAt}` |
| `thumbs` | `ASCII("thumb:")` | JPEG bytes (long edge ≤ 320 px, ≤ 32 KiB) |

**ItemIndex:**

```
{ name, type, size, addedAt, origName,
  hmac,           // base64 of the item container's 32-byte headerMAC
  mtime?,         // ms, when the source file had one
  fav?: true, hasThumb?: true,
  duration?,      // seconds (audio/video)
  w?, h? }        // pixels (images, video posters)
```

- The item's container is stored under the same id, with a vault stanza for `(vaultId, itemId = id)`.
- `vault.open(id)` compares the container's header MAC with `hmac` in constant time, so a swapped or edited
  file is `item-tampered`. Container errors that mean "not the file the index describes" also map to
  `item-tampered`.
- On unlock, every record is decrypted and sanitized again (names through `safeFilename`, types cleaned,
  unknown keys dropped). Records that fail to decrypt are skipped and listed as damaged.

**kv keys used by the app:**

| key | value |
|---|---|
| `legacy-import-done` | `true` once "Import all unlocked" finished |
| `legacy-imported`, `legacy-albums` | maps of old cZEROde 1 ids → new item/album ids |
| `merged:<vaultId hex>:<old id>` | the new item or album id created by a merge from another vault (§8.4) |

Banner dismissals and other preferences live in `localStorage` (`czd2.*` keys, `app/settings.js`), not in the
vault database.

### 6.3 Container stores

The vault record's `storeKind` says where the item containers live. A vault never switches stores silently: if
that store is unavailable, the error is `store-unavailable`.

| storeKind | where | notes |
|---|---|---|
| `opfs` | Origin private file system: `/czd/v1/items/<id>.czd` | The web default. Written by a worker (`app/vault/opfs-worker.js`) through a sync access handle on the final path, then flushed. Send outputs are staged as `/czd/v1/tmp/<32 hex>.tmp`. |
| `idb` | IndexedDB `blobs`: 16 MiB Blob segments under `[id, 0..n−1]`, plus a marker `[id, −1] = {v: 1, mtime, done, size?, segs?}` | Only for engines without OPFS. The marker is written first and completed last, so a half-written container is never readable. Staged outputs use key `tmp:<32 hex>`. |
| `tauri-fs` | `$APPDATA/vault2/items/<id>.czd` | Desktop. |

`$APPDATA` is the Tauri app data directory for the identifier `com.czeroode.app`:

| OS | `$APPDATA` |
|---|---|
| Windows | `%APPDATA%\com.czeroode.app\` |
| macOS | `~/Library/Application Support/com.czeroode.app/` |
| Linux | `$XDG_DATA_HOME/com.czeroode.app/` (usually `~/.local/share/com.czeroode.app/`) |

**Sweeps** run while a tab holds the vault and `navigator.locks` `'czd-store'`. They delete staged files older
than 24 h and item files without an index record older than 1 h.

---

## 7. Desktop index mirror (`index.json`)

On the desktop, the encrypted index also lives in the webview's IndexedDB. A webview reset would lose it while
the containers survive on disk, so `app/vault/boot.js` mirrors it to `$APPDATA/vault2/index.json`:

```json
{ "format": "czd-vault-snapshot", "v": 1,
  "meta":  { ...vault record... } | null,
  "items": [ { "id": "...", "iv": {"$b64": "..."}, "enc": {"$b64": "..."}, "storedBytes": 123 }, ... ],
  "lists": [ { "id": "...", "iv": {"$b64": "..."}, "enc": {"$b64": "..."} }, ... ],
  "kv":    [ ["legacy-import-done", true], ... ] }
```

- Every byte array (`Uint8Array`/`ArrayBuffer`) becomes `{"$b64": "<standard base64>"}`. A plain object whose only
  key is `$b64` is refused on export, so that form is unambiguous. Other values are plain JSON. Nesting is limited
  to 32 levels.
- `thumbs` and `blobs` are not mirrored. A rebuilt vault has no thumbnails until items are re-added. `kv` values
  that JSON cannot hold are skipped.
- **Writing:** 500 ms after the last change (item, album, vault-record or status event), and on `pagehide`. The
  mirror writes `index.json.part`, then renames it over `index.json`. When there is no vault record any more, the
  mirror deletes `index.json`.
- **Rebuilding:** at startup, if IndexedDB has no vault record but `index.json` exists and is not empty, it is
  imported in one transaction. A snapshot that does not validate is `bad-meta`; one arriving while a vault exists
  is `vault-exists`. Nothing is written in either case.
- The file holds the same data as IndexedDB: the wrapped VMK, the KDF parameters and salt, encrypted records and
  the device-local kv values. It holds no plaintext names or content.

---

## 8. Backup `.czb` v1

A backup is the encrypted vault as-is: the vault record, every encrypted index record and every item container
verbatim, plus an authenticated table that ties them together.

### 8.1 Layout

```
magic        89 43 5A 42 0D 0A 1A 0A        ("\x89CZB\r\n\x1a\n")
version u8   1
flags u8     0
vaultRec     vaultId[16] | kdfId u8 | m u32 | t u32 | p u8 | salt[16] | iv[12] | ct[48]
             | hasRecovery u8 (0/1) | [riv[12] | rct[48]  only when hasRecovery = 1] | floor u8 (0/1)
createdAt    u64 (ms)
count        u32 (≤ 2,000,000)
entries      count × 93 bytes:
               0   1   kind u8           1 = item, 2 = list, 3 = thumb
               1   16  id
               17  8   containerLen u64  items: the container's length; lists/thumbs: 0
               25  32  headerMAC         items: the container's headerMAC; lists/thumbs: 32 zero bytes
               57  4   recLen u32        28 ≤ recLen ≤ 1 MiB
               61  32  recSHA256         SHA-256 of the record bytes
entriesMAC   32 bytes = HMAC-SHA256(backupKey, every byte from the magic through the last entry)
records      in entry order; each = iv[12] ‖ enc (exactly the IndexedDB record's iv and enc; recLen bytes)
containers   the item entries' containers, in item-entry order, verbatim (containerLen bytes each)
```

`vaultRec` holds the same values as the vault record (§6.2): `iv`/`ct` are `wrap`, `riv`/`rct` are `rwrap`.

### 8.2 Writing (export)

- **Pass 1:** read every index record in batches and hash it. For each item, open its container header with the
  vault keys, check its total length, and note its length and header MAC. Items whose container is missing or
  damaged are left out (the export reports them as skipped), so a backup never carries a container the restore
  would refuse. Then sign the header.
- Entries are written in this order: all items, then all lists, then the thumbnails of included items.
- **Pass 2:** stream the signed prefix, then each record, re-read and checked against its pass-1 hash, then
  each container. Anything that changed between the passes aborts with `vault-changed`.
- The output streams straight to the chosen save target. `lastBackupAt` is set when the export succeeds.

### 8.3 Reading

Bounds come before allocation. Every check here is done before any key is used:

| check | error |
|---|---|
| magic | `not-czb` |
| `version = 1` and `flags = 0` | `czb-version` |
| `hasRecovery`, `floor` ∈ {0, 1}; `createdAt` and `containerLen` < 2^53; `count` ≤ 2,000,000 | `not-czb` |
| `kdfId = 1` | `unsupported-kdf` |
| KDF parameters (§2.3) | `kdf-params-out-of-range` |
| each entry: known kind; `28 ≤ recLen ≤ 1 MiB`; items `containerLen ≥ 367`; lists/thumbs have `containerLen = 0` and a zero MAC; no duplicate `(kind, id)` | `not-czb` |
| `prefixLen + Σ recLen + Σ containerLen` vs the file size | `czb-truncated` (short) / `trailing-data` (long) |

Then the reader:

1. Unwraps the VMK. With the passphrase this is `KEK` → `wrap` (`wrong-passphrase`). With the recovery code it
   is `RK` → `rwrap` (`recovery-wrong`).
2. Derives `backupKey` and verifies `entriesMAC` (`czb-mac`) before it uses anything else.
3. Checks every record against its `recSHA256` before use (`czb-mac`).
4. Opens every container header with the backup's `itemWrapKey`, `vaultId` and the entry's id. Its header MAC
   must equal the entry's `headerMAC`, and `containerSize(...)` must equal `containerLen`; otherwise `czb-mac`.

### 8.4 Restore and merge

- **Replace** (only when this device has no vault): the reader writes every container to the store first. Then
  ONE IndexedDB transaction writes the vault record (`storeKind` = this device's store, `createdAt` = now,
  `lastBackupAt` = the backup's `createdAt`), every item, list and thumbnail record. It runs under
  `'czd-vault-record'` with an "only if there is still no vault" compare-and-swap. Nothing is visible before that
  commit, and a failure deletes the written containers. A restore with the recovery code can set a new
  passphrase in the same step.
- **Merge, same vault** (same `vaultId`, vault unlocked): no secret is asked; the current `backupKey` verifies
  the backup. Items and albums whose id already exists are skipped. Each new item is written and committed on its
  own, so an interrupted merge can simply be run again.
- **Merge, another vault:** asks for that backup's passphrase or recovery code. Every item is decrypted and
  re-encrypted into a fresh container with a new id under the current vault. Index and thumbnail records are
  re-sealed with the current `indexKey`, and album item ids are remapped. `kv['merged:<vaultId hex>:<old id>'] =
  <new id>` is recorded for every item and album, so a repeated merge skips them. The ItemIndex `hmac` must
  match the entry's header MAC and the container's size, else `czb-mac`.

---

## 9. Streaming and Range semantics

Large previews are not decrypted into memory. A media element loads a URL, and a decrypting proxy answers it:
the service worker on the web (`sw-stream.js`) and the `czstream` protocol on the desktop
(`src-tauri/src/stream.rs`). Both answer Range requests with plaintext, decrypting only the chunks that cover the
range with the layout of §3.6.

### 9.1 Range parsing (shared, normative)

The header, trimmed of JavaScript whitespace, must match `bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*` (`bytes` in any
case). `total` is the plaintext size (or a bundle entry's size).

| header | result |
|---|---|
| absent, malformed, several ranges, or `bytes=-` | whole payload, **200** |
| `bytes=a-b` with `b < a` | whole payload, **200** |
| `bytes=a-` / `bytes=a-b` with `a ≥ total` | **416**, `Content-Range: bytes */total` |
| `bytes=a-b` / `bytes=a-` | **206**, `start = a`, `end = min(b, total − 1)` (or `total − 1`) |
| `bytes=-k` with `k = 0` or `total = 0` | **416** |
| `bytes=-k` | **206**, `start = max(0, total − k)`, `end = total − 1` |

A 206 response carries `Content-Range: bytes start-end/total`, `Accept-Ranges: bytes` and `Content-Length`.
`HEAD` gets the same headers and no body. An empty payload without a Range header is a 200 with an empty body.
`tests/vectors/czd2/rust-ranges.json` is the shared table. `tests/unit/tauri-stream-vectors.test.js` checks it
against `sw-stream.js`, and `cargo test` checks it against Rust, so a change to these rules must update all three.

### 9.2 Web: service worker `/czstream/`

- **Page → SW** (`controller.postMessage(msg, [port])`, answered `{ok: true}` on the port):
  - `{cmd: 'register', token, blob, payKey, headerLen, chunkExp, size, paddedSize, mime, filename, download, entry?: {off, size}}`
  - `{cmd: 'unregister', token}`
  - `{cmd: 'lock'}`: every token is dropped, and streams in flight fail at their next chunk.
  - `{cmd: 'lock', scope: 'client'}`: the same, but only for the sending page's tokens and streams. A page sends
    it for a passive lock of its own (`idle`, `hidden`, `pagehide`, `freeze`), so a background tab never stops
    another tab's media.

  `payKey` is the non-extractable AES-GCM `CryptoKey`; the raw fileKey never goes to the SW. `blob.size` must
  equal `headerLen + paddedSize + 16·n`.
- **Token:** 16 random bytes, RFC 4648 base32 without padding (26 characters `A–Z2–7`). The URL is
  `new URL('czstream/' + token, registration.scope)`. Downloads add `?download=1`. The SW keeps at most 512 tokens.
- **Media requests** are answered only for the client that registered the token and never for navigations;
  anything else is **403**. A token the SW does not know (it was restarted) is fetched again: the SW asks the
  requesting page `{cmd: 'need', token}` over a MessageChannel. The page answers with the register payload only
  if the token is live, the item is still open and the vault is unlocked, else `{deny: true}`. No answer within
  2 s is **403**. Methods other than GET/HEAD are **405** with `Allow: GET, HEAD`.
- **Downloads** (`?download=1`) are single use, live 60 s, and are served only for navigations, with
  `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''<RFC 5987
  percent-encoded safe name>` and `Content-Length: size`. They decrypt chunks 0..n−1, padding chunks included,
  so the final flag is authenticated. Only `size` bytes are emitted, and the padding must be zero. An unknown,
  expired or locked token gets **204**, and the page gets `{type: 'download-failed', token}`. Downloads are not
  used on WebKit.
- **Every response** carries `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options:
  nosniff`, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: no-store`. `Content-Type` is the
  safe media type (`image/(png|jpeg|gif|webp|avif|bmp)`, `audio/*`, `video/*`, else
  `application/octet-stream`). Responses are never cached.
- Media responses authenticate every chunk they decrypt. Bytes past `size` are never sent.

### 9.3 Desktop: `czstream` protocol

- **Commands:**
  - `stream_register(token, id, file_key[32], stream_salt[16], header_len, chunk_exp, size, padded_size, mime)`
  - `stream_unregister(token)`
  - `stream_clear()`

  Rust derives `payKey = HKDF-SHA256(fileKey, streamSalt, "cZEROde czd2 payload")` itself and keeps it in a
  zeroizing buffer.
- **Registration checks:**
  - `id` must be 32 lowercase hex characters;
  - `padded_size = padme(size)`;
  - `chunk_exp` must be 12..24, and `header_len` must lie between the smallest and largest possible header;
  - the file `$APPDATA/vault2/items/<id>.czd` must have exactly `containerSize` bytes;
  - its first 28 bytes must match the magic, version 2, flags 0, the `chunk_exp` and the `stream_salt`.

  Only the cheap header fields are checked; the header MAC is not. A wrong key registers, and then every
  response fails authentication with **500**.
- **URL:** `convertFileSrc(token, 'czstream')`. That is `czstream://localhost/<token>` on macOS and Linux and
  `https://czstream.localhost/<token>` on Windows.
- **Responses:** the Range rules are those of §9.1, with these differences:
  - **Window:** at most 4 MiB of plaintext per response, rounded up to the end of the chunk that holds the last
    byte. A longer request gets a shorter **206**, and a request without Range on a larger file gets the first
    window as a **206**.
  - **No `Cross-Origin-Resource-Policy` header:** the page loads these URLs cross-origin. The CSP sandbox,
    nosniff and no-store headers are the same as on the web.
  - Every chunk is authenticated and its padding checked. A failed tag or non-zero padding is **500**
    (`text/plain`). An unknown or revoked token, or a missing file, is **404**. Only the `main` webview may use
    the protocol (others get **403**). Methods other than GET/HEAD are **405**.
  - No bundle entries and no downloads.
- **Lifetime:** keys are dropped on `stream_unregister`, on `stream_clear` (the page locked), whenever the page
  (re)loads, and on exit. At most 512 registrations are kept, and the oldest is evicted first.
- **Linux:** WebKitGTK hands media URLs to GStreamer, which cannot read custom schemes. So `stream_register`
  refuses on Linux with `czstream: unsupported: …`, and the page plays a Blob within its cap (512 MiB) instead.
  Debug builds accept `CZSTREAM_LINUX=1` (use the protocol anyway, for smoke tests) and `CZSTREAM_WINDOW=<bytes>`
  (a smaller response window).

---

## 10. Golden vectors

The committed vectors are **decrypt-only**: the tests decrypt them and compare SHA-256 digests; they never
re-encrypt and compare bytes (keys and nonces are random). Plaintext comes from **mulberry32**, so any
implementation can rebuild it:

```
a = seed (u32)
each step: a = (a + 0x6D2B79F5) mod 2^32
           t = imul(a ^ (a >>> 15), a | 1)
           t ^= t + imul(t ^ (t >>> 7), t | 61)
           emit u32 (t ^ (t >>> 14)) >>> 0, little-endian
truncate to the size
```

| file | what | generator |
|---|---|---|
| `tests/vectors/czd2/size-{0,1,262143,262144,262145,786439}.czd` | single files: 0, 1, CS−1, CS, CS+1 and 3·CS+7 bytes (CS = 256 KiB) | `scripts/gen-vectors.mjs` |
| `tests/vectors/czd2/batch-{0,1}.czd` | a 2-file Send batch sharing one passphrase salt | `scripts/gen-vectors.mjs` |
| `tests/vectors/czd2/bundle-3.czd` | a 3-entry bundle | `scripts/gen-vectors.mjs` |
| `tests/vectors/czd2/vault-1.czd` | a vault item (the JSON gives the VMK, vaultId and itemId) | `scripts/gen-vectors.mjs` |
| `tests/vectors/czd2/czd2.json` | sizes, seeds, metadata, `fileKeyHex`/`streamSaltHex` (to skip Argon2), digests, and the passphrase `cZEROde golden vectors 2.0 ✓` at POLICY | `scripts/gen-vectors.mjs` |
| `tests/vectors/text-v2.json` | text v2 messages (POLICY and FLOOR, empty, Unicode, canonicalization) | `scripts/gen-vectors.mjs` |
| `tests/vectors/czd2/rust-*.czd` + `rust-vectors.json` | vault items for `stream.rs`: a padding-only last chunk, chunkExp 12 and 24, and a 3 MiB file | `scripts/gen-rust-vectors.mjs` |
| `tests/vectors/czd2/rust-ranges.json` | the Range table of §9.1 | maintained by hand |
| `tests/vectors/backup-v1.czb` + `backup-v1.json` | a `.czb` with a note, an empty file, audio, a photo with a thumbnail, an album and a recovery code | `scripts/gen-backup-vector.mjs` |
| `tests/vectors/legacy-web-vectors.json`, `legacy-desktop-vectors.json` | every cZEROde 1 format (§11), produced by the original code | research harness (not regenerated) |

The 17,039,359-byte vector (65·CS − 1, the padding-only last chunk at the default chunk size) is **not
committed**. `czd2.json` lists its seed and plaintext digest under `generated`, and the tests rebuild it.

**Regenerating:**

```sh
node scripts/gen-vectors.mjs              # or: npm run vectors   (czd2/*.czd except rust-*, czd2.json, text-v2.json)
node scripts/gen-vectors.mjs --big <dir>  # writes size-17039359.czd + .json into <dir> (not committed)
node scripts/gen-rust-vectors.mjs         # czd2/rust-*.czd + rust-vectors.json
node scripts/gen-backup-vector.mjs        # backup-v1.czb + backup-v1.json
node scripts/gen-backup-vector.mjs --out <dir>
```

- `gen-vectors.mjs` and `gen-rust-vectors.mjs` use random keys and nonces, so a run rewrites **every** file they
  own.
- `gen-backup-vector.mjs` is deterministic: it replaces `crypto.getRandomValues` with a seeded SHA-256 DRBG and
  fixes the clock. A run reproduces the committed file byte for byte, and a unit test checks that. It only
  changes if the vault code changes how it draws random bytes.

**Rule:** the format must not change silently. Regenerating any committed vector requires a dated note in
[§12](#12-vector-history) saying why. If the format itself changes, the version byte changes and this document
changes with it.

---

## 11. Legacy formats (decode only)

cZEROde 2 reads every cZEROde 1 format and never writes one. The full byte-level specifications, with every
quirk, are reproduced by the vectors in `tests/vectors/legacy-web-vectors.json` and
`tests/vectors/legacy-desktop-vectors.json`, which were produced by running the original code. The unit tests
decode every vector in both files.

### 11.1 v4 "cZEROde" AES text (web and desktop)

```
blob = salt[16] | iv[12] | AES-256-GCM(key, iv, UTF-8(plaintext), aad = ∅)     (no header, no version)
key  = PBKDF2-HMAC-SHA256(UTF-8(PIN exactly as typed), salt, 100,000 iterations) → 32 bytes
text = blob in unpadded base64, mapped to the stealth alphabet (§5)
```

- The smallest blob is 44 bytes; shorter is `legacy-not-ciphertext`.
- Whitespace anywhere and plain base64 are accepted.
- A GCM failure is `legacy-wrong-pin`. The decoder retries the PIN as typed, then trimmed, NFC, NFD and the
  NFC/NFD forms of the trimmed PIN (distinct, non-empty values only).
- Plaintext is decoded as non-fatal UTF-8 and one leading BOM is dropped, like the original.
- PBKDF2 at 100,000 iterations with a PIN is weak: re-encrypt anything important.

### 11.2 Mixed Script v1–v3

None of these was encryption. All are lossy: `q` and `y` share `ყ`, several Cyrillic capitals collide (`B/V`,
`C/S`, `F/Q`, `H/N`, `P/R`), and case is lost.

- **v1:** a letter map, Latin lower case → Georgian and upper case → Cyrillic. It is decoded per UTF-16 unit
  with the reverse maps.
- **v2:** v1 output scrambled by one of five keyless methods. The method is marked by the first character
  (`╾ ╿ ╼ ╽ ╻`), with noise symbols (`†‡§¶※◊●○◦•⁕⁂✦✧✩✪⌘⌬⍟⏣⌖⎌⌀`) mixed in. cZEROde 2 uses the corrected inverse
  of method III; the original decoded it wrongly whenever the length was not a multiple of 3.
- **v3:** a PIN-seeded alphabet shuffle (FNV-style seed over UTF-16 units, xorshift PRNG, with exact JS number
  semantics) plus a Vigenère shift keyed by the PIN's letters (`x` when it has none), then the v1 Georgian map.
  The output cannot be verified, so it is shown as a best effort.

### 11.3 Old web vault: IndexedDB `czeroode_db`

Version 2, stores `vault`, `files` and `playlists` (keyPath `id` = `Date.now()` as a string). All values are
JSON-native. Names, sizes, dates, MIME types and PIN lengths were stored **in plain text**.

| store | record |
|---|---|
| `vault` | `{id, name, cipher, ver: 'cz'\|'v2'\|'v3', pin_hint: '<n> chars'\|'', date, size}`. `cz` = v4 text (or plaintext, if the user saved after decrypting), `v2`/`v3` = Mixed Script. |
| `files` | `{id, name, isChunked, mime, ext, type, date, size, cipher \| chunks[]}`. Single: `cipher` is v4 of `{"v":1,"type":"file","mime","name","ext","data":<base64>}`. Files ≥ 15 MiB: `chunks[i]` is v4 of `{"v":1,"type":"chunk","index","totalChunks","data","mime","name","ext"}` over 5 MiB slices, each with its own salt. |
| `playlists` | `{id, name, type: 'audio'\|'video', fileIds: [id], date}`; imported as albums. |

The reader never creates this database (it uses `indexedDB.databases()`, or aborts and deletes a database it
created by opening) and never keeps a connection open. Chunked files need indices exactly `0..n−1` with
`n = totalChunks`, else `legacy-missing-chunks`. Chunks that disagree on name, MIME, extension or slice size are
`legacy-bad-record`. A file PIN is checked first by decrypting one AES-CTR block and comparing it with
`{"v":1,"type":"` (a fast precheck), then fully by GCM.

### 11.4 Old desktop `.czd` (cZEROde 1 desktop, Tauri 1)

```
file      = UTF-8 JSON {"v":1,"type":"image","cipher":"<v4 stealth text>"}      (no BOM, no newline)
plaintext = JSON {"v":1,"type":"image","mime":"image/png","name":"<base name>","data":"<padded base64>"}
```

The files lived in `$APPDATA/vault/*.czd` (same identifier `com.czeroode.app`, §6.3). The desktop app lists them
under Legacy → Old desktop `.czd` files, and the web app opens them from a file picker. The reader also does the
following:

- It sniffs `{"v":1,` (JSON whitespace and a UTF-8 BOM tolerated) in the first bytes.
- It needs only a non-empty string `cipher`; it ignores the outer `v` and `type`.
- It accepts a missing or non-string MIME as `image/png` and adds an extension from the MIME to the name.
- It also accepts web-edition single-file payloads (`"type":"file"`).
- Any other plaintext is returned as `decrypted.txt`.

---

## 12. Vector history

Regenerating a committed vector requires a dated entry here (§10).

- **2026-10-01: initial set.** `czd2/*.czd` (except `rust-*`), `czd2.json` and `text-v2.json` were generated in
  phase 1. `rust-*.czd`, `rust-vectors.json`, `rust-ranges.json` and `backup-v1.czb`/`.json` were added in
  phase 2. FORMAT v2, text v2 and `.czb` v1 have not changed since.
