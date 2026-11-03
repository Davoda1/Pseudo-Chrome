#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'app', 'ui', name), 'utf8');
const icon = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(root, 'app', 'assets', 'icon.svg')).toString('base64');
const css = read('styles.css');
let renderer = read('renderer.js');
for (const name of ['spaceship','swept-hair','blue-shirt','alpine-castle']) {
  const data = 'data:image/png;base64,' + fs.readFileSync(path.join(root,'app','assets','profiles',name+'.png')).toString('base64');
  renderer = renderer.replaceAll('../assets/profiles/'+name+'.png', data);
}
const splash = read('splash.html').replace('href="splash.css"', 'data-inline-style="splash"').replace('<link rel="stylesheet" data-inline-style="splash">', '<style>' + read('splash.css') + '</style>').replaceAll('../assets/icon.svg', icon).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:;">').replace('<script src="splash.js"></script>', '<script>window.pseudoChrome={onState(fn){fn({theme:parent.document.documentElement.dataset.theme,splashProgress:{status:"starting",message:"Starting website…"}});setTimeout(()=>fn({splashProgress:{status:"ready",message:"Opening your website…"}}),2200);return()=>{}},invoke(command){if(command==="window")parent.postMessage({type:"previewSplashClose",capability:"__PREVIEW_SPLASH_CAPABILITY__"},"__PREVIEW_SPLASH_PARENT_ORIGIN__");return Promise.resolve({})}};\n' + read('splash.js') + '</script>');

function bootstrapPreview(appIcon, splashDocument) {
  const origin = 'http://localhost:4173';
  let subscriber = () => {};
  let nextId = 2;
  let lastSiteId = 1;
  let dismissSplash = () => {};
  const histories = new Map([[1, { entries: ['/'], position: 0 }]]);
  const media = matchMedia('(prefers-color-scheme: dark)');
  const permissionItems = [
    { key: 'microphone', label: 'Microphone', icon: 'microphone' },
    { key: 'camera', label: 'Camera', icon: 'camera' },
    { key: 'notifications', label: 'Notifications', icon: 'bell' },
    { key: 'geolocation', label: 'Location', icon: 'location' },
    { key: 'clipboard-read', label: 'Clipboard', icon: 'clipboard' },
    { key: 'pointerLock', label: 'Pointer lock', icon: 'pointer' },
    { key: 'keyboardLock', label: 'Keyboard lock', icon: 'keyboard' }
  ];
  const permissionStates = new Map();
  const usedPermissions = new Set();
  let promptId = 0;
  let state = {
    tabs: [{ id: 1, title: 'Common Ground — Studio', url: origin + '/', favicon: '', kind: 'site', zoom: 1, loading: false, canGoBack: false, canGoForward: false }],
    activeTabId: 1, settings: { theme: 'system', profileName: 'Your Pseudo-Chrome', profileAvatar: 'default', startupUrl: '/', restoreWindow: true, allowExternalPrograms: false },
    demoConfig: { present: true, simulatedDomainName: 'studio.example', port: 4173 },
    siteConfig: { mode: 'auto', documentRoot: '.', entry: '', npmScript: '', args: [], env: {}, spa: false, port: 0, backendPort: 0, startupTimeoutMs: 30000 },
    paths: { www: '%AppData%\\Pseudo-Chrome\\www  /  ~/.config/Pseudo-Chrome/www', config: 'Pseudo-Chrome configuration folder' },
    host: { status: 'ready', url: origin, mode: 'static', engine: 'offline preview', logs: ['Offline interface preview.', 'No web server is running. The example website is embedded in this file.'] },
    platform: 'win32', maximized: false, theme: media.matches ? 'dark' : 'light', version: '1.0.0 · Interface preview', lastSiteZoom: 1,
    permissionPrompt: null, overlayKind: null
  };
  const frame = document.createElement('iframe');
  frame.id = 'preview-site'; frame.title = 'Embedded demonstration website';
  frame.style.cssText = 'position:absolute;left:0;top:86px;width:100%;height:calc(100% - 86px);border:0;background:#f5f2eb;z-index:1';
  document.body.append(frame);
  let displayed = '';
  const active = () => state.tabs.find(tab => tab.id === state.activeTabId);
  const currentSite = () => active()?.kind === 'site' ? active() : state.tabs.find(tab => tab.id === lastSiteId && tab.kind === 'site') || state.tabs.find(tab => tab.kind === 'site');
  const clone = () => structuredClone(state);
  const message = text => subscriber({ notice: text });
  const hideMenu = () => { state.permissionPrompt = null; state.overlayKind = null; subscriber({ action: 'close-popups' }); };
  const currentPath = tab => (tab?.url || origin + '/').slice(origin.length) || '/';
  function emit() {
    const tab = active();
    for (const item of state.tabs) item.displayUrl = item.kind === 'site' ? item.url.replace(origin, 'http://' + state.demoConfig.simulatedDomainName) : item.url;
    if (tab?.kind === 'site') lastSiteId = tab.id;
    state.lastSiteZoom = currentSite()?.zoom || 1;
    state.siteInfo = { available: tab?.kind === 'site', origin, host: 'localhost:4173', displayHost: state.demoConfig.simulatedDomainName, isLocal: true,
      permissions: permissionItems.filter(item => usedPermissions.has(item.key)).map(item => ({ ...item, state: permissionStates.get(item.key) || 'ask' })) };
    subscriber(clone());
    frame.hidden = tab?.kind !== 'site';
    if (tab?.kind === 'site') {
      const key = tab.id + ':' + tab.url;
      if (displayed !== key) { frame.srcdoc = website(currentPath(tab)); displayed = key; }
      frame.style.zoom = '1';
      try { if (frame.contentDocument?.body) frame.contentDocument.body.style.zoom = String(tab.zoom || 1); } catch {}
    }
  }
  function historyFlags(tab) {
    const history = histories.get(tab.id);
    tab.canGoBack = !!history && history.position > 0;
    tab.canGoForward = !!history && history.position < history.entries.length - 1;
  }
  function navigate(url, newTab = false, addHistory = true) {
    hideMenu();
    let tab = active();
    const alias = state.demoConfig.simulatedDomainName;
    if (url === alias || url.startsWith(alias + '/') || url.startsWith(alias + '?') || url.startsWith(alias + '#')) url = 'http://' + url;
    if (url.startsWith('http://' + alias) || url.startsWith('https://' + alias)) {
      try { const target = new URL(url); if (target.hostname === alias && !target.port && !target.username && !target.password) url = origin + target.pathname + target.search + target.hash; } catch {}
    }
    if (url.startsWith('pseudo://')) {
      const kind = url.startsWith('pseudo://settings') ? 'settings' : url.startsWith('pseudo://about') ? 'about' : 'welcome';
      const existing = state.tabs.find(t => t.kind === kind);
      if (existing) { existing.url = url; state.activeTabId = existing.id; emit(); return; }
      tab = { id: nextId++, title: kind === 'settings' ? 'Settings' : kind === 'about' ? 'About Pseudo-Chrome' : 'Pseudo-Chrome', url, kind, loading: false, zoom: 1 };
      state.tabs.push(tab); state.activeTabId = tab.id; emit(); return;
    }
    if (/^https?:\/\//i.test(url)) {
      if (!url.startsWith(origin + '/') && url !== origin) { message('External browsing is disabled in this preview.'); return; }
      url = url.slice(origin.length) || '/';
    }
    if (!url.startsWith('/')) url = '/' + url;
    if (newTab || !tab || tab.kind !== 'site') {
      tab = { id: nextId++, title: '', url: '', favicon: '', kind: 'site', zoom: 1, loading: false };
      state.tabs.push(tab); state.activeTabId = tab.id;
      histories.set(tab.id, { entries: [], position: -1 });
    }
    const history = histories.get(tab.id) || { entries: [], position: -1 };
    if (addHistory) { history.entries.splice(history.position + 1); history.entries.push(url); history.position = history.entries.length - 1; histories.set(tab.id, history); }
    tab.url = origin + url; tab.title = url === '/work' ? 'Selected work — Common Ground' : url === '/studio' ? 'The studio — Common Ground' : url === '/contact' ? 'Contact — Common Ground' : 'Common Ground — Studio';
    historyFlags(tab); emit();
  }
  function showSplash() {
    dismissSplash();
    const overlay = document.createElement('div'); overlay.id = 'preview-splash';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:30;display:grid;place-items:center;background:#0007;padding:12px;overflow:auto';
    const splashFrame = document.createElement('iframe'); splashFrame.title = 'Startup splash preview';
    const capability = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    // Local files serialize their origin as "null". The exact iframe and fresh
    // capability checks below distinguish this splash from other opaque origins.
    const parentOrigin = window.location.origin === 'null' ? '*' : window.location.origin;
    splashFrame.srcdoc = splashDocument
      .replace('"__PREVIEW_SPLASH_CAPABILITY__"', JSON.stringify(capability))
      .replace('"__PREVIEW_SPLASH_PARENT_ORIGIN__"', JSON.stringify(parentOrigin));
    splashFrame.style.cssText = 'width:693px;height:349px;max-width:none;border:0;border-radius:14px;box-shadow:0 16px 70px #0005'; overlay.append(splashFrame);
    let timer;
    function receiveSplashMessage(event) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== splashFrame.contentWindow) return;
      if (event.data?.type !== 'previewSplashClose' || event.data?.capability !== capability) return;
      closeSplash();
    }
    function closeSplash() {
      clearTimeout(timer);
      window.removeEventListener('message', receiveSplashMessage);
      overlay.remove();
      if (dismissSplash === closeSplash) dismissSplash = () => {};
    }
    dismissSplash = closeSplash;
    window.addEventListener('message', receiveSplashMessage);
    overlay.addEventListener('click', event => { if (event.target === overlay) closeSplash(); });
    document.body.append(overlay);
    timer = setTimeout(closeSplash, 4500);
  }
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase()==='a') { event.preventDefault(); subscriber({action:'open-popup',kind:'tabs'}); }
    if (event.altKey && event.key.toLowerCase()==='f') { event.preventDefault(); subscriber({action:'open-popup',kind:'main'}); }
    if (event.key === 'Escape') { hideMenu(); emit(); dismissSplash(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 't') { event.preventDefault(); navigate('/', true); }
  });
  window.pseudoChrome = {
    isPreview: true,
    onState(callback) { subscriber = callback; return () => { subscriber = () => {}; }; },
    async invoke(command, payload = {}) {
      switch (command) {
        case 'getState': setTimeout(emit, 0); return clone();
        case 'newTab': navigate('/', true); break;
        case 'selectTab': state.activeTabId = payload.id; emit(); break;
        case 'closeTab': { const index = state.tabs.findIndex(tab => tab.id === payload.id); state.tabs = state.tabs.filter(tab => tab.id !== payload.id); histories.delete(payload.id); if (!state.tabs.length) navigate('/', true); else { if (state.activeTabId === payload.id) state.activeTabId = state.tabs[Math.min(index, state.tabs.length - 1)].id; emit(); } break; }
        case 'reorderTabs': state.tabs = payload.ids.map(id => state.tabs.find(tab => tab.id === id)).filter(Boolean); emit(); break;
        case 'navigate': navigate(payload.url || '/'); break;
        case 'back': case 'forward': { const tab = active(), history = histories.get(tab?.id); const next = history && history.position + (command === 'back' ? -1 : 1); if (history && next >= 0 && next < history.entries.length) { history.position = next; navigate(history.entries[next], false, false); } break; }
        case 'reload': displayed = ''; emit(); break;
        case 'stop': break;
        case 'menu': subscriber({action:'open-popup',kind:payload.kind==='tabs'?'tabs':'main'}); break;
        case 'setOverlay': state.overlayKind = payload.open ? payload.kind : null; if (!payload.open) state.permissionPrompt = null; emit(); break;
        case 'startMediaPreview': throw new Error('Live camera and microphone previews are available in the desktop application. This offline preview does not access devices.');
        case 'stopMediaPreview': break;
        case 'respondPermission': {
          if (state.permissionPrompt?.id !== payload.id) break;
          if (payload.decision !== 'dismiss') for (const item of state.permissionPrompt.items) permissionStates.set(item.key, payload.decision === 'block' ? 'block' : 'allow');
          hideMenu(); emit(); setTimeout(() => message('Permission preview only. No hardware or website access was requested.'), 0); break;
        }
        case 'setSitePermission': if (permissionItems.some(item => item.key === payload.key) && ['ask','allow','block'].includes(payload.state)) permissionStates.set(payload.key,payload.state); emit(); break;
        case 'resetSitePermissions': permissionStates.clear(); emit(); break;
        case 'print': setTimeout(() => message('Printing is available in the desktop application.'),0); break;
        case 'clearSiteData': setTimeout(() => message('This offline preview has no persistent website data.'),0); break;
        case 'saveSettings': if(payload.profileName!==undefined){if(typeof payload.profileName!=='string'||!payload.profileName.trim()||payload.profileName.trim().length>64||/[\u0000-\u001f\u007f-\u009f]/.test(payload.profileName))throw new Error('Enter a profile name from 1 to 64 characters.');payload={...payload,profileName:payload.profileName.trim()};} state.settings = { ...state.settings, ...payload }; state.theme = state.settings.theme === 'system' ? media.matches ? 'dark' : 'light' : state.settings.theme; emit(); break;
        case 'saveSiteConfig': state.siteConfig = payload; emit(); setTimeout(() => message('Preview configuration updated in memory only.'), 0); break;
        case 'restartSite': state.host.logs.push('Preview restart requested; no hosting process was started.'); displayed = ''; emit(); setTimeout(() => message('This is a preview. The desktop application starts the actual website.'), 0); break;
        case 'zoom': { const tab = currentSite(); if (tab) tab.zoom = payload.reset ? 1 : Math.min(3, Math.max(0.5, Math.round((tab.zoom + (payload.delta || 0)) * 10) / 10)); emit(); break; }
        case 'openWww': case 'openConfig': setTimeout(() => message('Folder access is available in the desktop application.'), 0); break;
        case 'copyLog': try { await navigator.clipboard.writeText(state.host.logs.join('\n')); setTimeout(() => message('Preview log copied.'), 0); } catch { setTimeout(() => message('Clipboard access is unavailable here. The log remains selectable in Settings.'), 0); } break;
        case 'openDevTools': setTimeout(() => message('Developer tools are available in the desktop application.'), 0); break;
        case 'window': if(payload.action==='fullscreen'){state.fullscreen=!state.fullscreen;emit();} setTimeout(() => message('Window controls operate in the desktop application.'), 0); break;
      }
      return clone();
    }
  };
  const splashButton=document.createElement('button');
  splashButton.className='button';splashButton.textContent='Preview startup window';splashButton.addEventListener('click',showSplash);
  document.querySelector('#section-about').append(splashButton);
  const permissionPreview = document.createElement('div');
  permissionPreview.className = 'settings-card form-card';
  const previewLabel = document.createElement('p'); previewLabel.textContent = 'Permission popup previews — simulated; no device access.';
  const previewChoices = document.createElement('select'); previewChoices.setAttribute('aria-label', 'Permission popup preview');
  for (const [value,label] of [['microphone','Microphone'],['camera','Camera'],['media','Camera and microphone'],['notifications','Notifications'],['clipboard-read','Clipboard'],['geolocation','Location']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; previewChoices.append(option);
  }
  const previewButton = document.createElement('button'); previewButton.className = 'button'; previewButton.textContent = 'Preview permission request';
  previewButton.addEventListener('click', () => {
    const choice = previewChoices.value;
    const keys = choice === 'media' ? ['camera','microphone'] : [choice];
    keys.forEach(key => usedPermissions.add(key));
    const items = permissionItems.filter(item => keys.includes(item.key));
    const isMedia = keys.some(key => ['camera','microphone'].includes(key));
    const tab = currentSite(); if (!tab) { navigate('/',true); } else state.activeTabId = tab.id;
    state.permissionPrompt = { id: String(++promptId), tabId: state.activeTabId, origin, host: state.demoConfig.simulatedDomainName, permission: isMedia ? 'media' : choice,
      mediaTypes: keys.flatMap(key => key === 'microphone' ? ['audio'] : key === 'camera' ? ['video'] : []), items, layout: isMedia ? 'media' : 'simple' };
    state.overlayKind = 'permission'; emit(); subscriber({ action: 'open-popup', kind: 'permission' });
  });
  permissionPreview.append(previewLabel,previewChoices,previewButton); document.querySelector('#section-about').append(permissionPreview);
  media.addEventListener('change', () => { if (state.settings.theme === 'system') { state.theme = media.matches ? 'dark' : 'light'; emit(); } });
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument; if (!doc) return;
    doc.body.style.zoom = String(active()?.zoom || 1);
    doc.addEventListener('click', event => {
      hideMenu(); const anchor = event.target.closest('a'); if (!anchor) return;
      event.preventDefault(); const href = anchor.getAttribute('href') || '/'; navigate(href, anchor.target === '_blank' || event.ctrlKey || event.metaKey);
    });
    doc.querySelector('form')?.addEventListener('submit', event => { event.preventDefault(); doc.querySelector('#contact-feedback').textContent = 'Thanks. This is a demonstration form; no message was sent.'; });
  });

  function art(kind, color) {
    if (kind === 1) return `<svg viewBox="0 0 600 430" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="430" fill="${color}"/><circle cx="475" cy="100" r="50" fill="#eecf9c"/><path d="M0 280 600 245V430H0Z" fill="#b7b7a5"/><path d="M90 280V120H330V280Z" fill="#f0eadf"/><path d="m330 120 150 75v85H330Z" fill="#c6bbae"/><path d="M120 280V160H210V280M235 160h60v85h-60Z" fill="#50645e"/><path d="m90 120 130-65 260 140-150-75Z" fill="#d2c8b9"/><path d="M70 280h430" stroke="#707b6c" stroke-width="10"/><path d="M20 350c110-55 180-35 220-25s150 20 320-30" fill="none" stroke="#e4d6b9" stroke-width="28"/></svg>`;
    if (kind === 2) return `<svg viewBox="0 0 600 430" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="430" fill="${color}"/><path d="M80 430V60h440v370Z" fill="#c47b5f"/><path d="M150 430V160a150 150 0 0 1 300 0v270Z" fill="#f0d2aa"/><path d="M200 430V180a100 100 0 0 1 200 0v250Z" fill="#5b6c62"/><path d="M0 360h600v70H0Z" fill="#d1a782"/><path d="M230 360V190a70 70 0 0 1 140 0v170Z" fill="#a9baab"/><circle cx="300" cy="260" r="34" fill="#e5e4c8"/></svg>`;
    return `<svg viewBox="0 0 600 430" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="430" fill="${color}"/><path d="M0 330 600 280v150H0Z" fill="#829b8b"/><path d="M110 300V100h330v200Z" fill="#d5d6c3"/><path d="m440 100 70 60v140h-70Z" fill="#a1b19f"/><path d="M145 140h260v120H145Z" fill="#456259"/><path d="M210 140v120M280 140v120M345 140v120" stroke="#d5d6c3" stroke-width="9"/><path d="M70 320h470" stroke="#f0e6ca" stroke-width="25"/><circle cx="78" cy="215" r="55" fill="#4d735e"/><path d="M78 210v120" stroke="#75674f" stroke-width="10"/></svg>`;
  }
  function website(route) {
    const work = route === '/work', studio = route === '/studio', contact = route === '/contact';
    const heading = work ? 'Selected work.' : studio ? 'Made with care.' : contact ? 'Start a conversation.' : 'Places for better everyday life.';
    const description = work ? 'A selection of spaces shaped around people, materials and the way we live.' : studio ? 'We are a small architecture studio working at the intersection of thoughtful design and everyday use.' : contact ? 'Tell us about the place you have in mind.' : 'Architecture, interiors and landscapes. Thoughtful spaces with room to grow.';
    const cards = `<section class="projects"><a href="/work"><div class="image">${art(1, '#d2d9d5')}</div><div class="project-title">Courtyard House <span>01</span></div><p>Residential · 2026</p></a><a href="/work"><div class="image">${art(2, '#e7c9ac')}</div><div class="project-title">The Passage <span>02</span></div><p>Community · 2026</p></a><a href="/work"><div class="image">${art(3, '#c4d0bd')}</div><div class="project-title">Garden Room <span>03</span></div><p>Workspace · 2025</p></a></section>`;
    const body = contact ? `<form><label>Your name<input required placeholder="Alex Morgan"></label><label>Email<input type="email" required placeholder="alex@example.com"></label><label>A little about your project<textarea required rows="4" placeholder="A place to begin…"></textarea></label><button type="submit">Send message ↗</button><p id="contact-feedback" role="status"></p></form>` : studio ? `<div class="studio-copy"><div class="image">${art(3, '#c4d0bd')}</div><div><h2>Good spaces begin with listening.</h2><p>Every project starts with a conversation about people, place and possibility. We work with familiar materials, natural light and a careful sense of scale.</p><p>From a quiet garden room to a shared neighborhood space, our approach is practical, open and collaborative.</p><a class="text-link" href="/contact">Meet the studio ↗</a></div></div>` : cards;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#f5f2eb;color:#263c32;font:15px/1.55 Arial,sans-serif}a{color:inherit;text-decoration:none}header{padding:30px 6%;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #cad0c5;gap:22px}.brand{font-size:17px;line-height:1.15;font-weight:700;letter-spacing:1px}nav{display:flex;gap:27px;font-size:12px}nav a{padding:5px 0}nav a:hover{border-bottom:1px solid}main{max-width:1360px;margin:auto;padding:58px 6% 50px}.eyebrow{font-size:10px;letter-spacing:2px;text-transform:uppercase;margin-bottom:18px}.intro{display:flex;justify-content:space-between;align-items:flex-end;gap:35px;margin-bottom:37px}h1{font-size:clamp(36px,5.5vw,67px);font-weight:400;line-height:1.05;letter-spacing:-2.5px;max-width:650px;margin:0}h2{font-weight:400;font-size:29px;line-height:1.2;letter-spacing:-.8px}.intro p{max-width:290px;font-size:13px;color:#657167;margin:0 0 3px}.projects{display:grid;grid-template-columns:repeat(3,1fr);gap:23px}.image{overflow:hidden;background:#c4d0bd}.image svg{display:block;width:100%;height:auto}.project-title{display:flex;justify-content:space-between;font-size:14px;margin-top:13px}.project-title span{font-size:10px;color:#879183}.projects p{font-size:11px;color:#7a8578;margin:4px 0}.projects a:hover .image{filter:brightness(1.04)}footer{display:flex;justify-content:space-between;gap:20px;padding:25px 6%;font-size:10px;color:#7a8578;border-top:1px solid #cad0c5}.studio-copy{display:grid;grid-template-columns:1fr 1fr;gap:45px;align-items:center}.studio-copy p{font-size:13px;color:#657167}.text-link{font-size:12px;border-bottom:1px solid;padding-bottom:4px}form{max-width:600px}label{display:block;font-size:12px;margin-bottom:15px}input,textarea{display:block;width:100%;border:1px solid #bac3b6;background:#fff9;color:#263c32;font:13px Arial,sans-serif;padding:12px;margin-top:6px;resize:vertical;border-radius:2px}input:focus,textarea:focus{outline:2px solid #527862;outline-offset:1px}button{border:0;background:#315740;color:#fff;padding:12px 20px;font:12px Arial,sans-serif;cursor:pointer}#contact-feedback{font-size:12px}@media(max-width:700px){header{padding:22px 5%}nav{gap:17px}main{padding:38px 5%}.intro{display:block}.intro p{margin-top:20px;max-width:440px}.projects{gap:12px}.project-title{font-size:12px}.studio-copy{grid-template-columns:1fr;gap:20px}h1{letter-spacing:-1.5px}footer{padding:20px 5%}}@media(max-width:450px){.projects{grid-template-columns:1fr}.intro{margin-bottom:25px}nav{gap:12px}.brand{font-size:14px}}</style></head><body><header><a class="brand" href="/">COMMON<br>GROUND</a><nav><a href="/work">Work</a><a href="/studio">Studio</a><a href="/contact">Contact ↗</a></nav></header><main><div class="eyebrow">Independent architecture studio</div><div class="intro"><h1>${heading}</h1><p>${description}</p></div>${body}</main><footer><span>Common Ground · Demonstration website</span><span>Embedded offline preview</span></footer></body></html>`;
  }
}

const safe = text => text.replaceAll('<', '\\u003c');
let html = read('index.html');
html = html.replace('<title>Pseudo-Chrome</title>', '<title>Pseudo-Chrome — Offline interface preview</title>')
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; frame-src \'self\' data:; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">')
  .replace('<link rel="stylesheet" href="styles.css">', '<style>' + css + '</style>')
  .replaceAll('../assets/icon.svg', icon)
  .replace('<script src="renderer.js"></script>', () => '<script>(' + bootstrapPreview.toString().replaceAll('</script', '<\\/script').replaceAll('</body', '<\\/body') + ')(' + safe(JSON.stringify(icon)) + ',' + safe(JSON.stringify(splash)) + ');\n' + renderer.replaceAll('../assets/icon.svg', icon).replaceAll('</script', '<\\/script') + '</script>');
for (const name of ['spaceship','swept-hair','blue-shirt','alpine-castle']) {
  const data = 'data:image/png;base64,' + fs.readFileSync(path.join(root,'app','assets','profiles',name+'.png')).toString('base64');
  html = html.replaceAll('../assets/profiles/'+name+'.png', data);
}
const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'Preview.html');
fs.writeFileSync(output, html);
console.log(output);
