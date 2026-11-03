'use strict';
// Boot the real GUI directly, without Playwright's Electron/shell launcher or
// the Node inspector. Attach only Chromium CDP to inspect the rendered app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { electronEnvironment } = require('./helpers/electron-env.cjs');

const project = path.resolve(__dirname, '..');
const executablePath = process.env.PSEUDO_CHROME_ELECTRON;
if (!executablePath) throw new Error('Set PSEUDO_CHROME_ELECTRON to Electron or packaged Pseudo-Chrome.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pseudo-direct-gui-'));
const title = 'Direct GUI launch proof';
const content = 'The packaged application rendered its local website.';
let child, browser, outcome, spawnError, closed;
const output = { stdout: '', stderr: '' };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function bounded(promise, label, timeout = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function exitDescription() {
  if (!outcome) return 'still running';
  const hex = outcome.code === null ? '' : ' (0x' + (outcome.code >>> 0).toString(16).padStart(8, '0') + ')';
  return 'code=' + outcome.code + hex + ', signal=' + outcome.signal;
}
async function wait(fn, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (outcome) throw new Error('GUI exited before ' + label + ': ' + exitDescription());
    const value = await bounded(Promise.resolve().then(fn), label, Math.min(10000, Math.max(1, deadline - Date.now())));
    if (value) return value;
    await delay(80);
  }
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
function sanitized(value) {
  let text = String(value).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  for (const [source, replacement] of [[profile, '<test-profile>'], [executablePath, '<app-executable>'], [path.dirname(executablePath), '<app-directory>'], [project, '<project>'], [os.homedir(), '<home>']]) {
    text = text.split(source).join(replacement).split(source.replaceAll('\\', '/')).join(replacement);
  }
  return text.replace(/github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+/g, '<redacted-token>');
}
async function forceCleanup() {
  if (!child || outcome || spawnError) return;
  if (process.platform === 'win32') {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    try { await bounded(new Promise(resolve => { killer.once('error', resolve); killer.once('close', resolve); }), 'owned process-tree cleanup', 5000); }
    catch { killer.kill(); }
  }
  if (!outcome) child.kill('SIGKILL');
  await bounded(closed, 'owned GUI process close', 10000);
}

(async () => {
  try {
    fs.mkdirSync(path.join(profile, 'www'));
    fs.writeFileSync(path.join(profile, 'www', 'index.html'), '<!doctype html><meta charset="utf-8"><title>' + title + '</title><h1>' + content + '</h1>');
    fs.writeFileSync(path.join(profile, 'site.json'), JSON.stringify({ mode: 'static', port: 0 }));
    const port = await freePort();
    const args = ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port];
    if (process.env.PSEUDO_CHROME_HEADLESS === '1') args.push('--no-sandbox', '--ozone-platform=headless', '--disable-gpu');
    if (process.env.PSEUDO_CHROME_TEST_SCALE) args.push('--force-device-scale-factor=' + process.env.PSEUDO_CHROME_TEST_SCALE);
    if (process.env.PSEUDO_CHROME_PACKAGED !== '1') args.push(project);
    const env = electronEnvironment({ ...process.env, ELECTRON_RUN_AS_NODE: '', Electron_Run_As_Node: '1', NODE_OPTIONS: '--invalid-gui-test-option', PSEUDO_CHROME_PROFILE: profile, PSEUDO_CHROME_TEST: '1' });
    assert.equal(Object.keys(env).some(name => /^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/i.test(name)), false);
    child = spawn(executablePath, args, { shell: false, windowsHide: true, cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    closed = new Promise(resolve => child.once('close', (code, signal) => { outcome = { code, signal }; resolve(outcome); }));
    child.once('error', error => { spawnError = error; });
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => { output[stream] = (output[stream] + data.toString('utf8')).slice(-65536); });
    const endpoint = 'http://127.0.0.1:' + port;
    await wait(async () => {
      try {
        const response = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) });
        if (!response.ok) return false;
        const details = await response.json();
        const websocket = new URL(details.webSocketDebuggerUrl);
        assert.equal(websocket.protocol, 'ws:');
        assert.equal(websocket.hostname, '127.0.0.1');
        assert.equal(Number(websocket.port), port);
        return true;
      } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; return false; }
    }, 'Chromium debugging endpoint');
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
    const main = await wait(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().endsWith('/ui/index.html')), 'actual application window');
    await main.waitForFunction(() => window.pseudoChrome, undefined, { timeout: 20000 });
    const state = await wait(async () => {
      const value = await main.evaluate(() => window.pseudoChrome.invoke('getState'));
      if (value.host.status === 'error') throw new Error('Website startup failed: ' + value.host.error);
      return value.host.status === 'ready' && value.tabs.some(tab => tab.kind === 'site' && tab.title === title && !tab.loading) && value;
    }, 'local website and tab title');
    const website = await wait(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(state.host.url)), 'website rendering target');
    assert.equal(await website.locator('h1').textContent(), content);
    assert.deepEqual(await website.evaluate(() => ({ node: typeof require, bridge: typeof window.pseudoChrome })), { node: 'undefined', bridge: 'undefined' });
    // Let the CDP evaluation acknowledge its result before quitting destroys
    // the renderer. The actual process must still close normally below.
    await main.evaluate(() => { setTimeout(() => { void window.pseudoChrome.invoke('window', { action: 'close' }); }, 100); return true; });
    assert.deepEqual(await bounded(closed, 'normal GUI shutdown', 15000), { code: 0, signal: null });
    console.log(JSON.stringify({ result: 'passed', checks: ['direct GUI boot without Node inspector or command shell', 'inherited empty and mixed-case Node controls removed', 'actual application window and local website rendering', 'website isolation', 'normal owned-process exit'] }));
  } catch (error) {
    console.error('Direct GUI launch failed: ' + sanitized(error.stack || error.message));
    console.error('Child status: ' + exitDescription());
    if (output.stdout) console.error('Child stdout:\n' + sanitized(output.stdout));
    if (output.stderr) console.error('Child stderr:\n' + sanitized(output.stderr));
    process.exitCode = 1;
  } finally {
    try { await forceCleanup(); }
    finally {
      if (browser) await browser.close().catch(() => {});
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
})().catch(error => { console.error(sanitized(error.stack || error.message)); process.exitCode = 1; });
