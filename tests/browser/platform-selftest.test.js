// Self-test of the browser unit runner (tests/browser/runner.js), NOT a normal suite: some of its tests fail on
// purpose. tests/e2e/browser-units.spec.js skips *-selftest suites in its generic loop and checks this one's
// exact outcome instead: passes are counted, failed assertions and a CSP violation fail their test.

export default async function (t) {
  await t.test('passes', async () => {
    t.equal(1, 1, 'equal');
    t.deepEqual({ a: [1, new Uint8Array([2])] }, { a: [1, new Uint8Array([2])] }, 'deepEqual');
    t.assert(true, 'assert');
  });

  await t.test('fails on purpose: assertion', async () => {
    t.equal(1, 2, 'one is not two');
  });

  await t.test('fails on purpose: CSP violation', async () => {
    // style-src 'self' has no 'unsafe-inline': a style attribute is a violation (and the app must never do it).
    const el = document.createElement('div');
    document.body.append(el);
    el.setAttribute('style', 'color: red');
    await new Promise((r) => setTimeout(r, 100)); // violation events are queued tasks
    el.remove();
  });

  await t.test('fails on purpose: throws', async () => {
    throw new Error('thrown on purpose');
  });
}
