// App-wide constants. KDF constants live only in crypto/kdf.js.

/** App version (package.json is the source of truth for the desktop build). */
export const VERSION = '2.0.0';
/** Where the web app lives; used in the "message for the receiver". */
export const APP_URL = 'https://yuniorrguez13-a11y.github.io/cZEROdeWEB/';
/** Desktop downloads ("Get the latest version"). */
export const RELEASES_URL = 'https://github.com/yuniorrguez13-a11y/cZEROdeWEB/releases';

/** Default czd2 chunk exponent: 2^18 = 256 KiB. */
export const CHUNK_EXP = 18;

/** Size and count limits (bytes unless noted). */
export const CAPS = Object.freeze({
  image: 64 * 2 ** 20,
  text: 2 * 2 ** 20,
  blobDesktop: 512 * 2 ** 20,
  blobMobile: 200 * 2 ** 20,
  thumbEdge: 320, // px, long edge
  thumbBytes: 32 * 1024,
  bundleEntries: 2000,
  folderFiles: 10000,
  folderDepth: 8,
});

/** Timeouts and delays (ms). */
export const TIMES = Object.freeze({
  undoMs: 8000,
  kdfCacheMs: 300000,
  swNeedMs: 2000,
  mediaFallbackMs: 5000,
  pickerSuspendMs: 600000,
  easterDebounceMs: 400,
});
