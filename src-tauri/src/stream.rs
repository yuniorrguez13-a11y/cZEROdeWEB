// czstream: desktop playback of large vault videos straight from disk (DESIGN §5.3).
//
// The page registers an opened vault item with `stream_register`: its id, the raw 32-byte fileKey and the
// container layout it already validated (header length, chunk exponent, size, padded size) plus a media type.
// Rust derives the payload key (HKDF-SHA256, info "cZEROde czd2 payload"), keeps it in a `Zeroizing` buffer
// and answers `czstream://localhost/<token>` (Windows: `http(s)://czstream.localhost/<token>`) with the same
// Range semantics as the service worker's /czstream/ (sw-stream.js, DESIGN §5.2): each request reads only the
// chunks covering the requested bytes from `$APPDATA/vault2/items/<id>.czd`, authenticates and decrypts them,
// and returns the plaintext. Nothing is cached; the decrypted chunk buffer is wiped after every chunk.
//
// Differences from the service worker:
//   - Tauri's responder takes a whole body, so a response carries at most RESPONSE_WINDOW plaintext bytes
//     (rounded up to the end of a chunk); a longer request gets 206 with a shorter Content-Range and the media
//     element asks for the rest (a request without Range on a larger file gets the first window as a 206);
//   - no Cross-Origin-Resource-Policy header: the page (tauri://localhost / https://tauri.localhost) loads
//     these URLs cross-origin, so `same-origin` would block every video.
//
// Linux: WebKitGTK answers the media element's first request through this protocol but then hands the URL to
// GStreamer, which has no source element for custom schemes, so <video>/<audio> fail at once with
// MEDIA_ERR_SRC_NOT_SUPPORTED (seen with WebKitGTK 2.52 + GStreamer 1.24). `stream_register` therefore refuses
// on Linux ("czstream: unsupported: ..."), and the page plays a Blob within its cap instead (DESIGN §5.1).
//
// Keys go away on `stream_unregister`, on `stream_clear` (the page locks) and whenever the page (re)loads; a
// response being built stops at its next chunk. The response body itself belongs to the webview once sent and
// the IPC copies of the fileKey (JSON numbers) cannot be wiped: zeroization here is best effort, like in JS.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use aes_gcm::aead::{Nonce, Tag};
use aes_gcm::{AeadInOut, Aes256Gcm, KeyInit};
use hkdf::Hkdf;
use sha2::Sha256;
use tauri::http::{HeaderName, HeaderValue, Method, Request, Response, StatusCode, header};
use tauri::{AppHandle, Manager, Runtime, State, UriSchemeContext, UriSchemeResponder};
use zeroize::Zeroizing;

/// URI scheme name (CSP media-src allows `czstream:` and `http(s)://czstream.localhost`).
pub const SCHEME: &str = "czstream";
/// The only webview allowed to use the protocol.
const MAIN_WEBVIEW: &str = "main";

const MAGIC: [u8; 8] = [0x89, b'C', b'Z', b'D', 0x0d, 0x0a, 0x1a, 0x0a];
const FORMAT_VERSION: u8 = 2;
const PAYLOAD_INFO: &[u8] = b"cZEROde czd2 payload";
const TAG_LEN: u64 = 16;
const CHUNK_EXP_MIN: u8 = 12;
const CHUNK_EXP_MAX: u8 = 24;
/// Smallest header: 28 fixed bytes, one empty stanza, metaNonce + metaLen, the smallest metadata, the MAC.
const HEADER_LEN_MIN: u64 = 28 + 3 + 16 + 272 + 32;
/// Largest header: four 1 KiB stanzas and 1 MiB + 16 of metadata (container.js LIMITS).
const HEADER_LEN_MAX: u64 = 28 + 4 * (3 + 1024) + 16 + (1 << 20) + 16 + 32;
/// Number.MAX_SAFE_INTEGER: every size the page sends is a JS number.
const MAX_SAFE: u64 = (1 << 53) - 1;
/// Live registrations; the oldest one is dropped to make room (the page unregisters what it stops using).
const MAX_STREAMS: usize = 512;
/// Plaintext bytes in one response before rounding up to the end of the chunk that holds the last one.
const RESPONSE_WINDOW: u64 = 4 << 20;
const CSP: &str = "default-src 'none'; sandbox";
/// Prefix of the refusal on platforms whose webview cannot play media from a custom scheme (the page maps it
/// to CzdError('unsupported-media') and stops asking).
const UNSUPPORTED: &str =
    "czstream: unsupported: this webview cannot play media from a custom URI scheme";
const OCTET_STREAM: &str = "application/octet-stream";

// ───────── validation (mirrors app/util/format.js and app/crypto/container.js)

/// 16 random bytes in RFC 4648 base32 without padding (the page's token; sw-stream.js TOKEN_RE).
pub(crate) fn is_token(s: &str) -> bool {
    s.len() == 26
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
}

/// A vault item id: 16 bytes as 32 lowercase hex characters.
pub(crate) fn is_item_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The characters JS `String.prototype.trim()` removes.
fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn is_mime_token(s: &str) -> bool {
    (1..=60).contains(&s.len())
        && s.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'+' | b'-')
        })
}

/// format.safeMediaType: image/(png|jpeg|gif|webp|avif|bmp) (with the usual aliases), audio/<token>,
/// video/<token>, parameters dropped, lowercase; anything else is application/octet-stream.
pub(crate) fn safe_media_type(t: &str) -> String {
    let base = t
        .split(';')
        .next()
        .unwrap_or_default()
        .trim_matches(is_js_space)
        .to_lowercase();
    let Some((major, minor)) = base.split_once('/') else {
        return OCTET_STREAM.into();
    };
    if !is_mime_token(major) || !is_mime_token(minor) {
        return OCTET_STREAM.into();
    }
    match major {
        "image" => {
            let sub = match minor {
                "jpg" | "pjpeg" => "jpeg",
                "x-png" => "png",
                "x-ms-bmp" | "x-bmp" => "bmp",
                other => other,
            };
            if ["png", "jpeg", "gif", "webp", "avif", "bmp"].contains(&sub) {
                format!("image/{sub}")
            } else {
                OCTET_STREAM.into()
            }
        }
        "audio" | "video" => base,
        _ => OCTET_STREAM.into(),
    }
}

/// Padmé padded length, exactly like container.js `padme` (None only on u64 overflow).
pub(crate) fn padme(len: u64) -> Option<u64> {
    if len < 2 {
        return Some(len);
    }
    let e = u64::from(63 - len.leading_zeros()); // floor(log2 len) ≥ 1
    let s = u64::from(64 - e.leading_zeros()); // floor(log2 e) + 1 ≤ e
    let mask = (1u64 << (e - s)) - 1;
    Some(len.checked_add(mask)? & !mask)
}

/// Where the payload chunks are, from the values the page read out of the (authenticated) header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Layout {
    pub header_len: u64,
    pub chunk_exp: u8,
    pub size: u64,
    pub padded_size: u64,
}

impl Layout {
    pub(crate) fn new(
        header_len: u64,
        chunk_exp: u8,
        size: u64,
        padded_size: u64,
    ) -> Result<Self, String> {
        if !(CHUNK_EXP_MIN..=CHUNK_EXP_MAX).contains(&chunk_exp) {
            return Err(format!("czstream: chunk_exp {chunk_exp} out of range"));
        }
        if !(HEADER_LEN_MIN..=HEADER_LEN_MAX).contains(&header_len) {
            return Err(format!("czstream: header_len {header_len} out of range"));
        }
        if size > padded_size || padme(size) != Some(padded_size) {
            return Err(format!(
                "czstream: padded_size {padded_size} does not match size {size}"
            ));
        }
        let layout = Self {
            header_len,
            chunk_exp,
            size,
            padded_size,
        };
        match layout.container_size() {
            Some(total) if total <= MAX_SAFE => Ok(layout),
            _ => Err("czstream: size too large".into()),
        }
    }

    pub(crate) fn chunk_size(&self) -> u64 {
        1 << self.chunk_exp
    }

    /// n = max(1, ceil(paddedSize / CS)): padded, not real, size (a padding-only last chunk exists).
    pub(crate) fn chunks(&self) -> u64 {
        self.padded_size.div_ceil(self.chunk_size()).max(1)
    }

    /// Plaintext length of chunk i: CS, except the last (paddedSize − (n−1)·CS; 0 only for paddedSize 0).
    pub(crate) fn chunk_len(&self, i: u64) -> u64 {
        let n = self.chunks();
        if i + 1 == n {
            self.padded_size - (n - 1) * self.chunk_size()
        } else {
            self.chunk_size()
        }
    }

    /// File offset of chunk i's ciphertext.
    pub(crate) fn chunk_offset(&self, i: u64) -> u64 {
        self.header_len + i * (self.chunk_size() + TAG_LEN)
    }

    /// headerLen + paddedSize + 16·n (container.js containerSize).
    pub(crate) fn container_size(&self) -> Option<u64> {
        self.header_len
            .checked_add(self.padded_size)?
            .checked_add(TAG_LEN.checked_mul(self.chunks())?)
    }
}

/// HKDF-SHA256(ikm = fileKey, salt = streamSalt, info = "cZEROde czd2 payload") → 32-byte AES key.
pub(crate) fn payload_key(
    file_key: &[u8],
    stream_salt: &[u8],
) -> Result<Zeroizing<[u8; 32]>, String> {
    let mut okm = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(stream_salt), file_key)
        .expand(PAYLOAD_INFO, okm.as_mut_slice())
        .map_err(|_| "czstream: HKDF failed".to_string())?;
    Ok(okm)
}

/// AES-GCM nonce of chunk i: BE88(i) ‖ final flag.
fn chunk_nonce(i: u64, last: bool) -> Nonce<Aes256Gcm> {
    let mut n = [0u8; 12];
    n[3..11].copy_from_slice(&i.to_be_bytes());
    n[11] = u8::from(last);
    n.into()
}

// ───────── decryption

/// Why a response body could not be produced.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ReadError {
    /// Unregistered or cleared while the response was being built.
    Revoked,
    /// The item file is gone.
    Missing,
    /// Short file, failed tag or non-zero padding.
    Corrupt,
    /// Any other I/O failure.
    Io,
}

impl ReadError {
    fn status(&self) -> StatusCode {
        match self {
            Self::Revoked | Self::Missing => StatusCode::NOT_FOUND,
            Self::Corrupt | Self::Io => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

fn io_error(e: &io::Error) -> ReadError {
    match e.kind() {
        io::ErrorKind::NotFound => ReadError::Missing,
        io::ErrorKind::UnexpectedEof => ReadError::Corrupt,
        _ => ReadError::Io,
    }
}

/// Plaintext bytes [start, start + len) (len ≥ 1, start + len ≤ size): reads, authenticates and decrypts
/// only the chunks that cover them, checking that bytes past `size` are zero (container.js openChunk).
pub(crate) fn read_plain<F: Read + Seek>(
    file: &mut F,
    layout: &Layout,
    pay_key: &[u8; 32],
    start: u64,
    len: u64,
    revoked: &AtomicBool,
) -> Result<Vec<u8>, ReadError> {
    let end = start
        .checked_add(len)
        .filter(|&e| len > 0 && e <= layout.size)
        .ok_or(ReadError::Corrupt)?
        - 1;
    let cipher = Aes256Gcm::new_from_slice(pay_key).map_err(|_| ReadError::Io)?;
    let cs = layout.chunk_size();
    let n = layout.chunks();
    let (c0, c1) = (start / cs, end / cs);
    let out_len = usize::try_from(len).map_err(|_| ReadError::Io)?;
    // Exact capacity: the Vec never reallocates, so no stray plaintext copy is left behind.
    let mut out = Zeroizing::new(Vec::with_capacity(out_len));
    let mut buf = Zeroizing::new(vec![0u8; (cs + TAG_LEN) as usize]);
    file.seek(SeekFrom::Start(layout.chunk_offset(c0)))
        .map_err(|e| io_error(&e))?;
    for c in c0..=c1 {
        if revoked.load(Ordering::Acquire) {
            return Err(ReadError::Revoked);
        }
        let pt_len = layout.chunk_len(c) as usize;
        let chunk = &mut buf[..pt_len + TAG_LEN as usize];
        file.read_exact(chunk).map_err(|e| io_error(&e))?;
        let (data, tag) = chunk.split_at_mut(pt_len);
        let tag = Tag::<Aes256Gcm>::try_from(&*tag).map_err(|_| ReadError::Corrupt)?;
        cipher
            .decrypt_inout_detached(&chunk_nonce(c, c + 1 == n), &[], data.into(), &tag)
            .map_err(|_| ReadError::Corrupt)?;
        let data_end = layout.size.saturating_sub(c * cs).min(pt_len as u64) as usize;
        if data[data_end..].iter().any(|&b| b != 0) {
            return Err(ReadError::Corrupt);
        }
        let a = if c == c0 {
            (start - c * cs) as usize
        } else {
            0
        };
        let b = if c == c1 {
            (end - c * cs + 1) as usize
        } else {
            pt_len
        };
        out.extend_from_slice(&data[a..b]);
    }
    Ok(std::mem::take(&mut *out))
}

// ───────── HTTP: Range parsing and response plans (sw-stream.js parseRange / serveMedia)

/// What a `Range` header asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RangeReq {
    /// No usable header (absent, malformed, several ranges, last < first): the whole payload.
    Whole,
    /// Inclusive byte range, end already clipped to size − 1.
    Bytes { start: u64, end: u64 },
    /// 416.
    Unsatisfiable,
}

fn split_digits(s: &str) -> (Option<u128>, &str) {
    let k = s.bytes().take_while(u8::is_ascii_digit).count();
    let (d, rest) = s.split_at(k);
    let value = (k > 0).then(|| {
        d.bytes().fold(0u128, |acc, b| {
            acc.saturating_mul(10).saturating_add(u128::from(b - b'0'))
        })
    });
    (value, rest)
}

fn skip_ws(s: &str) -> &str {
    s.trim_start_matches(|c: char| c.is_ascii_whitespace())
}

/// `bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*` (case-insensitive "bytes") → the two digit groups.
fn range_groups(h: &str) -> Option<(Option<u128>, Option<u128>)> {
    let rest = h
        .get(..5)
        .filter(|p| p.eq_ignore_ascii_case("bytes"))
        .and_then(|_| h.get(5..))?;
    let rest = skip_ws(rest).strip_prefix('=')?;
    let (first, rest) = split_digits(skip_ws(rest));
    let rest = skip_ws(rest).strip_prefix('-')?;
    let (last, rest) = split_digits(skip_ws(rest));
    skip_ws(rest).is_empty().then_some((first, last))
}

/// One `bytes=` range against `total`, exactly like sw-stream.js parseRange: `bytes=a-b`, `bytes=a-`,
/// `bytes=-k` (case-insensitive, optional spaces). A multi-range or otherwise malformed header, or one whose
/// last byte is before its first, is ignored (whole payload, 200); a start at or past the end, `-0` or any
/// range of an empty payload is unsatisfiable (416).
pub(crate) fn parse_range(header: Option<&str>, total: u64) -> RangeReq {
    let Some((first, last)) = header.and_then(|h| range_groups(h.trim_matches(is_js_space))) else {
        return RangeReq::Whole;
    };
    let total128 = u128::from(total);
    match (first, last) {
        (None, None) => RangeReq::Whole,
        (None, Some(k)) => {
            if k == 0 || total == 0 {
                RangeReq::Unsatisfiable
            } else {
                // k < total here, so the cast is lossless.
                let start = if k < total128 { total - k as u64 } else { 0 };
                RangeReq::Bytes {
                    start,
                    end: total - 1,
                }
            }
        }
        (Some(start), last) => {
            let last = last.unwrap_or(u128::MAX);
            if last < start {
                RangeReq::Whole
            } else if start >= total128 {
                RangeReq::Unsatisfiable
            } else {
                // Both below total (a u64) here.
                RangeReq::Bytes {
                    start: start as u64,
                    end: last.min(total128 - 1) as u64,
                }
            }
        }
    }
}

/// What to send.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    /// 416 + `Content-Range: bytes */size`.
    Unsatisfiable,
    /// 200 (`partial` false) or 206 with plaintext [start, start + len).
    Send { partial: bool, start: u64, len: u64 },
}

/// Turns a range into a response plan, capping the body at `window` bytes rounded up to a chunk end.
pub(crate) fn plan(range: RangeReq, total: u64, chunk_size: u64, window: u64) -> Plan {
    let (start, mut end, mut partial) = match range {
        RangeReq::Unsatisfiable => return Plan::Unsatisfiable,
        RangeReq::Whole if total == 0 => {
            return Plan::Send {
                partial: false,
                start: 0,
                len: 0,
            };
        }
        RangeReq::Whole => (0, total - 1, false),
        RangeReq::Bytes { start, end } => (start, end, true),
    };
    let window = window.max(1);
    if end - start >= window {
        let cap = start + window - 1;
        let chunk_end = (cap / chunk_size + 1) * chunk_size - 1;
        if chunk_end < end {
            end = chunk_end;
            partial = true;
        }
    }
    Plan::Send {
        partial,
        start,
        len: end - start + 1,
    }
}

fn with_security_headers(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    let mut res = Response::new(body);
    *res.status_mut() = status;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

fn set(res: &mut Response<Vec<u8>>, name: HeaderName, value: &str) {
    if let Ok(v) = HeaderValue::from_str(value) {
        res.headers_mut().insert(name, v);
    }
}

/// A refusal: text/plain (with nosniff and no type a refused navigation would turn into a download).
fn refuse(status: StatusCode) -> Response<Vec<u8>> {
    let mut res = with_security_headers(status, status.as_str().as_bytes().to_vec());
    set(&mut res, header::CONTENT_TYPE, "text/plain; charset=utf-8");
    res
}

// ───────── registrations

/// One registered stream. Deliberately not Debug: it holds a key.
pub(crate) struct Entry {
    path: PathBuf,
    pay_key: Zeroizing<[u8; 32]>,
    layout: Layout,
    stream_salt: [u8; 16],
    mime: String,
    revoked: AtomicBool,
    seq: u64,
}

impl Entry {
    /// Validates a registration (everything but the token) and derives the payload key.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        items_dir: &Path,
        id: &str,
        file_key: &[u8],
        stream_salt: &[u8],
        header_len: u64,
        chunk_exp: u8,
        size: u64,
        padded_size: u64,
        mime: &str,
    ) -> Result<Self, String> {
        if !is_item_id(id) {
            return Err("czstream: bad item id".into());
        }
        if file_key.len() != 32 {
            return Err("czstream: file_key must be 32 bytes".into());
        }
        let stream_salt: [u8; 16] = stream_salt
            .try_into()
            .map_err(|_| "czstream: stream_salt must be 16 bytes".to_string())?;
        let layout = Layout::new(header_len, chunk_exp, size, padded_size)?;
        Ok(Self {
            path: items_dir.join(format!("{id}.czd")),
            pay_key: payload_key(file_key, &stream_salt)?,
            layout,
            stream_salt,
            mime: safe_media_type(mime),
            revoked: AtomicBool::new(false),
            seq: 0,
        })
    }

    /// The item file must be this container: exact length, magic, version, flags, chunk size, stream salt.
    pub(crate) fn check_file(&self) -> Result<(), String> {
        let mut f = File::open(&self.path).map_err(|e| format!("czstream: item file: {e}"))?;
        let len = f
            .metadata()
            .map_err(|e| format!("czstream: item file: {e}"))?
            .len();
        if Some(len) != self.layout.container_size() {
            return Err("czstream: item file size does not match".into());
        }
        let mut head = [0u8; 28];
        f.read_exact(&mut head)
            .map_err(|e| format!("czstream: item file: {e}"))?;
        if head[..8] != MAGIC
            || head[8] != FORMAT_VERSION
            || head[9] != 0
            || head[10] != self.layout.chunk_exp
            || head[12..28] != self.stream_salt
        {
            return Err("czstream: item file header does not match".into());
        }
        Ok(())
    }

    fn revoke(&self) {
        self.revoked.store(true, Ordering::Release);
    }

    fn read(&self, start: u64, len: u64) -> Result<Vec<u8>, ReadError> {
        let mut file = File::open(&self.path).map_err(|e| io_error(&e))?;
        read_plain(
            &mut file,
            &self.layout,
            &self.pay_key,
            start,
            len,
            &self.revoked,
        )
    }

    /// The response for a GET/HEAD with an optional Range header.
    pub(crate) fn respond(
        &self,
        head: bool,
        range: Option<&str>,
        window: u64,
    ) -> Response<Vec<u8>> {
        let total = self.layout.size;
        match plan(
            parse_range(range, total),
            total,
            self.layout.chunk_size(),
            window,
        ) {
            Plan::Unsatisfiable => {
                let mut res = with_security_headers(StatusCode::RANGE_NOT_SATISFIABLE, Vec::new());
                set(&mut res, header::CONTENT_TYPE, &self.mime);
                set(&mut res, header::ACCEPT_RANGES, "bytes");
                set(&mut res, header::CONTENT_RANGE, &format!("bytes */{total}"));
                set(&mut res, header::CONTENT_LENGTH, "0");
                res
            }
            Plan::Send {
                partial,
                start,
                len,
            } => {
                let body = if head || len == 0 {
                    Vec::new()
                } else {
                    match self.read(start, len) {
                        Ok(body) => body,
                        Err(e) => return refuse(e.status()),
                    }
                };
                let status = if partial {
                    StatusCode::PARTIAL_CONTENT
                } else {
                    StatusCode::OK
                };
                let mut res = with_security_headers(status, body);
                set(&mut res, header::CONTENT_TYPE, &self.mime);
                set(&mut res, header::ACCEPT_RANGES, "bytes");
                set(&mut res, header::CONTENT_LENGTH, &len.to_string());
                if partial {
                    let range = format!("bytes {start}-{}/{total}", start + len - 1);
                    set(&mut res, header::CONTENT_RANGE, &range);
                }
                res
            }
        }
    }
}

#[derive(Default)]
struct Registry {
    map: HashMap<String, Arc<Entry>>,
    seq: u64,
    /// Bumped by every clear: a registration that started before a lock is not inserted after it.
    epoch: u64,
}

/// token → registered stream (Tauri managed state).
#[derive(Default)]
pub struct Streams(Mutex<Registry>);

impl Streams {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The current clear epoch (taken when a registration starts, checked by `insert`).
    pub(crate) fn epoch(&self) -> u64 {
        self.registry().epoch
    }

    /// Adds a stream unless the registry was cleared since `epoch` (the page locked meanwhile).
    pub(crate) fn insert(&self, token: &str, mut entry: Entry, epoch: u64) -> Result<(), String> {
        if !is_token(token) {
            return Err("czstream: bad token".into());
        }
        let mut reg = self.registry();
        if reg.epoch != epoch {
            return Err("czstream: cleared while registering".into());
        }
        if reg.map.contains_key(token) {
            return Err("czstream: token already registered".into());
        }
        while reg.map.len() >= MAX_STREAMS {
            let Some(oldest) = reg
                .map
                .iter()
                .min_by_key(|(_, e)| e.seq)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(e) = reg.map.remove(&oldest) {
                e.revoke();
            }
        }
        reg.seq += 1;
        entry.seq = reg.seq;
        reg.map.insert(token.to_owned(), Arc::new(entry));
        Ok(())
    }

    /// Drops one stream (its key is wiped once no response is using it). True if it existed.
    pub(crate) fn remove(&self, token: &str) -> bool {
        let entry = self.registry().map.remove(token);
        entry.map(|e| e.revoke()).is_some()
    }

    /// Drops every stream, including registrations still being checked; returns how many there were.
    pub fn clear(&self) -> usize {
        let drained: Vec<_> = {
            let mut reg = self.registry();
            reg.epoch += 1;
            reg.map.drain().map(|(_, e)| e).collect()
        };
        for e in &drained {
            e.revoke();
        }
        drained.len()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.registry().map.len()
    }

    fn get(&self, token: &str) -> Option<Arc<Entry>> {
        self.registry().map.get(token).cloned()
    }

    /// One protocol request: `path` is the URL path ("/<token>").
    pub(crate) fn serve(
        &self,
        method: &Method,
        path: &str,
        range: Option<&str>,
        window: u64,
    ) -> Response<Vec<u8>> {
        if method != Method::GET && method != Method::HEAD {
            let mut res = refuse(StatusCode::METHOD_NOT_ALLOWED);
            set(&mut res, header::ALLOW, "GET, HEAD");
            return res;
        }
        let token = path.strip_prefix('/').unwrap_or(path);
        let entry = if is_token(token) {
            self.get(token)
        } else {
            None
        };
        match entry {
            Some(e) => e.respond(method == Method::HEAD, range, window),
            None => refuse(StatusCode::NOT_FOUND),
        }
    }
}

/// Whether media elements can play czstream URLs here (see the Linux note at the top). Debug builds accept
/// CZSTREAM_LINUX=1 so the protocol itself can still be exercised in WebKitGTK by a smoke test.
fn media_supported() -> bool {
    if !cfg!(target_os = "linux") {
        return true;
    }
    cfg!(debug_assertions) && std::env::var_os("CZSTREAM_LINUX").is_some_and(|v| v == "1")
}

/// Plaintext bytes per response; debug builds accept CZSTREAM_WINDOW (bytes) so smoke tests can force
/// many short 206 responses with a small video.
fn response_window() -> u64 {
    #[cfg(debug_assertions)]
    if let Some(w) = std::env::var("CZSTREAM_WINDOW")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&w| w > 0)
    {
        return w;
    }
    RESPONSE_WINDOW
}

// ───────── Tauri glue

/// The `czstream` protocol handler (registered with `register_asynchronous_uri_scheme_protocol`):
/// file I/O and decryption run on the blocking thread pool, never on the main thread.
pub fn protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let trusted = ctx.webview_label() == MAIN_WEBVIEW;
    tauri::async_runtime::spawn_blocking(move || {
        let response = match app.try_state::<Streams>() {
            Some(streams) if trusted => {
                let range = request
                    .headers()
                    .get(header::RANGE)
                    .and_then(|v| v.to_str().ok());
                streams.serve(
                    request.method(),
                    request.uri().path(),
                    range,
                    response_window(),
                )
            }
            Some(_) => refuse(StatusCode::FORBIDDEN),
            None => refuse(StatusCode::NOT_FOUND),
        };
        responder.respond(response);
    });
}

/// Registers an opened vault item for streaming (DESIGN §5.3). The page builds the URL itself with
/// `convertFileSrc(token, 'czstream')`. Fails (the page then plays a Blob) on Linux (UNSUPPORTED), on any
/// invalid value, or when `$APPDATA/vault2/items/<id>.czd` is not exactly the described container.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stream_register<R: Runtime>(
    app: AppHandle<R>,
    streams: State<'_, Streams>,
    token: String,
    id: String,
    file_key: Vec<u8>,
    stream_salt: Vec<u8>,
    header_len: u64,
    chunk_exp: u8,
    size: u64,
    padded_size: u64,
    mime: String,
) -> Result<(), String> {
    let file_key = Zeroizing::new(file_key);
    if !media_supported() {
        return Err(UNSUPPORTED.into());
    }
    if !is_token(&token) {
        return Err("czstream: bad token".into());
    }
    let epoch = streams.epoch();
    let items = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("czstream: {e}"))?
        .join("vault2")
        .join("items");
    let entry = Entry::new(
        &items,
        &id,
        &file_key,
        &stream_salt,
        header_len,
        chunk_exp,
        size,
        padded_size,
        &mime,
    )?;
    drop(file_key);
    let entry = tauri::async_runtime::spawn_blocking(move || entry.check_file().map(|()| entry))
        .await
        .map_err(|e| format!("czstream: {e}"))??;
    streams.insert(&token, entry, epoch)
}

/// Drops one stream (unknown tokens are fine: the page may unregister twice).
#[tauri::command]
pub fn stream_unregister(streams: State<'_, Streams>, token: String) -> Result<(), String> {
    if !is_token(&token) {
        return Err("czstream: bad token".into());
    }
    streams.remove(&token);
    Ok(())
}

/// Drops every stream (the page locked).
#[tauri::command]
pub fn stream_clear(streams: State<'_, Streams>) {
    streams.clear();
}

#[cfg(test)]
mod tests {
    // Golden vectors (tests/vectors/czd2/czd2.json, written by scripts/gen-vectors.mjs with the JS container
    // code) and the czstream extras (rust-vectors.json, scripts/gen-rust-vectors.mjs) decrypted through the
    // same read/Range/response path the protocol uses; plus the 17,039,359-byte vector rebuilt from its seed,
    // tamper cases, the shared Range table (rust-ranges.json, also checked against sw-stream.js) and the
    // registration rules.
    use super::*;
    use serde_json::Value;
    use sha2::Digest;
    use std::fs;
    use std::sync::atomic::AtomicU64;

    fn vectors_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/vectors/czd2")
    }

    fn read_json(name: &str) -> Value {
        let text = fs::read_to_string(vectors_dir().join(name)).expect(name);
        serde_json::from_str(&text).expect(name)
    }

    fn hex(s: &str) -> Vec<u8> {
        assert!(s.len().is_multiple_of(2), "odd hex length");
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
            .collect()
    }

    fn sha_hex(b: &[u8]) -> String {
        Sha256::digest(b)
            .iter()
            .map(|x| format!("{x:02x}"))
            .collect()
    }

    /// prngBytes of scripts/gen-vectors.mjs (mulberry32, u32 little-endian per step).
    fn mulberry32(seed: u32, n: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(n + 3);
        let mut a = seed;
        while out.len() < n {
            a = a.wrapping_add(0x6d2b_79f5);
            let mut t = (a ^ (a >> 15)).wrapping_mul(a | 1);
            t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
            out.extend_from_slice(&(t ^ (t >> 14)).to_le_bytes());
        }
        out.truncate(n);
        out
    }

    /// Deterministic xorshift64* for random ranges.
    struct Rng(u64);
    impl Rng {
        fn below(&mut self, n: u64) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) % n.max(1)
        }
    }

    /// A scratch directory removed on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "czstream-test-{}-{}-{name}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).expect("scratch dir");
            Self(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const ID: &str = "0123456789abcdef0123456789abcdef";
    const TOKEN: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    struct Vector {
        id: String,
        file: PathBuf,
        file_key: Vec<u8>,
        salt: Vec<u8>,
        layout: Layout,
        plaintext_sha: String,
        json: Value,
    }

    fn load(name: &str) -> Vec<Vector> {
        let j = read_json(name);
        j["vectors"]
            .as_array()
            .expect("vectors")
            .iter()
            .map(|v| {
                let n = |k: &str| v[k].as_u64().unwrap_or_else(|| panic!("{k}"));
                let layout = Layout::new(
                    n("headerLen"),
                    u8::try_from(n("chunkExp")).expect("chunkExp"),
                    n("size"),
                    n("paddedSize"),
                )
                .expect("layout");
                assert_eq!(layout.chunks(), n("n"), "n of {}", v["id"]);
                assert_eq!(layout.container_size(), Some(n("containerSize")));
                Vector {
                    id: v["id"].as_str().expect("id").to_owned(),
                    file: vectors_dir().join(v["file"].as_str().expect("file")),
                    file_key: hex(v["fileKeyHex"].as_str().expect("fileKeyHex")),
                    salt: hex(v["streamSaltHex"].as_str().expect("streamSaltHex")),
                    layout,
                    plaintext_sha: v["plaintextSha256"].as_str().expect("sha").to_owned(),
                    json: v.clone(),
                }
            })
            .collect()
    }

    /// An Entry for a file anywhere on disk (Entry::new derives the path from the item id).
    fn entry_at(path: &Path, file_key: &[u8], salt: &[u8], l: Layout, mime: &str) -> Entry {
        let mut e = Entry::new(
            Path::new("/unused"),
            ID,
            file_key,
            salt,
            l.header_len,
            l.chunk_exp,
            l.size,
            l.padded_size,
            mime,
        )
        .expect("entry");
        e.path = path.to_path_buf();
        e
    }

    fn header(res: &Response<Vec<u8>>, name: HeaderName) -> Option<String> {
        res.headers()
            .get(name)
            .map(|v| v.to_str().expect("ascii").to_owned())
    }

    /// (start, end) of a `bytes a-b/total` Content-Range.
    fn content_range(res: &Response<Vec<u8>>, total: u64) -> (u64, u64) {
        let cr = header(res, header::CONTENT_RANGE).expect("Content-Range");
        let (range, t) = cr
            .strip_prefix("bytes ")
            .and_then(|r| r.split_once('/'))
            .expect("bytes a-b/total");
        assert_eq!(t, total.to_string());
        let (a, b) = range.split_once('-').expect("a-b");
        (a.parse().expect("a"), b.parse().expect("b"))
    }

    fn assert_security_headers(res: &Response<Vec<u8>>) {
        assert_eq!(
            header(res, header::CONTENT_SECURITY_POLICY).as_deref(),
            Some("default-src 'none'; sandbox")
        );
        assert_eq!(
            header(res, header::X_CONTENT_TYPE_OPTIONS).as_deref(),
            Some("nosniff")
        );
        assert_eq!(
            header(res, header::CACHE_CONTROL).as_deref(),
            Some("no-store")
        );
        assert!(
            res.headers().get("cross-origin-resource-policy").is_none(),
            "CORP same-origin would block the cross-origin media element"
        );
    }

    /// Follows short 206 answers like a media element: `bytes=<pos>-` until the end.
    fn read_by_windows(e: &Entry, window: u64) -> Vec<u8> {
        let total = e.layout.size;
        let mut out = Vec::new();
        while (out.len() as u64) < total {
            let pos = out.len() as u64;
            let res = e.respond(false, Some(&format!("bytes={pos}-")), window);
            assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
            let (a, b) = content_range(&res, total);
            assert_eq!(a, pos);
            assert!(b - a < window + e.layout.chunk_size(), "window respected");
            assert_eq!(res.body().len() as u64, b - a + 1);
            out.extend_from_slice(res.body());
        }
        out
    }

    /// The whole plaintext through the protocol path, then windows and random ranges against it.
    fn check_vector(e: &Entry, plaintext_sha: &str, seed: u64, ranges: usize) -> Vec<u8> {
        let total = e.layout.size;
        let full = e.respond(false, None, u64::MAX);
        assert_eq!(full.status(), StatusCode::OK);
        assert_security_headers(&full);
        assert_eq!(
            header(&full, header::ACCEPT_RANGES).as_deref(),
            Some("bytes")
        );
        assert_eq!(
            header(&full, header::CONTENT_LENGTH),
            Some(total.to_string())
        );
        assert!(header(&full, header::CONTENT_RANGE).is_none());
        let plain = full.body().clone();
        assert_eq!(sha_hex(&plain), plaintext_sha);
        if total == 0 {
            let res = e.respond(false, Some("bytes=0-"), u64::MAX);
            assert_eq!(res.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            return plain;
        }
        let cs = e.layout.chunk_size();
        assert_eq!(read_by_windows(e, RESPONSE_WINDOW), plain);
        if total <= 1 << 20 {
            // Many short answers cost one chunk decrypt each: only for small files.
            assert_eq!(read_by_windows(e, 1000), plain);
        }
        assert_eq!(read_by_windows(e, cs), plain);
        let mut rng = Rng(seed | 1);
        let check = |hdr: String, a: u64, b: u64| {
            let res = e.respond(false, Some(&hdr), u64::MAX);
            assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT, "{hdr}");
            assert_eq!(content_range(&res, total), (a, b), "{hdr}");
            assert_eq!(
                header(&res, header::CONTENT_LENGTH),
                Some((b - a + 1).to_string())
            );
            assert!(
                res.body()[..] == plain[a as usize..=b as usize],
                "body of {hdr} (total {total})"
            );
        };
        // Chunk edges, then random ranges.
        for c in 0..e.layout.chunks() {
            for p in [c * cs, (c * cs + cs - 1), c * cs + cs] {
                if p < total {
                    check(format!("bytes={p}-{p}"), p, p);
                }
            }
        }
        for i in 0..ranges {
            let a = rng.below(total);
            match i % 3 {
                0 => {
                    let b = a + rng.below(total - a);
                    check(format!("bytes={a}-{b}"), a, b);
                }
                1 => check(format!("bytes={a}-"), a, total - 1),
                _ => {
                    let k = 1 + rng.below(total);
                    check(format!("bytes=-{k}"), total - k, total - 1);
                }
            }
        }
        let res = e.respond(false, Some(&format!("bytes={total}-")), u64::MAX);
        assert_eq!(res.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            header(&res, header::CONTENT_RANGE),
            Some(format!("bytes */{total}"))
        );
        assert!(res.body().is_empty());
        plain
    }

    #[test]
    fn golden_vectors_decrypt_through_every_range_path() {
        let vectors = load("czd2.json");
        assert_eq!(vectors.len(), 10, "every committed golden vector");
        for (i, v) in vectors.iter().enumerate() {
            let bytes = fs::read(&v.file).expect("vector file");
            assert_eq!(
                sha_hex(&bytes),
                v.json["containerSha256"].as_str().unwrap(),
                "{}",
                v.id
            );
            let e = entry_at(
                &v.file,
                &v.file_key,
                &v.salt,
                v.layout,
                "application/octet-stream",
            );
            e.check_file()
                .unwrap_or_else(|err| panic!("{}: {err}", v.id));
            let plain = check_vector(&e, &v.plaintext_sha, 0x9e37 + i as u64, 60);
            if let Some(seed) = v.json["seed"].as_u64() {
                let seed = u32::try_from(seed).expect("u32 seed");
                assert!(plain == mulberry32(seed, plain.len()), "{} prng", v.id);
            }
            // Bundle entries: random access by entry offset.
            if let Some(entries) = v.json["meta"]["entries"].as_array() {
                let shas = v.json["entrySha256"].as_array().expect("entrySha256");
                for (ent, sha) in entries.iter().zip(shas) {
                    let (off, size) = (ent["off"].as_u64().unwrap(), ent["size"].as_u64().unwrap());
                    let got = if size == 0 {
                        Vec::new()
                    } else {
                        let res = e.respond(
                            false,
                            Some(&format!("bytes={off}-{}", off + size - 1)),
                            u64::MAX,
                        );
                        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
                        res.body().clone()
                    };
                    assert_eq!(sha_hex(&got), sha.as_str().unwrap());
                }
            }
        }
    }

    #[test]
    fn rust_vectors_cover_padding_chunk_and_chunk_sizes() {
        let vectors = load("rust-vectors.json");
        let ids: Vec<_> = vectors.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "rust-pad-extra",
                "rust-exp12-4097",
                "rust-exp24",
                "rust-3mib"
            ]
        );
        for (i, v) in vectors.iter().enumerate() {
            let e = entry_at(
                &v.file,
                &v.file_key,
                &v.salt,
                v.layout,
                v.json["meta"]["type"].as_str().unwrap(),
            );
            e.check_file()
                .unwrap_or_else(|err| panic!("{}: {err}", v.id));
            let plain = check_vector(&e, &v.plaintext_sha, 0x51ed + i as u64, 80);
            let seed = u32::try_from(v.json["seed"].as_u64().unwrap()).unwrap();
            assert!(plain == mulberry32(seed, plain.len()), "{} prng", v.id);
        }
        // 266,240 B at 4 KiB chunks: 65 data chunks and a 66th that is padding only.
        let pad = &vectors[0].layout;
        assert_eq!(
            (pad.size, pad.padded_size, pad.chunks()),
            (266_240, 270_336, 66)
        );
        assert_eq!(pad.size, 65 * pad.chunk_size());
        assert_eq!(pad.chunk_len(65), 4096);
        // 3 MiB + 777 at 256 KiB chunks: a 64 KiB final chunk.
        let big = &vectors[3].layout;
        assert_eq!((big.chunks(), big.chunk_len(12)), (13, 65_536));
        assert_eq!(vectors[2].layout.chunk_size(), 1 << 24);
    }

    // ───────── a test-only writer (the format of container.js _encryptStreamWith, header contents aside)

    struct Sealed {
        layout: Layout,
        file_key: Vec<u8>,
        salt: [u8; 16],
    }

    /// Writes header (magic, version, flags, chunkExp, k, salt, zero filler) + payload chunks to `path`.
    /// `pad_byte` fills the padding (0 in valid files); `final_at` moves the final-chunk flag.
    fn seal_file(
        path: &Path,
        plain: &[u8],
        chunk_exp: u8,
        pad_byte: u8,
        final_at: Option<u64>,
    ) -> Sealed {
        let size = plain.len() as u64;
        let layout = Layout::new(437, chunk_exp, size, padme(size).unwrap()).unwrap();
        let file_key = mulberry32(size as u32 ^ 0x5eed, 32);
        let salt: [u8; 16] = mulberry32(size as u32 ^ 0x5a17, 16).try_into().unwrap();
        let key = payload_key(&file_key, &salt).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&key[..]).unwrap();
        let mut out = Vec::with_capacity(layout.container_size().unwrap() as usize);
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&[FORMAT_VERSION, 0, chunk_exp, 1]);
        out.extend_from_slice(&salt);
        out.resize(layout.header_len as usize, 0);
        let cs = layout.chunk_size();
        let n = layout.chunks();
        for i in 0..n {
            let len = layout.chunk_len(i) as usize;
            let mut chunk = vec![pad_byte; len];
            let from = (i * cs) as usize;
            if from < plain.len() {
                let take = (plain.len() - from).min(len);
                chunk[..take].copy_from_slice(&plain[from..from + take]);
            }
            let last = final_at.map_or(i + 1 == n, |f| f == i);
            let tag = cipher
                .encrypt_inout_detached(&chunk_nonce(i, last), &[], chunk.as_mut_slice().into())
                .unwrap();
            out.extend_from_slice(&chunk);
            out.extend_from_slice(&tag);
        }
        assert_eq!(Some(out.len() as u64), layout.container_size());
        fs::write(path, &out).unwrap();
        Sealed {
            layout,
            file_key,
            salt,
        }
    }

    fn entry_for(path: &Path, s: &Sealed) -> Entry {
        entry_at(path, &s.file_key, &s.salt, s.layout, "video/webm")
    }

    #[test]
    fn generated_17039359_vector_rebuilt_from_its_seed() {
        // czd2.json "generated": not committed; only the plaintext digest is. 65·CS − 1 bytes pad to 66·CS,
        // so the last chunk is padding only (the Range math must use paddedSize).
        let j = read_json("czd2.json");
        let g = &j["generated"][0];
        let size = g["size"].as_u64().unwrap();
        let seed = u32::try_from(g["seed"].as_u64().unwrap()).unwrap();
        let plain = mulberry32(seed, size as usize);
        assert_eq!(sha_hex(&plain), g["plaintextSha256"].as_str().unwrap());
        let dir = Scratch::new("big");
        let path = dir.0.join("big.czd");
        let s = seal_file(&path, &plain, 18, 0, None);
        assert_eq!(
            (s.layout.padded_size, s.layout.chunks()),
            (g["paddedSize"].as_u64().unwrap(), g["n"].as_u64().unwrap())
        );
        let e = entry_for(&path, &s);
        e.check_file().unwrap();
        check_vector(&e, g["plaintextSha256"].as_str().unwrap(), 0xb16, 40);
        // No Range on a file larger than the window: the first window as a 206 (never the whole video).
        let res = e.respond(false, None, RESPONSE_WINDOW);
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(content_range(&res, size), (0, RESPONSE_WINDOW - 1));
        assert!(res.body()[..] == plain[..RESPONSE_WINDOW as usize]);
    }

    #[test]
    fn tampering_is_detected_per_chunk() {
        let dir = Scratch::new("tamper");
        let plain = mulberry32(77, 10_000); // chunkExp 12: 3 chunks (10,240 padded)
        let path = dir.0.join("t.czd");
        let s = seal_file(&path, &plain, 12, 0, None);
        let good = fs::read(&path).unwrap();
        let e = entry_for(&path, &s);
        assert_eq!(e.respond(false, None, u64::MAX).body(), &plain);

        // A flipped byte in chunk 1: chunk 0 still serves, anything touching chunk 1 fails.
        let mut bad = good.clone();
        bad[(s.layout.chunk_offset(1) + 10) as usize] ^= 1;
        fs::write(&path, &bad).unwrap();
        assert_eq!(
            e.respond(false, Some("bytes=0-4095"), u64::MAX).status(),
            StatusCode::PARTIAL_CONTENT
        );
        let res = e.respond(false, Some("bytes=4000-4200"), u64::MAX);
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            header(&res, header::CONTENT_TYPE).as_deref(),
            Some("text/plain; charset=utf-8")
        );
        assert_security_headers(&res);

        // Truncation: the size check refuses registration, reads of the missing tail fail.
        fs::write(&path, &good[..good.len() - 1]).unwrap();
        assert!(e.check_file().is_err());
        assert_eq!(
            e.respond(false, Some("bytes=9000-"), u64::MAX).status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );

        // Header mismatches.
        for (at, what) in [
            (0usize, "magic"),
            (8, "version"),
            (9, "flags"),
            (10, "chunkExp"),
            (20, "salt"),
        ] {
            let mut h = good.clone();
            h[at] ^= 0x40;
            fs::write(&path, &h).unwrap();
            assert!(e.check_file().is_err(), "{what}");
        }
        fs::write(&path, &good).unwrap();
        e.check_file().unwrap();

        // Wrong key.
        let mut other = s.file_key.clone();
        other[0] ^= 1;
        let wrong = entry_at(&path, &other, &s.salt, s.layout, "video/webm");
        assert_eq!(
            wrong.respond(false, Some("bytes=0-0"), u64::MAX).status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );

        // Missing file → 404.
        fs::remove_file(&path).unwrap();
        assert_eq!(
            e.respond(false, None, u64::MAX).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn padding_must_be_zero_and_final_flag_must_be_last() {
        let dir = Scratch::new("pad");
        let plain = mulberry32(5, 9_000); // padded 9,216: padding at the end of chunk 2
        let path = dir.0.join("p.czd");
        let s = seal_file(&path, &plain, 12, 0xaa, None);
        let e = entry_for(&path, &s);
        assert_eq!(
            e.respond(false, Some("bytes=0-100"), u64::MAX).status(),
            StatusCode::PARTIAL_CONTENT
        );
        assert_eq!(
            e.respond(false, Some("bytes=8500-8600"), u64::MAX).status(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "non-zero padding in the chunk read"
        );
        // Final flag on chunk 1 of 3: chunk 1 and chunk 2 no longer authenticate.
        let s = seal_file(&path, &plain, 12, 0, Some(1));
        let e = entry_for(&path, &s);
        assert_eq!(
            e.respond(false, Some("bytes=0-10"), u64::MAX).status(),
            StatusCode::PARTIAL_CONTENT
        );
        for r in ["bytes=4096-4100", "bytes=8192-8200"] {
            assert_eq!(
                e.respond(false, Some(r), u64::MAX).status(),
                StatusCode::INTERNAL_SERVER_ERROR,
                "{r}"
            );
        }
    }

    #[test]
    fn read_plain_stops_when_revoked() {
        let dir = Scratch::new("revoke");
        let plain = mulberry32(9, 50_000);
        let path = dir.0.join("r.czd");
        let s = seal_file(&path, &plain, 12, 0, None);
        let key = payload_key(&s.file_key, &s.salt).unwrap();
        let mut f = File::open(&path).unwrap();
        let live = AtomicBool::new(false);
        let got = read_plain(&mut f, &s.layout, &key, 100, 20_000, &live).unwrap();
        assert!(got[..] == plain[100..20_100]);
        let gone = AtomicBool::new(true);
        assert_eq!(
            read_plain(&mut f, &s.layout, &key, 0, 10, &gone),
            Err(ReadError::Revoked)
        );
        assert_eq!(
            read_plain(&mut f, &s.layout, &key, 49_999, 2, &live),
            Err(ReadError::Corrupt),
            "a range past size is refused"
        );
    }

    #[test]
    fn range_table_matches_sw_stream() {
        let j = read_json("rust-ranges.json");
        for c in j["cases"].as_array().unwrap() {
            let total = c["total"].as_u64().unwrap();
            let hdr = c["header"].as_str();
            let status = c["status"].as_u64().unwrap();
            let got = plan(parse_range(hdr, total), total, 4096, u64::MAX);
            let want = match (status, c["start"].as_u64(), c["end"].as_u64()) {
                (416, _, _) => Plan::Unsatisfiable,
                (200, None, None) => Plan::Send {
                    partial: false,
                    start: 0,
                    len: 0,
                },
                (s, Some(a), Some(b)) => Plan::Send {
                    partial: s == 206,
                    start: a,
                    len: b - a + 1,
                },
                other => panic!("bad case {other:?}"),
            };
            assert_eq!(got, want, "{hdr:?} of {total}");
        }
    }

    #[test]
    fn plan_caps_bodies_at_the_window_rounded_to_a_chunk_end() {
        let cs = 1 << 18;
        let w = 4 << 20;
        let total = 100 << 20;
        // From a chunk start: exactly the window (16 whole chunks).
        assert_eq!(
            plan(
                RangeReq::Bytes {
                    start: 0,
                    end: total - 1
                },
                total,
                cs,
                w
            ),
            Plan::Send {
                partial: true,
                start: 0,
                len: w
            }
        );
        // From mid-chunk: up to the end of the chunk holding start + window − 1.
        assert_eq!(
            plan(
                RangeReq::Bytes {
                    start: 100,
                    end: total - 1
                },
                total,
                cs,
                w
            ),
            Plan::Send {
                partial: true,
                start: 100,
                len: w + cs - 100
            }
        );
        // Short enough: untouched; the whole payload stays a 200.
        assert_eq!(
            plan(
                RangeReq::Bytes {
                    start: 5,
                    end: 5 + w - 1
                },
                total,
                cs,
                w
            ),
            Plan::Send {
                partial: true,
                start: 5,
                len: w
            }
        );
        assert_eq!(
            plan(RangeReq::Whole, w, cs, w),
            Plan::Send {
                partial: false,
                start: 0,
                len: w
            }
        );
        // The whole of something bigger: a 206 for the first window.
        assert_eq!(
            plan(RangeReq::Whole, total, cs, w),
            Plan::Send {
                partial: true,
                start: 0,
                len: w
            }
        );
        // The rounding never runs past the requested end; chunkExp 24 windows are one chunk.
        assert_eq!(
            plan(
                RangeReq::Bytes {
                    start: 0,
                    end: w + 10
                },
                total,
                1 << 24,
                w
            ),
            Plan::Send {
                partial: true,
                start: 0,
                len: w + 11
            }
        );
        assert_eq!(
            plan(
                RangeReq::Bytes {
                    start: 0,
                    end: total - 1
                },
                total,
                1 << 24,
                w
            ),
            Plan::Send {
                partial: true,
                start: 0,
                len: 1 << 24
            }
        );
    }

    #[test]
    fn padme_matches_container_js() {
        // Values from app/crypto/container.js padme().
        let table: [(u64, u64); 40] = [
            (0, 0),
            (1, 1),
            (2, 2),
            (3, 3),
            (4, 4),
            (5, 5),
            (7, 7),
            (8, 8),
            (9, 10),
            (15, 16),
            (16, 16),
            (17, 18),
            (100, 104),
            (255, 256),
            (256, 256),
            (257, 272),
            (1000, 1024),
            (4095, 4096),
            (4096, 4096),
            (4097, 4352),
            (65535, 65536),
            (65536, 65536),
            (65537, 67584),
            (262_143, 262_144),
            (262_144, 262_144),
            (262_145, 270_336),
            (266_240, 270_336),
            (786_439, 802_816),
            (1_000_000, 1_015_808),
            (3_146_505, 3_211_264),
            (17_039_359, 17_301_504),
            (2_147_483_647, 2_147_483_648),
            (2_147_483_648, 2_147_483_648),
            (2_147_483_649, 2_214_592_512),
            (4_294_967_295, 4_294_967_296),
            (4_294_967_296, 4_294_967_296),
            (4_294_967_297, 4_362_076_160),
            (1_099_511_640_121, 1_116_691_496_960),
            (4_503_599_627_370_497, 4_573_968_371_548_160),
            (9_007_199_254_740_991, 9_007_199_254_740_992),
        ];
        for (n, want) in table {
            assert_eq!(padme(n), Some(want), "padme({n})");
        }
        assert_eq!(padme(u64::MAX), None);
    }

    #[test]
    fn safe_media_type_matches_format_js() {
        // Values from app/util/format.js safeMediaType().
        let long60 = format!("video/{}", "a".repeat(60));
        let long61 = format!("video/{}", "a".repeat(61));
        let table = [
            ("video/webm", "video/webm"),
            ("Video/WebM; codecs=\"vp8, vorbis\"", "video/webm"),
            ("audio/ogg", "audio/ogg"),
            ("image/jpg", "image/jpeg"),
            ("image/svg+xml", OCTET_STREAM),
            ("text/html", OCTET_STREAM),
            ("application/octet-stream", OCTET_STREAM),
            ("video/", OCTET_STREAM),
            ("video", OCTET_STREAM),
            ("  video/mp4  ", "video/mp4"),
            ("video/mp4\u{212a}", "video/mp4k"),
            ("x/y", OCTET_STREAM),
            ("IMAGE/X-PNG", "image/png"),
            ("audio/x-wav", "audio/x-wav"),
            (long61.as_str(), OCTET_STREAM),
            (long60.as_str(), long60.as_str()),
            ("image/pjpeg", "image/jpeg"),
            ("image/x-ms-bmp", "image/bmp"),
            ("text/plain;charset=utf-8", OCTET_STREAM),
            ("", OCTET_STREAM),
            ("video /mp4", OCTET_STREAM),
            ("video/mp4,video/webm", OCTET_STREAM),
            ("image/webp", "image/webp"),
            ("image/tiff", OCTET_STREAM),
            ("application/x-czd-bundle", OCTET_STREAM),
            ("video/quicktime", "video/quicktime"),
            ("\u{feff}video/mp4", "video/mp4"),
            ("video/mp4/x", OCTET_STREAM),
            ("video/mp4\r\nX-Evil: 1", OCTET_STREAM),
        ];
        for (input, want) in table {
            assert_eq!(safe_media_type(input), want, "{input:?}");
        }
    }

    #[test]
    fn payload_key_matches_webcrypto() {
        // size-1 vector: HKDF-SHA256 via crypto.subtle.deriveBits in Node.
        let key = payload_key(
            &hex("22e1e31eef2b7645e12870069a8c2951800d5af1570a7cbd2196d5642e277692"),
            &hex("5d440cb5a974e8399fbb8d9cbb017fb8"),
        )
        .unwrap();
        assert_eq!(
            hex("75e6e3eacef36a957c46f262755f7ad280260d0f6c8910101a1614d2576f0da1"),
            key.to_vec()
        );
        assert_eq!(
            chunk_nonce(0x0102, true).as_slice(),
            &[0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1]
        );
        assert_eq!(chunk_nonce(7, false)[11], 0);
    }

    #[test]
    fn linux_refuses_registrations() {
        // platform.js maps this prefix to CzdError('unsupported-media').
        assert!(UNSUPPORTED.starts_with("czstream: unsupported:"));
        if std::env::var_os("CZSTREAM_LINUX").is_none() {
            assert_eq!(media_supported(), !cfg!(target_os = "linux"));
        }
    }

    #[test]
    fn registration_values_are_validated() {
        let key = [7u8; 32];
        let salt = [9u8; 16];
        let ok = |id: &str, key: &[u8], salt: &[u8], h: u64, e: u8, size: u64, padded: u64| {
            Entry::new(
                Path::new("/items"),
                id,
                key,
                salt,
                h,
                e,
                size,
                padded,
                "video/webm",
            )
        };
        let e = ok(ID, &key, &salt, 437, 18, 1000, 1024).unwrap();
        assert_eq!(e.path, Path::new("/items").join(format!("{ID}.czd")));
        assert_eq!(e.mime, "video/webm");
        for bad_id in [
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "../../../../etc/passwd/aaaaaaaaaaaa",
            "0123456789abcdef0123456789abcdeg",
            "",
        ] {
            assert!(
                ok(bad_id, &key, &salt, 437, 18, 1000, 1024).is_err(),
                "{bad_id}"
            );
        }
        assert!(ok(ID, &key[..31], &salt, 437, 18, 1000, 1024).is_err());
        assert!(ok(ID, &[0u8; 33], &salt, 437, 18, 1000, 1024).is_err());
        assert!(ok(ID, &key, &salt[..15], 437, 18, 1000, 1024).is_err());
        assert!(ok(ID, &key, &[0u8; 17], 437, 18, 1000, 1024).is_err());
        assert!(ok(ID, &key, &salt, 437, 11, 1000, 1024).is_err());
        assert!(ok(ID, &key, &salt, 437, 25, 1000, 1024).is_err());
        assert!(ok(ID, &key, &salt, 437, 12, 1000, 1024).is_ok());
        assert!(ok(ID, &key, &salt, 437, 24, 1000, 1024).is_ok());
        assert!(
            ok(ID, &key, &salt, 437, 18, 1025, 1024).is_err(),
            "size > paddedSize"
        );
        assert!(
            ok(ID, &key, &salt, 437, 18, 1000, 1000).is_err(),
            "paddedSize ≠ padme(size)"
        );
        assert!(ok(ID, &key, &salt, 437, 18, 1000, 2048).is_err());
        assert!(ok(ID, &key, &salt, HEADER_LEN_MIN - 1, 18, 1000, 1024).is_err());
        assert!(ok(ID, &key, &salt, HEADER_LEN_MAX + 1, 18, 1000, 1024).is_err());
        assert!(ok(ID, &key, &salt, HEADER_LEN_MIN, 18, 0, 0).is_ok());
        let huge = MAX_SAFE - 10;
        assert!(
            ok(ID, &key, &salt, 437, 18, huge, padme(huge).unwrap()).is_err(),
            "over 2^53"
        );
        let e = Entry::new(Path::new("/i"), ID, &key, &salt, 437, 18, 1, 1, "text/html").unwrap();
        assert_eq!(e.mime, OCTET_STREAM);
        for t in [TOKEN, "234567ABCDEFGHIJKLMNOPQRST"] {
            assert!(is_token(t), "{t}");
        }
        for t in [
            "ABCDEFGHIJKLMNOPQRSTUVWXY",
            "ABCDEFGHIJKLMNOPQRSTUVWXYZA",
            "abcdefghijklmnopqrstuvwxyz",
            "ABCDEFGHIJKLMNOPQRSTUVWXY1",
            "ABCDEFGHIJKLMNOPQRSTUVWXY=",
            "ABCDEFGHIJKLMNOPQRSTUVWXYÉ",
        ] {
            assert!(!is_token(t), "{t}");
        }
    }

    #[test]
    fn registry_serves_unregisters_clears_and_evicts() {
        let dir = Scratch::new("registry");
        let plain = mulberry32(3, 5000);
        let path = dir.0.join("x.czd");
        let s = seal_file(&path, &plain, 12, 0, None);
        let streams = Streams::default();
        let path_of = |t: &str| format!("/{t}");
        assert!(streams.insert("bad", entry_for(&path, &s), 0).is_err());
        streams
            .insert(TOKEN, entry_for(&path, &s), streams.epoch())
            .unwrap();
        assert!(
            streams
                .insert(TOKEN, entry_for(&path, &s), streams.epoch())
                .is_err(),
            "a live token is never replaced"
        );

        let res = streams.serve(&Method::GET, &path_of(TOKEN), Some("bytes=10-19"), u64::MAX);
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert!(res.body()[..] == plain[10..20]);
        assert_eq!(
            header(&res, header::CONTENT_TYPE).as_deref(),
            Some("video/webm")
        );
        let head = streams.serve(&Method::HEAD, &path_of(TOKEN), None, u64::MAX);
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
        assert_eq!(
            header(&head, header::CONTENT_LENGTH).as_deref(),
            Some("5000")
        );
        let post = streams.serve(&Method::POST, &path_of(TOKEN), None, u64::MAX);
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(header(&post, header::ALLOW).as_deref(), Some("GET, HEAD"));
        for p in [
            "/AAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
            format!("/{TOKEN}/x"),
            format!("//{TOKEN}"),
            "/".to_string(),
        ] {
            let res = streams.serve(&Method::GET, &p, None, u64::MAX);
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{p}");
            assert_security_headers(&res);
            assert_eq!(res.body(), b"404");
        }

        // A response being built when the token goes stops at its next chunk.
        let held = streams.get(TOKEN).unwrap();
        assert!(streams.remove(TOKEN));
        assert!(!streams.remove(TOKEN));
        assert_eq!(
            held.respond(false, None, u64::MAX).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            streams
                .serve(&Method::GET, &path_of(TOKEN), None, u64::MAX)
                .status(),
            StatusCode::NOT_FOUND
        );

        // Clear (lock) revokes everything.
        streams
            .insert(TOKEN, entry_for(&path, &s), streams.epoch())
            .unwrap();
        let held = streams.get(TOKEN).unwrap();
        assert_eq!(streams.clear(), 1);
        assert_eq!(streams.len(), 0);
        assert!(held.revoked.load(Ordering::Acquire));

        // A registration that started before a clear (lock) is not inserted after it.
        let started = streams.epoch();
        streams.clear();
        assert!(
            streams
                .insert(TOKEN, entry_for(&path, &s), started)
                .is_err()
        );
        assert_eq!(streams.len(), 0);

        // At MAX_STREAMS the oldest registration makes room.
        let tokens: Vec<String> = (0..=MAX_STREAMS)
            .map(|i| {
                let mut t = format!("{i:0>26}").into_bytes();
                for b in &mut t {
                    *b = b"ABCDEFGHIJ"[(*b - b'0') as usize];
                }
                String::from_utf8(t).unwrap()
            })
            .collect();
        for t in &tokens[..MAX_STREAMS] {
            streams
                .insert(t, entry_for(&path, &s), streams.epoch())
                .unwrap();
        }
        let first = streams.get(&tokens[0]).unwrap();
        streams
            .insert(&tokens[MAX_STREAMS], entry_for(&path, &s), streams.epoch())
            .unwrap();
        assert_eq!(streams.len(), MAX_STREAMS);
        assert!(streams.get(&tokens[0]).is_none());
        assert!(first.revoked.load(Ordering::Acquire));
        assert!(streams.get(&tokens[1]).is_some());
        assert!(streams.get(&tokens[MAX_STREAMS]).is_some());
    }
}
