'use strict';
// Focused browser regression: node tests/preview-messages.cjs
// Set PSEUDO_CHROME_BROWSER to an installed Chromium executable if needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const preview = path.resolve(__dirname, '..', 'Preview.html');
const html = fs.readFileSync(preview);
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
});

async function checkPreview(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.pseudoChrome);
    await page.frameLocator('#preview-site').getByRole('link', { name: 'Work', exact: true }).click();
    await page.waitForFunction(async () => (await window.pseudoChrome.invoke('getState')).tabs.some(tab => tab.url.endsWith('/work')));
    await page.locator('#back').click();
    await page.waitForFunction(async () => (await window.pseudoChrome.invoke('getState')).tabs.some(tab => tab.url === 'http://localhost:4173/'));
    await page.evaluate(() => window.pseudoChrome.invoke('navigate', { url: 'pseudo://settings/about' }));
    const open = page.getByRole('button', { name: 'Preview startup window', exact: true });
    const overlay = page.locator('#preview-splash');
    const splash = page.frameLocator('#preview-splash iframe');
    await open.click();
    await splash.locator('#close').waitFor();

    // A forged event can independently exercise origin/source checks without
    // granting an actual remote document access to the embedded capability.
    const rejected = await page.evaluate(async () => {
      const frame = document.querySelector('#preview-splash iframe');
      const capability = /capability:"([a-f0-9]{32})"/.exec(frame.srcdoc)?.[1];
      if (!capability) throw new Error('The splash capability was not embedded.');
      const data = { type: 'previewSplashClose', capability };
      const results = [];
      for (const [name, fields] of [
        ['wrong origin', { origin: 'https://untrusted.example', source: frame.contentWindow, data }],
        ['wrong source', { origin: location.origin, source: window, data }],
        ['missing capability', { origin: location.origin, source: frame.contentWindow, data: { type: data.type } }],
        ['wrong capability', { origin: location.origin, source: frame.contentWindow, data: { ...data, capability: 'incorrect' } }],
        ['wrong type', { origin: location.origin, source: frame.contentWindow, data: { ...data, type: 'other' } }]
      ]) {
        dispatchEvent(new MessageEvent('message', fields));
        results.push({ name, rejected: Boolean(document.querySelector('#preview-splash')) });
      }
      window.__previousSplash = { source: frame.contentWindow, capability };
      return results;
    });
    assert(rejected.every(result => result.rejected), JSON.stringify(rejected));

    // A real sibling iframe has the same serialized origin, including "null"
    // when opened from disk, but is not authorized to close the splash.
    await page.frameLocator('#preview-site').locator('body').evaluate(() => {
      const token = /capability:"([a-f0-9]{32})"/.exec(parent.document.querySelector('#preview-splash iframe').srcdoc)[1];
      parent.postMessage({ type: 'previewSplashClose', capability: token }, parent.location.origin === 'null' ? '*' : parent.location.origin);
    });
    await page.waitForTimeout(50);
    assert.equal(await overlay.count(), 1, 'Sibling iframe message must be rejected');

    // The real close button must still work with both file and HTTP origins.
    await splash.locator('#close').click();
    await overlay.waitFor({ state: 'detached' });
    await open.click();
    await splash.locator('#close').waitFor();
    const replayRejected = await page.evaluate(() => {
      const frame = document.querySelector('#preview-splash iframe');
      const capability = /capability:"([a-f0-9]{32})"/.exec(frame.srcdoc)[1];
      const old = window.__previousSplash;
      dispatchEvent(new MessageEvent('message', { origin: location.origin, source: old.source, data: { type: 'previewSplashClose', capability: old.capability } }));
      dispatchEvent(new MessageEvent('message', { origin: location.origin, source: frame.contentWindow, data: { type: 'previewSplashClose', capability: old.capability } }));
      return capability !== old.capability && Boolean(document.querySelector('#preview-splash'));
    });
    assert(replayRejected, 'A fresh splash must reject old frame messages and old capabilities');
    await splash.locator('#minimize').click();
    await overlay.waitFor({ state: 'detached' });
    await open.click();
    await page.keyboard.press('Escape');
    await overlay.waitFor({ state: 'detached' });
    await open.click();
    await overlay.click({ position: { x: 5, y: 5 } });
    await overlay.waitFor({ state: 'detached' });
    await open.click();
    await overlay.waitFor({ state: 'detached', timeout: 7000 });
    assert.deepEqual(errors, []);
    console.log(new URL(url).protocol + ' preview: navigation, message rejection, real splash controls, cleanup and timeout passed');
  } finally {
    await page.close();
  }
}

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, ...(process.env.PSEUDO_CHROME_BROWSER ? { executablePath: process.env.PSEUDO_CHROME_BROWSER } : {}) });
    await checkPreview(browser, pathToFileURL(preview).href);
    await checkPreview(browser, 'http://127.0.0.1:' + server.address().port + '/Preview.html');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
