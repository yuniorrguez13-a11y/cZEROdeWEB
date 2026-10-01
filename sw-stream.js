// Service-worker side of encrypted media streaming (classic script imported by sw.js; DESIGN §5.2). Owner: F.
// Defines self.czStream = {handle(event), onMessage(event)}; sw.js routes ./czstream/* fetches to handle() and the
// page's {cmd:'register'|'unregister'|'lock'} messages to onMessage(). No imports: the payload is decrypted with
// crypto.subtle and the AES-GCM payload key the page transferred (non-extractable CryptoKey).
//
//   register   {cmd, token, blob, payKey, headerLen, chunkExp, size, paddedSize, mime, filename, download, entry?}
//              → {ok:true} on the port. The token is bound to the registering client (event.source.id).
//   unregister {cmd, token}   lock {cmd}: every token dropped; streams in flight error at their next pull (epoch).
//              lock {cmd, scope:'client'}: only the sending page's tokens and streams (one tab's passive lock —
//              idle/hidden/pagehide/freeze — must not stop another tab's media; state.purge sends it).
//   media      GET czstream/<token>: only for the bound client and never for navigations (else 403). An unknown
//              token asks that client {cmd:'need', token} over a MessageChannel; the page answers with the register
//              payload (or {deny:true}); no answer within 2 s → 403. Range math uses paddedSize (DESIGN §5.2).
//   download   GET czstream/<token>?download=1: navigations only, single use, 60 s TTL, attachment; unknown,
//              expired or locked → 204 + {type:'download-failed', token} posted to the page. The whole payload is
//              decrypted (padding chunks too, so the final chunk flag is authenticated) and `size` bytes emitted.
'use strict';

(() => {
  const TOKEN_RE = /^[A-Z2-7]{26}$/; // 16 random bytes, RFC 4648 base32 without padding
  const NEED_MS = 2000; // config.TIMES.swNeedMs
  const DOWNLOAD_TTL_MS = 60 * 1000;
  const MAX_TOKENS = 512;
  const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };

  /** token → entry (see makeEntry). Memory only: a stopped worker forgets everything (pages re-register via 'need'). */
  const tokens = new Map();
  /** token → Promise<entry|null> while a 'need' round trip runs (parallel range requests share it). */
  const needs = new Map();
  /** Bumped by every lock: a stream created under an older epoch errors at its next pull. */
  let epoch = 0;
  /**
   * clientId → that page's own lock count (client-scoped locks): only its streams error. Never pruned (a download a
   * page started keeps streaming after the page is gone, and its check must not change); one small number per page.
   */
  const clientEpochs = new Map();

  /** Snapshot of the lock epochs that concern `clientId`: the returned check is false once either moved on. */
  function stamp(clientId) {
    const g = epoch;
    const c = clientEpochs.get(clientId) || 0;
    return () => epoch === g && (clientEpochs.get(clientId) || 0) === c;
  }

  // ───────── untrusted values (duplicated from app/util/format.js: this classic script can't import modules)

  const SAFE_IMAGE = new Set(['png', 'jpeg', 'gif', 'webp', 'avif', 'bmp']);
  const IMAGE_ALIAS = { jpg: 'jpeg', pjpeg: 'jpeg', 'x-png': 'png', 'x-ms-bmp': 'bmp', 'x-bmp': 'bmp' };

  /** format.safeMediaType: raster images, audio/*, video/* (no parameters); anything else → octet-stream. */
  function safeMediaType(t) {
    if (typeof t !== 'string') return 'application/octet-stream';
    const base = t.split(';', 1)[0].trim().toLowerCase();
    const m = /^([a-z0-9.+-]{1,60})\/([a-z0-9.+-]{1,60})$/.exec(base);
    if (!m) return 'application/octet-stream';
    if (m[1] === 'image') {
      const sub = Object.prototype.hasOwnProperty.call(IMAGE_ALIAS, m[2]) ? IMAGE_ALIAS[m[2]] : m[2];
      return SAFE_IMAGE.has(sub) ? `image/${sub}` : 'application/octet-stream';
    }
    return m[1] === 'audio' || m[1] === 'video' ? base : 'application/octet-stream';
  }

  /**
   * Defence in depth for the download name (the page already passed it through format.safeFilename). Lone
   * surrogates become U+FFFD and the 200-unit cut never splits a pair: encodeURIComponent must not throw here.
   */
  function cleanFilename(s) {
    let n = typeof s === 'string' ? s : '';
    // eslint-disable-next-line no-control-regex
    n = n.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')
      .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g, '')
      .replace(/[/\\:*?"<>|]/g, '_')
      .replace(/^[\s.]+|[\s.]+$/gu, '');
    if (n.length > 200) {
      const hi = n.charCodeAt(199);
      n = n.slice(0, hi >= 0xd800 && hi <= 0xdbff ? 199 : 200);
    }
    return n || 'file';
  }

  /** RFC 5987/8187 attachment header (format.contentDisposition). */
  function contentDisposition(name) {
    const enc = encodeURIComponent(cleanFilename(name)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename*=UTF-8''${enc}`;
  }

  const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

  function isPayKey(k) {
    return typeof CryptoKey === 'function' && k instanceof CryptoKey && k.algorithm && k.algorithm.name === 'AES-GCM'
      && Array.isArray(k.usages) && k.usages.includes('decrypt');
  }

  /** Validates a register payload (from 'register' or a 'need' reply) into a token entry, or null. */
  function makeEntry(d, clientId) {
    if (!d || typeof d !== 'object' || typeof clientId !== 'string' || !clientId) return null;
    const { token, blob, payKey, headerLen, chunkExp, size, paddedSize } = d;
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    if (!(blob instanceof Blob) || !isPayKey(payKey)) return null;
    if (!Number.isInteger(chunkExp) || chunkExp < 12 || chunkExp > 24) return null;
    if (!isCount(headerLen) || headerLen < 28 || !isCount(size) || !isCount(paddedSize) || paddedSize < size) return null;
    const CS = 2 ** chunkExp;
    const n = Math.max(1, Math.ceil(paddedSize / CS));
    if (blob.size !== headerLen + paddedSize + 16 * n) return null; // exactly the container the page opened
    let entry = null;
    if (d.entry !== undefined && d.entry !== null) {
      const { off, size: len } = d.entry;
      if (!isCount(off) || !isCount(len) || off + len > size) return null;
      entry = { off, size: len };
    }
    const download = d.download === true;
    return {
      token,
      clientId,
      blob,
      payKey,
      headerLen,
      CS,
      n,
      size,
      paddedSize,
      entry,
      mime: safeMediaType(d.mime),
      filename: cleanFilename(d.filename),
      download,
      expires: download ? Date.now() + DOWNLOAD_TTL_MS : Infinity,
    };
  }

  function remember(entry) {
    tokens.delete(entry.token);
    tokens.set(entry.token, entry);
    while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value);
  }

  function sweepExpired(now = Date.now()) {
    for (const [t, e] of tokens) if (e.expires <= now) tokens.delete(t);
  }

  /** Drops media tokens of pages that are gone (reloaded or closed tabs keep no keys here). */
  async function sweepClients() {
    const clients = self.clients;
    if (!clients || typeof clients.matchAll !== 'function') return;
    const live = new Set((await clients.matchAll({ includeUncontrolled: true })).map((c) => c.id));
    for (const [t, e] of tokens) if (!e.download && !live.has(e.clientId)) tokens.delete(t);
  }

  // ───────── decryption

  /** Nonce of chunk i: BE88(i) ‖ final flag. */
  function chunkNonce(i, last) {
    const iv = new Uint8Array(12);
    let x = i;
    for (let k = 10; k >= 0 && x > 0; k--) {
      iv[k] = x % 256;
      x = Math.floor(x / 256);
    }
    iv[11] = last ? 1 : 0;
    return iv;
  }

  /** Plaintext of chunk i (CS bytes, the last one paddedSize − (n−1)·CS). */
  async function decryptChunk(e, i) {
    const last = i === e.n - 1;
    const len = (last ? e.paddedSize - (e.n - 1) * e.CS : e.CS) + 16;
    const off = e.headerLen + i * (e.CS + 16);
    const ct = await e.blob.slice(off, off + len).arrayBuffer();
    if (ct.byteLength !== len) throw new Error('truncated');
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: chunkNonce(i, last) }, e.payKey, ct));
  }

  /**
   * Response body: decrypts chunks c0..c1 one per pull and emits the plaintext bytes in [from, to) (container
   * plaintext offsets). padding: also require zero bytes past `size` (downloads). A lock errors it.
   */
  function body(e, { c0, c1, from, to, padding = false, onEnd }) {
    const live = stamp(e.clientId);
    let c = c0;
    let ended = false;
    const end = (ok) => {
      if (ended) return;
      ended = true;
      if (onEnd) onEnd(ok);
    };
    return new ReadableStream({
      async pull(controller) {
        try {
          if (!live()) throw new Error('locked');
          if (c > c1) {
            controller.close();
            end(true);
            return;
          }
          const i = c++;
          const pt = await decryptChunk(e, i);
          if (!live()) throw new Error('locked');
          const at = i * e.CS;
          if (padding) for (let j = Math.max(0, e.size - at); j < pt.length; j++) if (pt[j] !== 0) throw new Error('bad padding');
          const a = Math.max(from, at) - at;
          const b = Math.min(to, at + pt.length) - at;
          if (b > a) controller.enqueue(pt.subarray(a, b));
          if (c > c1) {
            controller.close();
            end(true);
          }
        } catch (err) {
          c = Infinity;
          controller.error(err);
          end(false);
        }
      },
      cancel() {
        c = Infinity;
        end(false);
      },
    });
  }

  // ───────── responses

  function respond(status, headers = {}, bodyInit = null) {
    return new Response(bodyInit, { status, headers: { ...SECURITY_HEADERS, ...headers } });
  }

  /** Refusals carry a text type: with nosniff and no type a refused navigation would turn into an empty download. */
  function refuse(status, headers = {}) {
    return respond(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }, String(status));
  }

  /**
   * Parses one `bytes=` range against `total`: null = ignore the header (absent, malformed, multi-range or
   * last < first → 200), 'unsatisfiable' (→ 416), or {start, end} (inclusive, end clipped to total − 1).
   */
  function parseRange(header, total) {
    if (header === null || header === undefined) return null;
    const m = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(String(header).trim());
    if (!m || (m[1] === '' && m[2] === '')) return null;
    if (m[1] === '') {
      const k = Number(m[2]);
      if (k === 0 || total === 0) return 'unsatisfiable';
      return { start: Number.isSafeInteger(k) && k < total ? total - k : 0, end: total - 1 };
    }
    const start = Number(m[1]);
    const last = m[2] === '' ? Infinity : Number(m[2]);
    if (last < start) return null;
    if (!Number.isSafeInteger(start) || start >= total) return 'unsatisfiable';
    return { start, end: Math.min(last, total - 1) };
  }

  function serveMedia(e, request) {
    const total = e.entry ? e.entry.size : e.size;
    const base = e.entry ? e.entry.off : 0;
    const head = request.method === 'HEAD';
    const common = { 'Content-Type': e.mime, 'Accept-Ranges': 'bytes' };
    const range = parseRange(request.headers.get('Range'), total);
    if (range === 'unsatisfiable') return respond(416, { ...common, 'Content-Range': `bytes */${total}` });
    const start = range ? range.start : 0;
    const end = range ? range.end : total - 1;
    const len = end - start + 1;
    const headers = { ...common, 'Content-Length': String(Math.max(0, len)) };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    const status = range ? 206 : 200;
    if (head || len <= 0) return respond(status, headers);
    const from = base + start;
    const to = base + end + 1;
    return respond(status, headers, body(e, { c0: Math.floor(from / e.CS), c1: Math.floor((to - 1) / e.CS), from, to }));
  }

  /** Posts a download notice to the page that registered the token (else to every window: tokens are unguessable). */
  async function notify(clientId, msg) {
    const clients = self.clients;
    if (!clients) return;
    try {
      const one = clientId ? await clients.get(clientId) : null;
      const targets = one ? [one] : await clients.matchAll({ type: 'window' });
      for (const c of targets) c.postMessage(msg);
    } catch {
      // best effort
    }
  }

  /** A navigation whose handler throws becomes a browser error page that unloads the app: never throw here. */
  function serveDownload(event, token) {
    try {
      return downloadResponse(event, token);
    } catch {
      waitFor(event, notify(event.clientId, { type: 'download-failed', token }));
      return respond(204);
    }
  }

  function downloadResponse(event, token) {
    const request = event.request;
    if (request.mode !== 'navigate') return refuse(403);
    sweepExpired();
    const e = tokens.get(token);
    if (!e || !e.download) {
      if (TOKEN_RE.test(token)) waitFor(event, notify(e ? e.clientId : event.clientId, { type: 'download-failed', token }));
      return respond(204);
    }
    tokens.delete(token); // single use
    const total = e.entry ? e.entry.size : e.size;
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(e.filename),
      'Content-Length': String(total),
    };
    waitFor(event, notify(e.clientId, { type: 'download-started', token }));
    const onEnd = (ok) => notify(e.clientId, { type: ok ? 'download-done' : 'download-failed', token });
    let stream;
    if (e.entry) {
      const from = e.entry.off;
      const to = from + e.entry.size;
      if (total === 0) {
        onEnd(true);
        return respond(200, headers);
      }
      stream = body(e, { c0: Math.floor(from / e.CS), c1: Math.floor((to - 1) / e.CS), from, to, onEnd });
    } else {
      stream = body(e, { c0: 0, c1: e.n - 1, from: 0, to: e.size, padding: true, onEnd });
    }
    return respond(200, headers, stream);
  }

  function waitFor(event, promise) {
    if (event && typeof event.waitUntil === 'function') {
      try {
        event.waitUntil(promise);
        return;
      } catch {
        // the event is no longer active
      }
    }
    promise.catch(() => {});
  }

  /** Asks the requesting page for a token this worker doesn't know (it restarted, or a lock raced). */
  function need(clientId, token) {
    const key = `${clientId}\n${token}`;
    if (needs.has(key)) return needs.get(key);
    const live = stamp(clientId);
    const p = (async () => {
      const clients = self.clients;
      const client = clients && clientId ? await clients.get(clientId) : null;
      if (!client) return null;
      const ch = new MessageChannel();
      const reply = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), NEED_MS);
        ch.port1.onmessage = (m) => {
          clearTimeout(timer);
          resolve(m.data);
        };
        try {
          client.postMessage({ cmd: 'need', token }, [ch.port2]);
        } catch {
          clearTimeout(timer);
          resolve(null);
        }
      });
      ch.port1.onmessage = null;
      ch.port1.close();
      if (!live() || !reply || reply.deny) return null;
      const e = makeEntry(reply, clientId);
      if (!e || e.token !== token || e.download) return null;
      remember(e);
      return e;
    })().catch(() => null).finally(() => needs.delete(key));
    needs.set(key, p);
    return p;
  }

  async function handleMedia(event, token) {
    const request = event.request;
    if (request.mode === 'navigate') return refuse(403);
    let e = tokens.get(token);
    if (e && (e.download || e.clientId !== event.clientId)) return refuse(403);
    if (!e) {
      if (!TOKEN_RE.test(token) || !event.clientId) return refuse(403);
      e = await need(event.clientId, token);
      if (!e) return refuse(403);
    }
    return serveMedia(e, request);
  }

  self.czStream = {
    /**
     * Answers a ./czstream/<token>[?download=1] request (sw.js calls it inside respondWith).
     * @param {FetchEvent} event
     * @returns {Response|Promise<Response>}
     */
    handle(event) {
      const request = event.request;
      if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(405, { Allow: 'GET, HEAD' });
      const url = new URL(request.url);
      const token = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
      if (url.searchParams.get('download') === '1') return serveDownload(event, token);
      return handleMedia(event, token);
    },

    /**
     * Page → worker messages register / unregister / lock (others are ignored). Replies {ok} on event.ports[0].
     * @param {ExtendableMessageEvent} event
     */
    onMessage(event) {
      const d = event.data;
      const port = event.ports && event.ports[0];
      const reply = (msg) => {
        if (port) port.postMessage(msg);
      };
      const cmd = d && typeof d === 'object' ? d.cmd : undefined;
      const clientId = event.source && typeof event.source.id === 'string' ? event.source.id : '';
      if (cmd === 'register') {
        sweepExpired();
        const e = makeEntry(d, clientId);
        if (!e) {
          reply({ ok: false, error: 'bad-register' });
          return;
        }
        remember(e);
        reply({ ok: true });
        waitFor(event, sweepClients());
      } else if (cmd === 'unregister') {
        const e = typeof d.token === 'string' ? tokens.get(d.token) : undefined;
        if (e && e.clientId === clientId) tokens.delete(d.token);
        reply({ ok: true });
      } else if (cmd === 'lock') {
        if (d.scope === 'client' && clientId) {
          // One page's own (passive) lock: its tokens go and its streams error; other pages keep playing.
          clientEpochs.set(clientId, (clientEpochs.get(clientId) || 0) + 1);
          for (const [t, e] of tokens) if (e.clientId === clientId) tokens.delete(t);
          for (const k of [...needs.keys()]) if (k.startsWith(`${clientId}\n`)) needs.delete(k);
        } else {
          epoch++;
          tokens.clear();
          needs.clear();
        }
        reply({ ok: true });
      }
    },
  };
})();
