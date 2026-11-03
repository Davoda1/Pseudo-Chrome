'use strict';
const { electronEnvironment } = require('./helpers/electron-env.cjs');
// Native inspector regression: load the real DevTools frontend and evaluate
// through its connected page target, rather than only asserting IPC dispatch.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const executablePath = process.env.PSEUDO_CHROME_ELECTRON;
if (!executablePath) throw new Error('Set PSEUDO_CHROME_ELECTRON to Electron or packaged Pseudo-Chrome.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pseudo-chrome-devtools-'));
const checks = [];
let application, main;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// executeJavaScript accepts source, not structured arguments. Encode values as
// complete JavaScript literals, including characters unsafe in HTML scripts.
const codeLiteral = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
async function bounded(promise, label, timeout = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function wait(fn, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await bounded(Promise.resolve().then(fn), label, Math.max(1, until - Date.now()));
    if (result) return result;
    await delay(80);
  }
  throw new Error('Timed out: ' + label);
}
const state = () => bounded(main.evaluate(() => window.pseudoChrome.invoke('getState')), 'application state');
const command = (name, payload = {}) => bounded(main.evaluate(({ name, payload }) => window.pseudoChrome.invoke(name, payload), { name, payload }), name);
async function activeWebsiteId() {
  return application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/ui/index.html'));
    return win.contentView.children.find(view => view.getVisible() && /^https?:/.test(view.webContents?.getURL() || ''))?.webContents.id;
  });
}
const pageEval = (id, expression) => bounded(application.evaluate(({ webContents }, { id, expression }) => webContents.fromId(id).executeJavaScript(expression, true), { id, expression }), 'website evaluation');
async function popupEval(expression) {
  return bounded(application.evaluate(({ webContents }, expression) => webContents.getAllWebContents().find(w => w.getURL().includes('/ui/index.html?overlay=1')).executeJavaScript(expression, true), expression), 'popup evaluation');
}
async function frontend(id, expression) {
  return bounded(application.evaluate(({ webContents }, { id, expression }) => {
    const tools = webContents.fromId(id)?.devToolsWebContents;
    if (!tools || tools.isDestroyed()) return null;
    return tools.executeJavaScript(expression, true);
  }, { id, expression }), 'DevTools frontend evaluation');
}
async function inspected(id, expression) {
  return frontend(id, `(async()=>{const SDK=await import('devtools://devtools/bundled/core/sdk/sdk.js');const target=SDK.TargetManager.TargetManager.instance().primaryPageTarget();if(!target)return null;const result=await target.runtimeAgent().invoke_evaluate({expression:${codeLiteral(expression)},returnByValue:true,includeCommandLineAPI:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);return {url:target.inspectedURL(),value:result.result?.value};})()`);
}
async function ready(id, title) {
  await wait(() => application.evaluate(({ webContents }, id) => {
    const target = webContents.fromId(id);
    return !!target && target.isDevToolsOpened() && !!target.devToolsWebContents && !target.devToolsWebContents.isLoading();
  }, id), 'native DevTools opened for ' + title);
  assert.equal(await frontend(id, 'location.protocol'), 'devtools:');
  assert.ok(await frontend(id, 'document.body.querySelectorAll("*").length>20'), 'Inspector UI must actually load');
  await wait(async () => (await inspected(id, 'document.title'))?.value === title, 'DevTools connected to ' + title);
  return application.evaluate(({ webContents }, id) => webContents.fromId(id).devToolsWebContents.id, id);
}
async function closeTools(id) {
  const devId = await application.evaluate(({ webContents }, id) => {
    const target = webContents.fromId(id), devId = target?.devToolsWebContents?.id;
    target?.closeDevTools(); return devId;
  }, id);
  await wait(() => application.evaluate(({ webContents }, { id, devId }) => {
    const target = webContents.fromId(id), tools = devId && webContents.fromId(devId);
    return (!target || !target.isDevToolsOpened()) && (!tools || tools.isDestroyed());
  }, { id, devId }), 'DevTools closed and destroyed');
}
async function menuOpen() {
  await main.locator('#menu').click();
  await wait(() => popupEval('!document.querySelector("#main-menu").hidden'), 'application menu visible');
  await popupEval('document.querySelector("#menu-devtools").click();undefined');
  await wait(async () => !(await state()).overlayKind, 'application menu dismissed');
}
async function shortcut(source, keyCode, modifiers = []) {
  await application.evaluate(({ BrowserWindow, webContents }, { source, keyCode, modifiers }) => {
    const target = source === 'toolbar' ? BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/ui/index.html')).webContents : webContents.fromId(source);
    target.focus(); target.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); target.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }, { source, keyCode, modifiers });
}
async function dockSide(id) {
  return frontend(id, `(async()=>{const UI=await import('devtools://devtools/bundled/ui/legacy/legacy.js');return UI.DockController.DockController.instance().dockSide();})()`);
}
async function dockMenu(id) {
  return frontend(id, `(async()=>{const all=[];function walk(root){for(const e of root.querySelectorAll('*')){all.push(e);if(e.shadowRoot)walk(e.shadowRoot);}}walk(document);const button=all.find(e=>(e.getAttribute('aria-label')||e.title)==='Customize and control DevTools');if(!button)throw new Error('Missing native DevTools menu');button.click();await new Promise(resolve=>requestAnimationFrame(resolve));all.length=0;walk(document);return [...new Set(all.map(e=>e.getAttribute('aria-label')||e.title||'').filter(label=>/^(Dock to |Undock into)/.test(label)))];})()`);
}
async function dock(id, side) {
  const labels = await dockMenu(id);
  assert.deepEqual([...labels].sort(), ['Dock to bottom','Dock to left','Dock to right','Undock into separate window'].sort());
  const label = side === 'undocked' ? 'Undock into separate window' : 'Dock to ' + side;
  await frontend(id, `(()=>{const all=[];function walk(root){for(const e of root.querySelectorAll('*')){all.push(e);if(e.shadowRoot)walk(e.shadowRoot);}}walk(document);const button=all.find(e=>(e.getAttribute('aria-label')||e.title)===${codeLiteral(label)});if(!button)throw new Error('Missing Dock side control');button.click();return true;})()`);
  await wait(async () => await dockSide(id) === side, 'native dock position ' + side);
}
async function dockViewport(id, side, full) {
  await wait(async () => {
    const viewport = await pageEval(id, '({width:innerWidth,height:innerHeight})');
    if (side === 'undocked') return viewport.width === full.width && viewport.height === full.height;
    if (side === 'bottom') return viewport.height > 40 && viewport.height < full.height && viewport.width === full.width;
    return viewport.width > 40 && viewport.width < full.width && viewport.height === full.height;
  }, 'website native viewport for ' + side);
  assert.equal((await inspected(id, 'document.querySelector("#inspect-target-A").textContent')).value, 'Page A');
  const live = await pageEval(id, '({width:innerWidth,height:innerHeight})');
  assert.deepEqual((await inspected(id, '({width:innerWidth,height:innerHeight})')).value, live, 'Console uses the resized website viewport');
}
async function inspectContext(id, selector) {
  const point = await pageEval(id, `(()=>{const node=document.querySelector(${codeLiteral(selector)}),rect=node.getBoundingClientRect();return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};})()`);
  // Capture the native menu produced by the real context-menu event so the test
  // can select its actual Inspect callback on headless CI.
  await application.evaluate(({ Menu, webContents }, { id, point }) => {
    global.__pseudoOriginalMenuPopup = Menu.prototype.popup;
    global.__pseudoContextMenu = null;
    Menu.prototype.popup = function (options) {
      if (this.items.some(item => item.label === 'Inspect')) global.__pseudoContextMenu = this;
      else global.__pseudoOriginalMenuPopup.call(this, options);
    };
    const target = webContents.fromId(id); target.focus();
    target.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point });
    target.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point });
  }, { id, point });
  try {
    await wait(() => application.evaluate(() => !!global.__pseudoContextMenu), 'native website context menu');
    await application.evaluate(() => global.__pseudoContextMenu.items.find(item => item.label === 'Inspect').click());
  } finally {
    await application.evaluate(({ Menu }) => { Menu.prototype.popup = global.__pseudoOriginalMenuPopup; delete global.__pseudoOriginalMenuPopup; delete global.__pseudoContextMenu; });
  }
}
async function launch() {
  const args = [];
  if (process.env.PSEUDO_CHROME_HEADLESS === '1') args.push('--no-sandbox', '--ozone-platform=headless', '--disable-gpu');
  if (process.env.PSEUDO_CHROME_TEST_SCALE) args.push('--force-device-scale-factor=' + process.env.PSEUDO_CHROME_TEST_SCALE);
  if (process.env.PSEUDO_CHROME_PACKAGED !== '1') args.push(project);
  application = await electron.launch({ executablePath, args, env: electronEnvironment({ ...process.env, PSEUDO_CHROME_PROFILE: profile, PSEUDO_CHROME_TEST: '1' }), timeout: 60000 });
  main = await wait(() => application.windows().find(window => window.url().endsWith('/ui/index.html')), 'main window');
  await main.waitForFunction(() => window.pseudoChrome);
  await wait(async () => { const s = await state(); if (s.host.status === 'error') throw new Error(s.host.error); return s.host.status === 'ready' && s.tabs.some(tab => tab.kind === 'site' && !tab.loading); }, 'website ready');
}
async function shutdown() {
  if (!application) return;
  const closing = application, child = closing.process();
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve({ code: child.exitCode, signal: child.signalCode }) : new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try { await bounded(closing.close(), 'application exit', 15000); assert.deepEqual(await bounded(exited, 'normal exit', 5000), { code: 0, signal: null }); }
  finally { application = null; if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}
function passed(label) { checks.push(label); console.log('PASS ' + label); }
(async () => {
  try {
    fs.mkdirSync(path.join(profile, 'www'));
    for (const [filename, suffix] of [['index.html', 'A'], ['second.html', 'B']]) fs.writeFileSync(path.join(profile, 'www', filename), `<!doctype html><title>Inspector target ${suffix}</title><body style="margin:0;padding:24px;background:#e6eff9"><h1 id="inspect-target-${suffix}" style="display:inline-block;padding:24px;background:#afcdef">Page ${suffix}</h1><p>Real website inspected independently of application controls.</p><script src="/fixture.js"></script>`);
    fs.writeFileSync(path.join(profile, 'www', 'fixture.js'), 'window.inspectedPageMarker = \"source loaded through private gateway\";');
    fs.writeFileSync(path.join(profile, 'site.json'), JSON.stringify({ mode: 'static' }));
    await launch();
    let homeTab = (await state()).activeTabId, homeId = await activeWebsiteId();
    const fullViewport = await pageEval(homeId, '({width:innerWidth,height:innerHeight})');

    await menuOpen(); await ready(homeId, 'Inspector target A');
    const transportProbe = 'quotes " and \\ </script><script>throw new Error("must remain data")</script> & \u2028\u2029';
    assert.equal(await frontend(homeId, codeLiteral(transportProbe)), transportProbe);
    assert.equal((await inspected(homeId, codeLiteral(transportProbe))).value, transportProbe);
    assert.equal((await inspected(homeId, 'document.querySelector("#inspect-target-A").dataset.inspected="menu"')).value, 'menu');
    assert.equal(await pageEval(homeId, 'document.querySelector("#inspect-target-A").dataset.inspected'), 'menu');
    passed('menu opens a loaded native inspector connected to the real website DOM');
    assert.equal(await frontend(homeId, 'new URL(location.href).searchParams.get("can_dock")'), 'true');
    for (const side of ['right', 'bottom', 'left', 'undocked']) {
      await dock(homeId, side); await dockViewport(homeId, side, fullViewport);
      await inspectContext(homeId, '#inspect-target-A'); await ready(homeId, 'Inspector target A');
      await wait(async () => (await inspected(homeId, '$0 && $0.id'))?.value === 'inspect-target-A', 'selected element while ' + side);
      assert.equal(await dockSide(homeId), side);
      passed('native Dock side ' + side + ' control resizes the website and keeps Elements/Console functional');
    }
    await dock(homeId, 'bottom'); await dockViewport(homeId, 'bottom', fullViewport);
    await closeTools(homeId);
    assert.deepEqual(await pageEval(homeId, '({width:innerWidth,height:innerHeight})'), fullViewport);
    await menuOpen(); await ready(homeId, 'Inspector target A');
    assert.equal(await dockSide(homeId), 'bottom'); await dockViewport(homeId, 'bottom', fullViewport);
    passed('closing restores full website size and reopening remembers Dock side');

    const isolated = (await inspected(homeId, '({bridge:typeof window.pseudoChrome,require:typeof require,process:typeof process,protocol:location.protocol})')).value;
    assert.deepEqual(isolated, { bridge: 'undefined', require: 'undefined', process: 'undefined', protocol: 'http:' });
    assert.equal(await frontend(homeId, 'typeof window.pseudoChrome'), 'undefined');
    assert.ok(!(await inspected(homeId, 'location.href')).value.startsWith('file:'));
    passed('inspector targets the website without exposing the application bridge or Node');
    assert.equal((await inspected(homeId, 'window.inspectedPageMarker')).value, 'source loaded through private gateway');
    const source = await frontend(homeId, `(async()=>{const SDK=await import('devtools://devtools/bundled/core/sdk/sdk.js');const target=SDK.TargetManager.TargetManager.instance().primaryPageTarget();const tree=await target.pageAgent().invoke_getResourceTree();const script=tree.frameTree.resources.find(resource=>resource.url.endsWith('/fixture.js'));if(!script)return null;const result=await target.pageAgent().invoke_getResourceContent({frameId:tree.frameTree.frame.id,url:script.url});return {content:result.content,base64Encoded:result.base64Encoded};})()`);
    assert.match(source?.content || '', /source loaded through private gateway/);
    passed('inspector can read the actual website script source through the private gateway');
    await frontend(homeId, `(async()=>{const SDK=await import('devtools://devtools/bundled/core/sdk/sdk.js');const UI=await import('devtools://devtools/bundled/ui/legacy/legacy.js');await UI.ViewManager.ViewManager.instance().showView('network');const target=SDK.TargetManager.TargetManager.instance().primaryPageTarget();const network=target.model(SDK.NetworkManager.NetworkManager);window.__pseudoNetworkRequests=[];network.addEventListener(SDK.NetworkManager.Events.RequestFinished,event=>{const request=event.data.request||event.data;window.__pseudoNetworkRequests.push({url:request.url(),status:request.statusCode});});return true;})()`);
    assert.equal(await pageEval(homeId, 'fetch("/fixture.js?inspector=network-proof").then(response=>response.status)'), 200);
    await wait(() => frontend(homeId, 'window.__pseudoNetworkRequests.some(request=>request.url.includes("inspector=network-proof")&&request.status===200)'), 'Network panel records local request');
    passed('real DevTools Network panel records a successful local website request');
    const websiteURL = await pageEval(homeId, 'location.href');
    const devtoolsURL = await frontend(homeId, 'location.href');
    for (const blockedURL of [devtoolsURL, 'https://example.com/']) {
      await pageEval(homeId, `(()=>{try{location.href=${codeLiteral(blockedURL)};return true;}catch{return false;}})()`);
      await delay(180);
      assert.equal(await pageEval(homeId, 'location.href'), websiteURL);
      assert.equal((await inspected(homeId, 'document.title')).value, 'Inspector target A');
    }
    passed('ordinary website tabs still reject the approved DevTools URL and external navigation');
    await closeTools(homeId);

    for (const source of [homeId, 'toolbar']) for (const [key, modifiers, label] of [['F12', [], 'F12'], ['I', ['control', 'shift'], 'Ctrl+Shift+I']]) {
      await shortcut(source, key, modifiers); await ready(homeId, 'Inspector target A'); await closeTools(homeId);
      passed(label + ' from ' + (source === 'toolbar' ? 'toolbar' : 'website') + ' opens and closes a functioning inspector');
    }

    await inspectContext(homeId, '#inspect-target-A'); await ready(homeId, 'Inspector target A');
    await wait(async () => (await inspected(homeId, '$0 && $0.id'))?.value === 'inspect-target-A', 'Inspect selects the right-clicked DOM element');
    passed('native context-menu Inspect opens Elements on the exact right-clicked DOM node');
    await closeTools(homeId);
    await inspectContext(homeId, '#inspect-target-A'); await ready(homeId, 'Inspector target A');
    await wait(async () => (await inspected(homeId, '$0 && $0.id'))?.value === 'inspect-target-A', 'reopened Inspect selection');
    passed('closed inspector can reopen and inspect the same live page');

    await command('newTab'); await command('navigate', { url: '/second.html' });
    await wait(async () => (await state()).tabs.some(tab => tab.title === 'Inspector target B' && !tab.loading), 'second tab ready');
    const secondTab = (await state()).activeTabId, secondId = await activeWebsiteId();
    await inspectContext(secondId, '#inspect-target-B'); await ready(secondId, 'Inspector target B');
    await wait(async () => (await inspected(secondId, '$0 && $0.id'))?.value === 'inspect-target-B', 'second Inspect selection');
    assert.equal((await inspected(homeId, 'document.title')).value, 'Inspector target A');
    assert.equal((await inspected(secondId, 'document.title')).value, 'Inspector target B');
    assert.notEqual(await ready(homeId, 'Inspector target A'), await ready(secondId, 'Inspector target B'));
    passed('multiple tab inspectors stay connected to their own page and selected element');

    const secondDevId = await ready(secondId, 'Inspector target B');
    await command('closeTab', { id: secondTab });
    await wait(() => application.evaluate(({ webContents }, ids) => ids.every(id => !webContents.fromId(id) || webContents.fromId(id).isDestroyed()), [secondId, secondDevId]), 'closed tab destroys its page and inspector');
    assert.equal((await inspected(homeId, 'document.title')).value, 'Inspector target A');
    passed('closing one tab destroys only its inspector and leaves the other functional');

    await command('selectTab', { id: homeTab }); await closeTools(homeId);
    await command('navigate', { url: 'pseudo://about' });
    await main.locator('#section-about [data-command="openDevTools"]').click(); await ready(homeId, 'Inspector target A');
    assert.equal((await inspected(homeId, 'document.title')).value, 'Inspector target A');
    assert.equal((await state()).activeTabId, homeTab, 'About action activates the target website so docked inspector is visible');
    assert.equal(await activeWebsiteId(), homeId);
    passed('About developer-tools action activates the last website and presents its visible docked inspector');
    await dock(homeId, 'bottom'); await dockViewport(homeId, 'bottom', fullViewport);
    await shutdown(); await launch();
    homeTab = (await state()).activeTabId; homeId = await activeWebsiteId();
    await menuOpen(); await ready(homeId, 'Inspector target A');
    assert.equal(await dockSide(homeId), 'bottom'); await dockViewport(homeId, 'bottom', fullViewport);
    passed('native Dock side preference survives a full application restart');

    await shutdown(); passed('application shutdown closes active inspector processes normally');
    console.log(JSON.stringify({ result: 'passed', count: checks.length, checks }));
  } finally {
    try { await shutdown(); } finally { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
