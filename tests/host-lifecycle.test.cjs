'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { SiteHost } = require('../app/lib/host.cjs');
const { removeExecutableFixture } = require('./helpers/fixture-cleanup.cjs');

async function removeFixture(file, t) {
  const retries = await removeExecutableFixture(file);
  if (retries) t.diagnostic(`Windows released the temporary ${path.basename(file)} file lock after ${retries} retries (${retries * 50} ms of retry waits).`);
}

async function assertPortClosed(port) {
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Port check timed out')); }, 1000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  }), { code: 'ECONNREFUSED' });
}

test('incomplete shutdown clears the active URL and can be retried', async () => {
  class IncompleteHost extends SiteHost {
    async _cleanupNow() { if (this.incomplete) throw new Error('Backend still closing'); }
  }
  const host = new IncompleteHost({ www: os.tmpdir(), configDir: os.tmpdir() });
  host.incomplete = true;
  for (const operation of [() => host.stop(), () => host.start({ mode: 'static' })]) {
    host._set({ state: 'ready', url: 'http://127.0.0.1:12345', pid: 123 });
    await assert.rejects(operation(), /Backend still closing/);
    assert.equal(host.status.state, 'error');
    assert.equal(host.status.url, '');
    assert.equal(host.status.pid, null);
  }
  host.incomplete = false;
  await host.stop();
  assert.equal(host.status.state, 'stopped');
});

const modes = ['direct'];
if (process.platform === 'win32' && process.env.PSEUDO_TEST_RUNNER) modes.push('supervised');
for (const mode of modes) test(`native ${mode} shutdown closes handles before backend replacement`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pseudo native lifecycle '));
  const executable = path.join(dir, process.platform === 'win32' ? 'backend.exe' : 'backend');
  const records = [];
  class ObservedHost extends SiteHost {
    _spawn(...args) { const record = super._spawn(...args); records.push(record); return record; }
  }
  const host = new ObservedHost({ www: dir, configDir: path.join(dir, 'config'), runtimes: mode === 'supervised' ? { processRunner: process.env.PSEUDO_TEST_RUNNER } : {} });
  t.after(async () => { await host.stop(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  await fs.copyFile(process.execPath, executable);
  // Backends must see EOF on stdin, never the supervisor's private stop pipe.
  await fs.writeFile(path.join(dir, 'server.cjs'), "process.stdin.on('end',()=>require('http').createServer((q,r)=>r.end('ready')).listen(+process.env.PORT,process.env.HOST));process.stdin.resume()");
  const config = { mode: 'native', entry: path.basename(executable), args: ['server.cjs'] };
  const { url } = await host.start(config);
  assert.equal(await (await fetch(url)).text(), 'ready');
  const port = host.backendPort;
  let closed = false;
  records[0].child.once('close', () => { closed = true; });
  await host.stop();
  assert.equal(closed, true, 'stop waits for the target process and stdio close event');
  await assertPortClosed(port);
  await removeFixture(executable, t);
  // A fast startup failure must also finish closing before a replacement.
  await fs.copyFile(process.execPath, executable);
  await fs.writeFile(path.join(dir, 'server.cjs'), 'process.exit(9)');
  await assert.rejects(host.start(config), /exited/);
  assert.equal(records.every(record => record.closed), true);
  await removeFixture(executable, t);
});

if (process.platform === 'win32' && process.env.PSEUDO_TEST_RUNNER) {
  for (const parentState of ['running', 'exited']) test(`supervised shutdown releases detached-stdio descendants with ${parentState} parent`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pseudo supervised tree '));
    const parent = path.join(dir, 'parent.exe'), descendant = path.join(dir, 'descendant.exe');
    const host = new SiteHost({ www: dir, configDir: path.join(dir, 'config'), runtimes: { processRunner: process.env.PSEUDO_TEST_RUNNER } });
    t.after(async () => { await host.stop(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
    await fs.copyFile(process.execPath, parent);
    await fs.copyFile(process.execPath, descendant);
    await fs.writeFile(path.join(dir, 'parent.cjs'), `
      const fs = require('fs'), path = require('path');
      fs.writeFileSync(path.join(__dirname, 'parent.pid'), String(process.pid));
      const child = require('child_process').spawn(path.join(__dirname, 'descendant.exe'), ['descendant.cjs'], {
        // Avoid Node's parent-owned kill-on-close job. DETACHED_PROCESS does
        // not break away from the application's containing Windows Job Object.
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
      });
      if (process.argv[2] === 'running') setInterval(() => {}, 1000);
      child.once('message', () => { if (process.argv[2] === 'exited') process.exit(0); });
    `);
    await fs.writeFile(path.join(dir, 'descendant.cjs'), `
      require('http').createServer((q,r) => r.end(String(process.pid))).listen(+process.env.PORT, process.env.HOST, () => {
        process.send('ready'); process.disconnect();
      });
    `);
    const { url } = await host.start({ mode: 'native', entry: 'parent.exe', args: ['parent.cjs', parentState] });
    const childPid = Number(await (await fetch(url)).text());
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    const parentPid = Number(await fs.readFile(path.join(dir, 'parent.pid'), 'utf8'));
    if (parentState === 'exited') {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { process.kill(parentPid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.throws(() => process.kill(parentPid, 0), 'the backend parent really exited before stop');
      assert.equal(await (await fetch(url)).text(), String(childPid), 'the descendant is still serving after its parent exits');
    }
    const backendPort = host.backendPort;
    await host.stop();
    // These checks have no retry or grace delay: an incomplete stop still fails.
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' }, 'no descendant remains after stop resolves');
    assert.throws(() => process.kill(parentPid, 0), { code: 'ESRCH' }, 'no parent remains after stop resolves');
    await assertPortClosed(backendPort);
    // Only test-owned file deletion tolerates a transient Windows file lock.
    await removeFixture(descendant, t);
    await removeFixture(parent, t);
  });
}
