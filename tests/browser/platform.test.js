// app/platform.js in Chromium under the app CSP: FS Access save targets (picker stubs return OPFS handles, as in
// the e2e plan), provisional-output cleanup, the hidden <input type=file> picker, staging, storage wrappers.
import * as P from '../../app/platform.js';
import * as state from '../../app/state.js';

const enc = (s) => new TextEncoder().encode(s);

async function* chunks(list, { failAfter = Infinity } = {}) {
  let i = 0;
  for (const c of list) {
    if (i++ >= failAfter) throw new Error('source failed');
    yield typeof c === 'string' ? enc(c) : c;
  }
}

async function text(handle) {
  return (await handle.getFile()).text();
}

async function exists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (e.name === 'NotFoundError') return false;
    throw e;
  }
}

async function freshDir(name) {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name, { recursive: true }).catch(() => {});
  return root.getDirectoryHandle(name, { create: true });
}

/** @param {{test(name:string, fn:Function):any, assert(c:any, m?:string):void, equal(a:any, b:any, m?:string):void, deepEqual(a:any, b:any, m?:string):void, log(...a:any[]):void}} t */
export default async function (t) {
  const saved = { save: window.showSaveFilePicker, dir: window.showDirectoryPicker };
  const restore = () => {
    window.showSaveFilePicker = saved.save;
    window.showDirectoryPicker = saved.dir;
  };

  await t.test('desktop Chromium: fine pointer and FS Access pickers present', async () => {
    t.equal(P.isTauri, false, 'not Tauri');
    t.equal(matchMedia('(pointer: fine)').matches, true, 'pointer: fine');
    t.equal(P.caps.savePicker(), true, 'savePicker');
    t.equal(P.caps.dirPicker(), true, 'dirPicker');
    t.equal(P.caps.mobile(), false, 'not mobile');
  });

  await t.test('fs-handle: streams and Blobs are written; a failed write keeps the old content; abort() removes the file', async () => {
    const dir = await freshDir('plat-single');
    let pickerOpts = null;
    window.showSaveFilePicker = async (opts) => {
      pickerOpts = opts;
      return dir.getFileHandle(opts.suggestedName, { create: true });
    };
    try {
      let target = await P.chooseSaveTarget({ name: 'one.czd', mime: 'application/x-czeroode' });
      t.equal(target.kind, 'fs-handle', 'kind');
      t.deepEqual(pickerOpts, { suggestedName: 'one.czd', id: 'czeroode-save' }, 'picker options');
      const res = await target.write('one.czd', chunks(['hello ', 'world']));
      t.equal(res.name, 'one.czd', 'result name');
      t.equal(await text(await dir.getFileHandle('one.czd')), 'hello world', 'content');

      const keep = await dir.getFileHandle('keep.txt', { create: true });
      const w = await keep.createWritable();
      await w.write('old content');
      await w.close();
      target = await P.chooseSaveTarget({ name: 'keep.txt' });
      let failed = false;
      try {
        await target.write('keep.txt', chunks(['new', 'more'], { failAfter: 1 }));
      } catch {
        failed = true;
      }
      t.assert(failed, 'write rejected');
      t.equal(await text(keep), 'old content', 'writable.abort() kept the previous bytes');

      target = await P.chooseSaveTarget({ name: 'blob.bin' });
      await target.write('blob.bin', new Blob(['blob bytes']));
      t.equal(await text(await dir.getFileHandle('blob.bin')), 'blob bytes', 'Blob source');
      await target.abort();
      t.equal(await exists(dir, 'blob.bin'), false, 'abort() removed the provisional output');
    } finally {
      restore();
    }
  });

  await t.test('fs-dir: " (2)" names for existing entries and repeats, failed write removed, abort() removes outputs', async () => {
    const dir = await freshDir('plat-folder');
    const pre = await dir.getFileHandle('a.txt', { create: true });
    const w = await pre.createWritable();
    await w.write('existing');
    await w.close();
    let pickerOpts = null;
    window.showDirectoryPicker = async (opts) => {
      pickerOpts = opts;
      return dir;
    };
    try {
      const target = await P.chooseSaveTarget({ name: 'x', count: 3 });
      t.equal(target.kind, 'fs-dir', 'kind');
      t.equal(target.count, 3, 'count');
      t.deepEqual(pickerOpts, { mode: 'readwrite', id: 'czeroode-folder' }, 'picker options');
      const r1 = await target.write('a.txt', chunks(['one']));
      const r2 = await target.write('a.txt', chunks(['two']));
      const r3 = await target.write('sub/dir:name.txt', chunks(['three']));
      t.deepEqual([r1.name, r2.name, r3.name], ['a (2).txt', 'a (3).txt', 'sub_dir_name.txt'], 'names');
      t.equal(await text(pre), 'existing', 'existing file untouched');
      t.equal(await text(await dir.getFileHandle('a (2).txt')), 'one', 'first');
      t.equal(await text(await dir.getFileHandle('a (3).txt')), 'two', 'second');
      let failed = false;
      try {
        await target.write('bad.bin', chunks(['x', 'y'], { failAfter: 1 }));
      } catch {
        failed = true;
      }
      t.assert(failed, 'failing write rejected');
      t.equal(await exists(dir, 'bad.bin'), false, 'partial entry removed');
      await target.abort();
      t.equal(await exists(dir, 'a (2).txt'), false, 'abort removed a (2).txt');
      t.equal(await exists(dir, 'sub_dir_name.txt'), false, 'abort removed sub_dir_name.txt');
      t.equal(await exists(dir, 'a.txt'), true, 'pre-existing file kept');
    } finally {
      restore();
    }
  });

  await t.test('picker refused (SecurityError) → stage target; cancelled (AbortError) → null', async () => {
    window.showSaveFilePicker = async () => {
      throw new DOMException('Must be handling a user gesture to show a file picker.', 'SecurityError');
    };
    window.showDirectoryPicker = async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    };
    try {
      const staged = await P.chooseSaveTarget({ name: 'a.czd' });
      t.equal(staged.kind, 'stage', 'stage after SecurityError');
      const r = await staged.write('a.czd', chunks(['abc']), { mime: 'image/png' });
      t.assert(r.staged instanceof File, 'staged File');
      t.equal(r.staged.type, 'image/png', 'type');
      t.equal(await r.staged.text(), 'abc', 'content');
      t.equal(await P.chooseSaveTarget({ name: 'x', count: 2 }), null, 'null after AbortError');
    } finally {
      restore();
    }
  });

  await t.test('picker without user activation (NotAllowedError, Chromium 141) → stage target', async () => {
    window.showDirectoryPicker = async () => {
      throw new DOMException('User activation is required to show a file picker.', 'NotAllowedError');
    };
    try {
      const target = await P.chooseSaveTarget({ name: 'x', count: 2 });
      t.equal(target && target.kind, 'stage', 'stage');
    } finally {
      restore();
    }
  });

  await t.test('pickFiles: hidden input, change → files, cancel → [], folder mode, picker.pending meanwhile', async () => {
    const p = P.pickFiles({ multiple: true });
    const input = document.querySelector('input[type=file]');
    t.assert(input && input.hidden && input.multiple, 'hidden multiple input appended');
    t.equal(input.accept, '', 'no accept filter');
    t.equal(state.get('picker.pending'), true, 'hidden lock suspended');
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'x.txt'));
    dt.items.add(new File(['yy'], 'y.bin'));
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    const files = await p;
    t.deepEqual(files.map((f) => f.name), ['x.txt', 'y.bin'], 'chosen files');
    t.equal(document.querySelector('input[type=file]'), null, 'input removed');
    await new Promise((r) => setTimeout(r, 0));
    t.equal(state.get('picker.pending'), false, 'hidden lock resumed');

    const c = P.pickFiles({ folder: true });
    const folderInput = document.querySelector('input[type=file]');
    t.equal(folderInput.webkitdirectory, true, 'webkitdirectory');
    folderInput.dispatchEvent(new Event('cancel'));
    t.deepEqual(await c, [], 'cancel → []');
  });

  // Headless Chromium can't show a file chooser and fires a real 'cancel' right away; these two tests simulate a
  // dialog that stays open by swallowing trusted 'cancel' events (synthetic ones still reach the input).
  const holdDialogOpen = () => {
    const block = (e) => {
      if (e.isTrusted) e.stopImmediatePropagation();
    };
    window.addEventListener('cancel', block, true);
    return () => window.removeEventListener('cancel', block, true);
  };

  await t.test('pickFiles: a change arriving after the window regained focus still delivers the files', async () => {
    // e.g. Android picking a cloud photo, iOS transcoding a video: the dialog closes (focus) long before 'change'.
    const release = holdDialogOpen();
    const p = P.pickFiles();
    const input = document.querySelector('input[type=file]');
    let settled = null;
    p.then((files) => (settled = files));
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 2300));
    t.equal(settled, null, 'not resolved as cancelled');
    t.equal(state.get('picker.pending'), false, 'hidden lock no longer suspended once the page is in front again');
    const dt = new DataTransfer();
    dt.items.add(new File(['late'], 'late.jpg'));
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    t.deepEqual((await p).map((f) => f.name), ['late.jpg'], 'late change delivered');
    t.equal(document.querySelector('input[type=file]'), null, 'input removed');
    release();
  });

  await t.test('pickFiles: a new pick ends an earlier one that never reported change/cancel', async () => {
    const release = holdDialogOpen();
    const first = P.pickFiles();
    let firstSettled = false;
    first.then(() => (firstSettled = true));
    const firstInput = document.querySelector('input[type=file]');
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 2300));
    t.equal(firstSettled, false, 'still open after the grace period');
    const second = P.pickFiles({ multiple: false });
    t.deepEqual(await first, [], 'stale pick resolved []');
    t.assert(!firstInput.isConnected, 'stale input removed');
    const inputs = document.querySelectorAll('input[type=file]');
    t.equal(inputs.length, 1, 'only the new input is left');
    t.equal(inputs[0].multiple, false, 'single-file pick');
    inputs[0].dispatchEvent(new Event('cancel'));
    t.deepEqual(await second, [], 'cancel → []');
    await new Promise((r) => setTimeout(r, 0));
    t.equal(state.get('picker.pending'), false, 'hidden lock resumed');
    release();
  });

  await t.test('storage wrappers return real values in Chromium', async () => {
    const est = await P.storage.estimate();
    t.assert(est && typeof est.quota === 'number' && est.quota > 0, 'estimate.quota');
    t.equal(typeof (await P.storage.persisted()), 'boolean', 'persisted');
  });

  await t.test('caps.sw is false on an uncontrolled page; share needs navigator.share', async () => {
    t.equal(P.caps.sw(), false, 'no controller here');
    t.equal(P.caps.share([new File(['a'], 'a.txt')]), typeof navigator.share === 'function' && navigator.canShare({ files: [new File(['a'], 'a.txt')] }), 'share');
  });
}
