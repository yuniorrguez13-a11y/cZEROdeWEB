// Test pages are published by GitHub Pages along with the rest of the repo, and some of them wipe the vault
// databases on their origin. Importing this module first makes a page refuse to run anywhere but a local server.
const host = String(globalThis.location?.hostname ?? '');
const local = host === '127.0.0.1' || host === '[::1]' || host === 'localhost' || host.endsWith('.localhost');

if (!local) {
  if (globalThis.document?.body) globalThis.document.body.textContent = 'Test page: runs only on a local development server.';
  throw new Error('cZEROde test pages run only on localhost');
}
