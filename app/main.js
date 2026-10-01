// App entry point (module script from index.html).
// Owner: C1 (phase 1) writes the boot skeleton; integration (phase 4) owns the final wiring:
// framing check → settings.migrateLegacy → theme → global dragover/drop preventDefault → mountShell
// → pwa.registerServiceWorker → (await import('./vault/boot.js')).boot(...) → router.start(...).
// Phase-0 placeholder: intentionally does nothing yet.
