'use strict';
const { electronEnvironment } = require('./helpers/electron-env.cjs');
// Real overlapping navigation and Chromium network failures; no loadURL mocks.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const executablePath = process.env.PSEUDO_CHROME_ELECTRON;
if (!executablePath) throw new Error('Set PSEUDO_CHROME_ELECTRON to Electron or packaged Pseudo-Chrome.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pseudo-navigation-'));
let application, main;
async function bounded(promise, label, timeout = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function wait(fn, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await bounded(Promise.resolve().then(fn), label, Math.max(1, deadline - Date.now()));
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out: ' + label);
}
const command = (name, payload = {}) => bounded(main.evaluate(({ name, payload }) => window.pseudoChrome.invoke(name, payload), { name, payload }), name);
const state = () => command('getState');
const current = s => s.tabs.find(tab => tab.id === s.activeTabId);
(async () => {
  try {
    fs.mkdirSync(path.join(profile, 'www'));
    fs.writeFileSync(path.join(profile, 'site.json'), JSON.stringify({ mode: 'node', entry: 'server.cjs' }));
    fs.writeFileSync(path.join(profile, 'www', 'server.cjs'), String.raw`
      const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
      http.createServer((req,res)=>{
        res.setHeader('Content-Type','text/html'); res.setHeader('Cache-Control','no-store');
        const slow=/^\/slow-(\d+)$/.exec(req.url),target=/^\/target-(\d+)$/.exec(req.url);
        if(slow){
          fs.writeFileSync(path.join(__dirname,'started-'+Number(slow[1])),'started');
          const timer=setTimeout(()=>res.end('<title>Slow initial page</title>'),15000);
          res.on('close',()=>clearTimeout(timer));return;
        }
        res.end('<!doctype html><title>'+ (target?'Target '+Number(target[1]):'Navigation home') +'</title><h1>Local page</h1>');
      }).listen(Number(process.env.PORT),process.env.HOST);
    `);
    const args = [];
    if (process.env.PSEUDO_CHROME_HEADLESS === '1') args.push('--no-sandbox', '--ozone-platform=headless', '--disable-gpu');
    if (process.env.PSEUDO_CHROME_TEST_SCALE) args.push('--force-device-scale-factor=' + process.env.PSEUDO_CHROME_TEST_SCALE);
    if (process.env.PSEUDO_CHROME_PACKAGED !== '1') args.push(project);
    application = await electron.launch({ executablePath, args, env: electronEnvironment({ ...process.env, PSEUDO_CHROME_PROFILE: profile, PSEUDO_CHROME_TEST: '1' }), timeout: 60000 });
    main = await wait(() => application.windows().find(window => window.url().endsWith('/ui/index.html')), 'main window');
    await main.waitForFunction(() => window.pseudoChrome);
    await wait(async () => { const s = await state(); if (s.host.status === 'error') throw new Error(s.host.error); return current(s)?.title === 'Navigation home' && !current(s).loading; }, 'initial website');
    for (let index = 0; index < 8; index++) {
      await command('saveSettings', { startupUrl: '/slow-' + index });
      await command('newTab');
      await wait(() => fs.existsSync(path.join(profile, 'www', 'started-' + index)), 'pending initial request');
      assert.equal(current(await state()).loading, true);
      await command('navigate', { url: '/target-' + index });
      await wait(async () => { const tab = current(await state()); return tab.title === 'Target ' + index && !tab.loading; }, 'replacement navigation');
      const s = await state();
      assert.equal(current(s).error, '');
      assert.equal(s.notice, '', 'cancelled initial loads must not display an error');
      await command('closeTab', { id: s.activeTabId });
    }
    console.log('PASS eight pending new-tab loads can be replaced without stale errors');
    const id = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/ui/index.html')).contentView.children.find(view => view.getVisible() && /^https?:/.test(view.webContents?.getURL() || ''))?.webContents.id);
    await application.evaluate(async ({ webContents }, { id, url }) => {
      const target = webContents.fromId(id);
      target.debugger.attach('1.3');
      const probe = { paused: 0, errors: [] };
      target.__pseudoFailureProbe = probe;
      target.__pseudoFailureListener = (_event, method, parameters) => {
        if (method !== 'Fetch.requestPaused') return;
        probe.paused++;
        target.debugger.sendCommand('Fetch.failRequest', {
          requestId: parameters.requestId, errorReason: 'ConnectionRefused'
        }).catch(error => probe.errors.push(error.message));
      };
      target.debugger.on('message', target.__pseudoFailureListener);
      await target.debugger.sendCommand('Fetch.enable', {
        patterns: [{ urlPattern: url, resourceType: 'Document', requestStage: 'Request' }]
      });
    }, { id, url: new URL('/blocked-failure', (await state()).host.url).href });
    try {
      // Electron may settle the navigation promise with an earlier aborted
      // load; the actual target's failure must still reach the visible state.
      await command('navigate', { url: '/blocked-failure' }).catch(error => assert.match(error.message, /ERR_CONNECTION_REFUSED|-102/));
      const probe = await application.evaluate(({ webContents }, id) => webContents.fromId(id).__pseudoFailureProbe, id);
      assert.ok(probe.paused > 0, 'Chromium must actually intercept the document request');
      assert.deepEqual(probe.errors, []);
      await wait(async () => /ERR_CONNECTION_REFUSED/.test(current(await state()).error), 'genuine network error state');
      assert.match((await state()).notice, /ERR_CONNECTION_REFUSED/);
    } finally {
      await application.evaluate(async ({ webContents }, id) => {
        const target = webContents.fromId(id);
        try { await target.debugger.sendCommand('Fetch.disable'); }
        finally {
          target.debugger.removeListener('message', target.__pseudoFailureListener);
          target.debugger.detach();
          delete target.__pseudoFailureListener;
          delete target.__pseudoFailureProbe;
        }
      }, id);
    }
    console.log('PASS genuine Chromium connection failure remains visible');
    await command('navigate', { url: '/target-99' });
    await wait(async () => { const tab = current(await state()); return tab.title === 'Target 99' && !tab.loading && !tab.error; }, 'navigation recovery');
    console.log('PASS navigation recovers after a real network failure');
    console.log(JSON.stringify({ result: 'passed', count: 3 }));
  } finally {
    if (application) {
      const child = application.process();
      const closed = new Promise(resolve => child.once('close', resolve));
      try { await bounded(application.close(), 'application shutdown', 15000); }
      finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await bounded(closed, 'process handles closed', 5000); }
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
