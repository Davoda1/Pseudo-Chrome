'use strict';
const { electronEnvironment } = require('./helpers/electron-env.cjs');
// The actual bundled manual must keep the app icon after cached reloads, where
// Chromium may not emit page-favicon-updated again for the unchanged link.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const executablePath = process.env.PSEUDO_CHROME_ELECTRON;
if (!executablePath) throw new Error('Set PSEUDO_CHROME_ELECTRON to Electron or packaged Pseudo-Chrome.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pseudo-chrome-manual-favicon-'));
const expectedIcon = fs.readFileSync(path.join(project, 'app', 'assets', 'icon.svg'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let application, main;
async function wait(fn, label) {
  const until = Date.now() + 20000;
  while (Date.now() < until) { const value = await fn(); if (value) return value; await delay(80); }
  throw new Error('Timed out: ' + label);
}
const state = () => main.evaluate(() => window.pseudoChrome.invoke('getState'));
const command = (name, payload = {}) => main.evaluate(({ name, payload }) => window.pseudoChrome.invoke(name, payload), { name, payload });
async function site(expression) {
  return application.evaluate(({ BrowserWindow }, expression) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/ui/index.html'));
    return win.contentView.children.find(view => view.getVisible() && /^https?:/.test(view.webContents?.getURL() || '')).webContents.executeJavaScript(expression, true);
  }, expression);
}
async function assertManualIcon(label) {
  const tab = await wait(async () => { const s = await state(), tab = s.tabs.find(t => t.id === s.activeTabId); return tab?.kind === 'site' && !tab.loading && tab.favicon?.startsWith('data:image/') && tab; }, label + ' icon data');
  assert.deepEqual(Buffer.from(tab.favicon.slice(tab.favicon.indexOf(',') + 1), 'base64'), expectedIcon, label + ' uses exact app icon bytes');
  await wait(() => main.locator('.tab.active .tab-favicon img').evaluateAll(images => images.length === 1 && images[0].complete && images[0].naturalWidth > 0), label + ' rendered icon');
  assert.equal(await main.locator('.tab.active .tab-favicon use[href="#i-globe"]').count(), 0);
}
(async () => {
  try {
    const args = [];
    if (process.env.PSEUDO_CHROME_HEADLESS === '1') args.push('--no-sandbox', '--ozone-platform=headless', '--disable-gpu');
    if (process.env.PSEUDO_CHROME_TEST_SCALE) args.push('--force-device-scale-factor=' + process.env.PSEUDO_CHROME_TEST_SCALE);
    if (process.env.PSEUDO_CHROME_PACKAGED !== '1') args.push(project);
    application = await electron.launch({ executablePath, args, env: electronEnvironment({ ...process.env, PSEUDO_CHROME_PROFILE: profile, PSEUDO_CHROME_TEST: '1' }), timeout: 60000 });
    main = await wait(() => application.windows().find(window => window.url().endsWith('/ui/index.html')), 'main window');
    await main.waitForFunction(() => window.pseudoChrome);
    await wait(async () => { const s = await state(); if (s.host.status === 'error') throw new Error(s.host.error); return s.host.status === 'ready' && s.tabs.some(tab => tab.kind === 'site' && !tab.loading); }, 'default manual');
    const scenarios = ['fresh default manual'];
    await assertManualIcon('fresh manual');
    for (const bypassCache of [false, false, true]) {
      const previousTime = await site('performance.timeOrigin');
      if (bypassCache) await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/ui/index.html')); const wc = win.contentView.children.find(view => view.getVisible() && /^https?:/.test(view.webContents?.getURL() || '')).webContents; wc.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control', 'shift'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control', 'shift'] }); });
      else await command('reload');
      await wait(async () => await site('performance.timeOrigin') !== previousTime, 'new document after reload');
      await assertManualIcon(bypassCache ? 'cache-bypassing reload' : 'cached reload');
      scenarios.push(bypassCache ? 'cache-bypassing reload' : 'cached reload');
    }
    for (const chapter of ['configuration', 'permissions']) {
      await command('navigate', { url: '/#' + chapter });
      await wait(async () => (await site('location.hash')) === '#' + chapter, 'manual chapter ' + chapter);
      await assertManualIcon(chapter + ' chapter');
    }
    scenarios.push('chapter hash navigation');
    await command('back'); await wait(async () => (await site('location.hash')) === '#configuration', 'chapter Back'); await assertManualIcon('Back');
    await command('forward'); await wait(async () => (await site('location.hash')) === '#permissions', 'chapter Forward'); await assertManualIcon('Forward');
    scenarios.push('Back and Forward history');
    await command('newTab'); await assertManualIcon('new manual tab'); scenarios.push('new manual tab');
    fs.writeFileSync(path.join(profile, 'www', 'without-icon.html'), '<!doctype html><title>Page without a favicon</title><h1>No icon declaration</h1>');
    await command('navigate', { url: '/without-icon.html' });
    await wait(async () => { const s = await state(), t = s.tabs.find(t => t.id === s.activeTabId); return t?.title === 'Page without a favicon' && !t.loading; }, 'no-icon page ready');
    await delay(600);
    const s = await state(); assert.equal(s.tabs.find(t => t.id === s.activeTabId).favicon, '');
    assert.equal(await main.locator('.tab.active .tab-favicon img').count(), 0);
    scenarios.push('different document does not inherit manual icon');
    console.log(JSON.stringify({ result: 'passed', checks: ['default manual favicon is the app icon across reloads/history/new tabs without leaking to other documents'], scenarios }));
  } finally {
    try { if (application) await application.close(); } finally { fs.rmSync(profile, { recursive: true, force: true }); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
