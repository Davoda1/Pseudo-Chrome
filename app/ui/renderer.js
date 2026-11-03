'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const bridge = window.pseudoChrome;
  const overlayMode = new URLSearchParams(location.search).has('overlay');
  if (overlayMode) document.documentElement.dataset.overlay = 'true';
  const popupPanels = { main: '#main-menu', tabs: '#tab-search-panel', profile: '#profile-panel', site: '#site-panel', permission: '#permission-panel' };
  const popupTriggers = { main: '#menu', tabs: '#tab-search', profile: '#profile', site: '#site-info', permission: '#site-info' };
  let activePopup = null;
  let popupTrigger = null;
  let lastSearchSignature = '';
  let popupResizeFrame;
  let state = { tabs: [], settings: {}, siteConfig: {}, paths: {}, host: {}, theme: 'light' };
  let section = 'appearance';
  let siteDirty = false;
  let startupDirty = false;
  let lastTabSignature = '';
  let draggedTab = null;
  let noticeTimer;
  let activeId;
  const profileAvatars = {
    default: { label: 'Default' },
    spaceship: { label: 'Spaceship', src: '../assets/profiles/spaceship.png' },
    'swept-hair': { label: 'Swept hair', src: '../assets/profiles/swept-hair.png' },
    'blue-shirt': { label: 'Blue shirt', src: '../assets/profiles/blue-shirt.png' },
    'alpine-castle': { label: 'Alpine castle', src: '../assets/profiles/alpine-castle.png' }
  };
  const unavailableAvatars = new Set();
  let renderedAvatar;
  let queuedAvatar = null;
  let savingAvatar = false;
  let profileNameDirty = false;
  let profileNameSaving = false;
  let profileNameEdit = 0;
  let profileNameStatusTimer;
  let siteDetail = 'overview';
  let permissionBusy = false;
  let renderedPermission = '';
  let renderedPermissionId = null;
  let automaticPreviewId = null;
  const preview = { id: null, stream: null, audio: null, source: null, analyser: null, frame: 0, epoch: 0, starting: false };
  let externalProgramsSaving = false;
  const permissionLabels = {
    microphone: { label: 'Microphone', icon: 'microphone', request: 'Use your microphone', chip: 'Use microphone?' },
    camera: { label: 'Camera', icon: 'camera', request: 'Use your camera', chip: 'Use camera?' },
    notifications: { label: 'Notifications', icon: 'notifications', request: 'Show notifications', chip: 'Get notifications?' },
    geolocation: { label: 'Location', icon: 'geolocation', request: 'Know your location', chip: 'Use location?' },
    'clipboard-read': { label: 'Clipboard', icon: 'clipboard', request: 'See text and images copied to the clipboard', chip: 'Share clipboard?' },
    'persistent-storage': { label: 'Persistent storage', icon: 'storage', request: 'Request persistent storage for website data', chip: 'Keep website data?' },
    pointerLock: { label: 'Pointer lock', icon: 'pointer', request: 'Lock your mouse pointer', chip: 'Lock pointer?' },
    keyboardLock: { label: 'Keyboard lock', icon: 'keyboard', request: 'Capture keyboard input', chip: 'Capture keyboard?' }
  };

  function notice(message) {
    if (!message) return;
    $('#notice').textContent = String(message);
    $('#notice').hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 4500);
  }
  async function invoke(command, payload) {
    if (!bridge) throw new Error('The application bridge is unavailable. Please restart Pseudo-Chrome.');
    const result = await bridge.invoke(command, payload);
    if (result && result.ok === false) throw new Error(result.error || 'The action could not be completed.');
    if (result && Array.isArray(result.tabs)) applyState(result);
    return result;
  }
  function action(command, payload) {
    return invoke(command, payload).catch(error => notice(error.message || String(error)));
  }
  function displayAddress(tab) { return tab?.displayUrl || tab?.url || ''; }
  function activeTab() { return (state.tabs || []).find(tab => tab.id === state.activeTabId) || state.tabs?.[0]; }
  function icon(name) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    el.append(use);
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
  function selectedAvatar() {
    return Object.hasOwn(profileAvatars, state.settings?.profileAvatar) ? state.settings.profileAvatar : 'default';
  }
  function renderProfile() {
    const selected = selectedAvatar();
    if (!savingAvatar) {
      $$('input[name="profileAvatar"]').forEach(input => { input.checked = input.value === selected; });
    }
    const available = unavailableAvatars.has(selected) ? 'default' : selected;
    const avatar = profileAvatars[available], button = $('#profile');
    const name = state.settings?.profileName || 'Your Pseudo-Chrome';
    if (!profileNameDirty) $('#profile-name').value = name;
    $('#menu-profile-name').textContent = name;
    $('#menu-profile-name').title = name;
    $('#profile-popup-name').textContent = name;
    $('#profile-popup-name').title = name;
    $('#profile-panel').setAttribute('aria-label', `${name}, local demo profile`);
    button.title = `${name} · ${avatar.label}`;
    button.setAttribute('aria-label', `${name}, ${avatar.label} profile picture. Open profile menu`);
    if (renderedAvatar === available) return;
    renderedAvatar = available;
    for (const target of [button, $('#menu-profile-avatar'), $('#profile-popup-avatar')]) {
      if (!avatar.src) { target.replaceChildren(icon('person')); continue; }
      const img = document.createElement('img');
      img.className = 'profile-avatar';
      img.alt = '';
      img.addEventListener('error', () => { unavailableAvatars.add(available); renderProfile(); }, { once: true });
      img.src = avatar.src;
      target.replaceChildren(img);
    }
  }

  async function saveProfileAvatar(value) {
    if (!Object.hasOwn(profileAvatars, value) || unavailableAvatars.has(value)) return;
    queuedAvatar = value;
    if (savingAvatar) return;
    savingAvatar = true;
    try {
      while (queuedAvatar !== null) {
        const next = queuedAvatar;
        queuedAvatar = null;
        try { await invoke('saveSettings', { profileAvatar: next }); }
        catch (error) { notice(error.message || String(error)); }
      }
    } finally {
      savingAvatar = false;
      renderProfile();
    }
  }
  function markUnavailableAvatar(img) {
    const choice = img.closest('.profile-choice'), input = choice.querySelector('input');
    if (unavailableAvatars.has(input.value) && input.disabled) return;
    unavailableAvatars.add(input.value);
    input.disabled = true;
    choice.classList.add('unavailable');
    img.hidden = true;
    const message = document.createElement('span');
    message.className = 'profile-unavailable';
    message.textContent = 'Unavailable';
    choice.querySelector('.profile-choice-portrait').append(message);
    renderProfile();
  }
  function imageUrl(url) {
    if (typeof url !== 'string' || url.length > 400000) return '';
    return /^(https?:|data:image\/)/i.test(url) ? url : '';
  }
  function renderTabs() {
    const signature = JSON.stringify((state.tabs || []).map(t => [t.id, t.title, t.favicon, t.loading, t.kind, t.id === state.activeTabId]));
    if (signature === lastTabSignature) return;
    lastTabSignature = signature;
    const oldScroll = $('#tabs').scrollLeft;
    const focusedId = document.activeElement?.closest('.tab')?.dataset.id;
    $('#tabs').replaceChildren();
    for (const tab of state.tabs || []) {
      const el = document.createElement('div');
      el.className = `tab${tab.id === state.activeTabId ? ' active' : ''}`;
      el.dataset.id = String(tab.id);
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(tab.id === state.activeTabId));
      el.tabIndex = tab.id === state.activeTabId ? 0 : -1;
      el.draggable = true;
      el.title = tab.title || 'New tab';
      const favicon = document.createElement('span');
      favicon.className = 'tab-favicon';
      if (tab.loading) {
        const spinner = document.createElement('span');
        spinner.className = 'tab-loading';
        favicon.append(spinner);
      } else {
        const url = tab.kind === 'site' ? imageUrl(tab.favicon) : '../assets/icon.svg';
        if (url) {
          const img = document.createElement('img');
          img.src = url; img.alt = ''; img.referrerPolicy = 'no-referrer';
          img.addEventListener('error', () => favicon.replaceChildren(icon('globe')), { once: true });
          favicon.append(img);
        } else favicon.append(icon('globe'));
      }
      const title = document.createElement('span');
      title.className = 'tab-title'; title.textContent = tab.title || 'New tab';
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'tab-close';
      close.title = 'Close tab'; close.setAttribute('aria-label', `Close ${tab.title || 'tab'}`);
      close.append(icon('close'));
      close.addEventListener('click', event => { event.stopPropagation(); action('closeTab', { id: tab.id }); });
      el.append(favicon, title, close);
      el.addEventListener('click', () => action('selectTab', { id: tab.id }));
      el.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); action('closeTab', { id: tab.id }); } });
      el.addEventListener('keydown', event => {
        if (event.target !== el) return;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action('selectTab', { id: tab.id }); }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const tabs = state.tabs || [], index = tabs.findIndex(t => t.id === tab.id), direction = event.key === 'ArrowRight' ? 1 : -1;
          const next = tabs[(index + direction + tabs.length) % tabs.length];
          if (next) action('selectTab', { id: next.id });
        }
      });
      el.addEventListener('dragstart', event => {
        draggedTab = tab.id; el.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(tab.id));
      });
      el.addEventListener('dragover', event => { if (draggedTab !== null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; el.classList.add('drag-over'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', event => {
        event.preventDefault(); el.classList.remove('drag-over');
        if (draggedTab === null || draggedTab === tab.id) return;
        const ids = (state.tabs || []).map(t => t.id), from = ids.indexOf(draggedTab), to = ids.indexOf(tab.id);
        if (from >= 0 && to >= 0) { ids.splice(from, 1); ids.splice(to, 0, draggedTab); action('reorderTabs', { ids }); }
      });
      el.addEventListener('dragend', () => { draggedTab = null; $$('.tab').forEach(t => t.classList.remove('dragging', 'drag-over')); });
      $('#tabs').append(el);
    }
    $('#tabs').scrollLeft = oldScroll;
    if (focusedId) $$('.tab').find(t => t.dataset.id === focusedId)?.focus({ preventScroll: true });
    if (activeId !== state.activeTabId) {
      activeId = state.activeTabId;
      $('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  function setSection(value) {
    section = ['appearance', 'website', 'startup', 'about'].includes(value) ? value : 'appearance';
    $('#settings-search').value = '';
    $('#settings-no-results').hidden = true;
    $$('.settings-section').forEach(el => { el.hidden = el.id !== `section-${section}`; });
    $$('[data-section]').forEach(el => el.classList.toggle('selected', el.dataset.section === section));
    $('#settings-scroll').scrollTop = 0;
  }
  function renderForms() {
    $('#theme-select').value = state.settings?.theme || 'system';
    renderProfile();
    $('#allow-external-programs').setAttribute('aria-checked', String(state.settings?.allowExternalPrograms === true));
    const demo = state.demoConfig || {};
    $('#demo-config-summary').hidden = !demo.present;
    $('#demo-config-summary').textContent = demo.present ? ['config.pseudochrome', demo.simulatedDomainName ? `Displayed address: ${demo.simulatedDomainName}` : '', Number.isInteger(demo.port) ? `Website port: ${demo.port || 'automatic'}` : ''].filter(Boolean).join(' · ') : '';
    if (!siteDirty) {
      const c = state.siteConfig || {};
      $('#site-mode').value = c.mode || 'auto';
      $('#site-document-root').value = c.documentRoot || '.';
      $('#site-entry').value = c.entry || '';
      $('#site-npm-script').value = c.npmScript || '';
      $('#site-spa').checked = Boolean(c.spa);
      $('#site-args').value = JSON.stringify(c.args || [], null, 2);
      $('#site-env').value = JSON.stringify(c.env || {}, null, 2);
      $('#site-port').value = Number.isInteger(c.port) ? c.port : 0;
      $('#site-backend-port').value = Number.isInteger(c.backendPort) ? c.backendPort : 0;
      $('#site-timeout').value = Math.round((c.startupTimeoutMs || 30000) / 1000);
    }
    if (!startupDirty) {
      $('#startup-url').value = state.settings?.startupUrl || '/';
      $('#restore-window').checked = state.settings?.restoreWindow !== false;
    }
  }
  function renderHost() {
    const host = state.host || {};
    const status = host.status || host.state || 'stopped';
    const ready = Boolean(host.url) && ['ready', 'running', 'started'].includes(status);
    const failed = status === 'error' || status === 'failed' || Boolean(host.error);
    const starting = ['starting', 'loading', 'preparing'].includes(status);
    const message = ready ? 'Your website is ready.' : failed ? 'The website could not start.' : starting ? 'Starting your website…' : 'Your website is not running.';
    $('#welcome-status-text').textContent = message;
    $('#welcome-status').className = `welcome-status${ready ? ' ready' : failed ? ' error' : ''}`;
    $('#open-website').disabled = !ready;
    $('#welcome-description').textContent = !ready && host.message ? host.message : ready ? 'Open your local website, or replace its files in the www folder and restart the website from Settings.' : failed ? 'Check the server log and website settings. Your website may need an application entry, dependencies, or a backend service.' : 'Place your deployment-ready website in the www folder. Pseudo-Chrome starts the local hosting processes for you.';
    $('#welcome-error').hidden = !host.error;
    $('#welcome-error').textContent = host.error || '';
    $('#welcome-path').textContent = state.paths?.www || '';
    $('#www-path').textContent = state.paths?.www || '';
    $('#host-status-label').textContent = ready ? 'Local server is running' : starting ? 'Local server is starting' : failed ? 'Local server needs attention' : 'Local server is stopped';
    $('#host-status-detail').textContent = host.error || [host.url, host.mode, host.engine].filter(Boolean).join(' · ') || 'Not started';
    $('#restart-site').disabled = starting;
    const log = $('#server-log'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 25;
    const lines = Array.isArray(host.logs) ? host.logs.join('\n') : String(host.logs || '');
    log.textContent = lines || 'No log entries yet.';
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  function popupFocusables() {
    const panel = activePopup && $(popupPanels[activePopup]);
    return panel ? Array.from(panel.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter(el => !el.hidden && el.getClientRects().length) : [];
  }
  function positionPopup() {
    if (!activePopup) return;
    const panel = $(popupPanels[activePopup]), trigger = $(popupTriggers[activePopup]);
    const margin = 6, bounds = trigger.getBoundingClientRect();
    const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
    panel.style.maxWidth = `${Math.max(1, width - margin * 2)}px`;
    const top = Math.max(margin, Math.min(Math.round(bounds.bottom + (activePopup === 'tabs' ? 2 : 1)), height - margin - 1));
    panel.style.maxHeight = `${Math.max(1, height - top - margin)}px`;
    panel.style.top = `${top}px`;
    const desiredLeft = ['tabs', 'site', 'permission'].includes(activePopup) ? bounds.left : bounds.right - panel.offsetWidth;
    panel.style.left = `${Math.max(margin, Math.min(Math.round(desiredLeft), width - panel.offsetWidth - margin))}px`;
  }
  function updatePopupTriggers(kind = activePopup) {
    for (const selector of new Set(Object.values(popupTriggers))) $(selector).setAttribute('aria-expanded', String(selector === popupTriggers[kind]));
    $('#site-info').setAttribute('aria-controls', kind === 'permission' ? 'permission-panel' : 'site-panel');
  }
  async function closePopup(restoreFocus = true, notifyHost = true) {
    if (!activePopup && !state.overlayKind) return;
    const trigger = popupTrigger;
    stopMediaPreview();
    activePopup = null;
    popupTrigger = null;
    $('#popup-layer').hidden = true;
    Object.values(popupPanels).forEach(selector => { $(selector).hidden = true; });
    updatePopupTriggers(null);
    if (notifyHost && bridge) await action('setOverlay', { open: false });
    if (restoreFocus && !overlayMode) trigger?.focus({ preventScroll: true });
  }
  function openPopup(kind, fromBridge = false) {
    if (!Object.hasOwn(popupPanels, kind)) return;
    if (!overlayMode && !bridge?.isPreview) { action('setOverlay', { open: true, kind }); return; }
    if (activePopup === kind && !fromBridge) { closePopup(); return; }
    if (overlayMode && !fromBridge) { action('setOverlay', { open: true, kind }); return; }
    if (kind !== 'permission') stopMediaPreview();
    activePopup = kind;
    popupTrigger = $(popupTriggers[kind]);
    Object.entries(popupPanels).forEach(([name, selector]) => { $(selector).hidden = name !== kind; });
    $('#popup-layer').hidden = false;
    if (kind === 'tabs') { $('#tab-search-input').value = ''; lastSearchSignature = ''; }
    if (kind === 'site') siteDetail = 'overview';
    updatePopupTriggers();
    renderPopupState();
    positionPopup();
    $(popupPanels[kind]).scrollTop = 0;
    const first = kind === 'tabs' ? $('#tab-search-input') : popupFocusables()[0];
    first?.focus({ preventScroll: true });
  }
  async function popupCommand(command, payload) {
    await closePopup(false);
    await action(command, payload);
  }
  function renderSearchTabs() {
    const query = $('#tab-search-input').value.trim().toLocaleLowerCase();
    const tabs = (state.tabs || []).filter(tab => `${tab.title || ''} ${displayAddress(tab)} ${tab.url || ''}`.toLocaleLowerCase().includes(query));
    const signature = JSON.stringify([query, state.activeTabId, tabs.map(t => [t.id, t.title, t.url, t.displayUrl, t.favicon, t.loading, t.kind])]);
    if (signature === lastSearchSignature) return;
    lastSearchSignature = signature;
    const results = $('#tab-search-results');
    const oldScroll = results.scrollTop;
    const focused = document.activeElement?.closest('.search-tab-row');
    const focusedId = focused?.dataset.id;
    const focusedClose = document.activeElement?.classList.contains('search-tab-close');
    const oldIndex = focused ? Array.from(results.children).indexOf(focused) : -1;
    results.replaceChildren();
    for (const tab of tabs) {
      const row = document.createElement('div');
      row.className = `search-tab-row${tab.id === state.activeTabId ? ' active' : ''}`;
      row.dataset.id = String(tab.id);
      row.setAttribute('role', 'listitem');
      const select = document.createElement('button');
      select.type = 'button'; select.className = 'search-tab-select';
      select.title = `${tab.title || 'New tab'}\n${displayAddress(tab)}`;
      select.setAttribute('aria-label', `${tab.title || 'New tab'}${tab.id === state.activeTabId ? ', current tab' : ''}`);
      const favicon = document.createElement('span'); favicon.className = 'search-tab-icon';
      const url = tab.kind === 'site' ? imageUrl(tab.favicon) : '../assets/icon.svg';
      if (tab.loading) { const spinner = document.createElement('span'); spinner.className = 'tab-loading'; favicon.append(spinner); }
      else if (url) {
        const img = document.createElement('img'); img.alt = ''; img.src = url; img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => favicon.replaceChildren(icon('globe')), { once: true }); favicon.append(img);
      } else favicon.append(icon('globe'));
      const copy = document.createElement('span'); copy.className = 'search-tab-copy';
      const title = document.createElement('span'); title.className = 'search-tab-title'; title.textContent = tab.title || 'New tab';
      const address = document.createElement('span'); address.className = 'search-tab-url'; address.textContent = displayAddress(tab).replace(/^https?:\/\//, '').replace(/\/$/, '');
      copy.append(title, address); select.append(favicon, copy);
      select.addEventListener('click', () => popupCommand('selectTab', { id: tab.id }));
      const close = document.createElement('button'); close.type = 'button'; close.className = 'search-tab-close';
      close.title = 'Close tab'; close.setAttribute('aria-label', `Close ${tab.title || 'tab'}`); close.append(icon('close'));
      close.addEventListener('click', () => action('closeTab', { id: tab.id }));
      row.append(select, close); results.append(row);
    }
    $('#tab-search-empty').hidden = tabs.length !== 0;
    results.scrollTop = oldScroll;
    if (focusedId) {
      const rows = Array.from(results.children);
      const row = rows.find(el => el.dataset.id === focusedId) || rows[Math.min(Math.max(oldIndex, 0), rows.length - 1)];
      (row?.querySelector(focusedClose ? '.search-tab-close' : '.search-tab-select') || $('#tab-search-input')).focus({ preventScroll: true });
    }
  }
  function promptItems(prompt = state.permissionPrompt) {
    if (!prompt) return [];
    if (Array.isArray(prompt.items) && prompt.items.length) return prompt.items;
    if (prompt.permission === 'media') return (prompt.mediaTypes || []).map(type => ({ key: type === 'audio' ? 'microphone' : 'camera' }));
    return [{ key: prompt.permission }];
  }
  function renderSiteControl() {
    const tab = activeTab(), prompt = state.permissionPrompt;
    const pending = prompt && String(prompt.tabId) === String(tab?.id);
    const button = $('#site-info'), chip = $('#permission-chip-label');
    button.disabled = !pending && !state.siteInfo?.available;
    button.classList.toggle('permission-chip', Boolean(pending));
    chip.hidden = !pending;
    if (pending) {
      const items = promptItems(prompt), first = permissionLabels[items[0]?.key] || { icon: 'info', chip: 'Permission requested' };
      const combinedMedia = items.some(item => item.key === 'camera') && items.some(item => item.key === 'microphone');
      chip.textContent = combinedMedia ? 'Use camera & microphone?' : first.chip;
      $('#site-symbol-use').setAttribute('href', `#i-${combinedMedia ? 'camera' : first.icon}`);
      button.title = chip.textContent;
      button.setAttribute('aria-label', `${chip.textContent} View permission request`);
    } else {
      chip.textContent = '';
      $('#site-symbol-use').setAttribute('href', '#i-sliders');
      button.title = button.disabled ? 'Application page' : 'View site information';
      button.setAttribute('aria-label', button.title);
    }
  }
  function renderSiteInformation() {
    const info = state.siteInfo || {};
    $('#site-title').textContent = siteDetail === 'connection' ? 'Local connection' : siteDetail === 'cookies' ? 'Cookies and site data' : info.displayHost || info.host || 'Local website';
    $('#site-title').title = info.origin || '';
    $('#site-origin').textContent = info.origin || '';
    $('#site-overview').hidden = siteDetail !== 'overview';
    $('#site-connection-details').hidden = siteDetail !== 'connection';
    $('#site-cookie-details').hidden = siteDetail !== 'cookies';
    $('#site-back').hidden = siteDetail === 'overview';
    const rows = $('#site-permission-rows');
    const permissions = (info.permissions || []).filter(permission => Object.hasOwn(permissionLabels, permission.key));
    const keys = new Set(permissions.map(permission => permission.key));
    for (const row of Array.from(rows.children)) if (!keys.has(row.dataset.permission)) row.remove();
    for (const permission of permissions) {
      const definition = permissionLabels[permission.key];
      let row = Array.from(rows.children).find(el => el.dataset.permission === permission.key);
      if (!row) {
        row = document.createElement('div'); row.className = 'site-permission-row'; row.dataset.permission = permission.key;
        const copy = document.createElement('span'); copy.className = 'site-permission-copy';
        const label = document.createElement('span'); label.className = 'site-permission-label'; label.id = `permission-label-${permission.key}`; label.textContent = definition.label;
        const status = document.createElement('span'); status.className = 'site-permission-state'; status.id = `permission-state-${permission.key}`;
        copy.append(label, status);
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'site-permission-switch'; toggle.id = `permission-setting-${permission.key}`;
        toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-labelledby', label.id); toggle.setAttribute('aria-describedby', status.id);
        toggle.addEventListener('click', async () => {
          const next = toggle.getAttribute('aria-checked') === 'true' ? 'block' : 'allow';
          toggle.disabled = true;
          try { await invoke('setSitePermission', { key: permission.key, state: next }); }
          catch (error) { notice(error.message || String(error)); }
          finally { toggle.disabled = false; }
        });
        row.append(icon(definition.icon), copy, toggle); rows.append(row);
      }
      const allowed = permission.state === 'allow';
      row.querySelector('.site-permission-switch').setAttribute('aria-checked', String(allowed));
      row.querySelector('.site-permission-state').textContent = permission.state === 'block' ? 'Blocked' : !allowed ? 'Ask (default)' : permission.scope === 'once' ? 'Allowed this time' : permission.scope === 'session' ? 'Allowed while visiting' : 'Allowed';
    }
    $('#site-permission-empty').hidden = permissions.length > 0;
    $('#reset-site-permissions').hidden = permissions.length === 0;
    $('.site-permission-help').hidden = permissions.length === 0;
    $('#reset-site-permissions').disabled = !permissions.some(permission => permission.state !== 'ask');
  }
  function renderPermissionPrompt() {
    const prompt = state.permissionPrompt;
    if (!prompt) { renderedPermission = ''; renderedPermissionId = null; stopMediaPreview(); return; }
    const items = promptItems(prompt), signature = JSON.stringify([prompt.id, prompt.host, prompt.origin, prompt.layout, items]);
    if (signature === renderedPermission) return;
    if (preview.id && preview.id !== prompt.id) stopMediaPreview();
    const newPrompt = renderedPermissionId !== prompt.id;
    renderedPermissionId = prompt.id;
    renderedPermission = signature;
    $('#permission-title').textContent = `${prompt.host || prompt.origin || 'This website'} wants to`;
    $('#permission-title').title = prompt.origin || '';
    const content = $('#permission-items'); content.replaceChildren();
    for (const item of items) {
      const definition = permissionLabels[item.key] || { icon: 'info', request: item.label || 'Use this permission' };
      const row = document.createElement('div'); row.className = 'permission-item';
      const label = document.createElement('span'); label.textContent = definition.request;
      row.append(icon(definition.icon), label); content.append(row);
    }
    const media = prompt.layout === 'media' || prompt.permission === 'media';
    $('#permission-simple-actions').hidden = media;
    $('#permission-media-actions').hidden = !media;
    $('#permission-preview').hidden = !media;
    $('#camera-preview-card').hidden = !items.some(item => item.key === 'camera');
    $('#microphone-preview-card').hidden = !items.some(item => item.key === 'microphone');
    if (newPrompt && !preview.id) {
      for (const [selector,label] of [['#media-preview-camera','Default camera'],['#media-preview-microphone','Default microphone']]) { const option = document.createElement('option'); option.value = ''; option.textContent = label; $(selector).replaceChildren(option); }
      resetPreviewInterface();
    }
  }

  function resetPreviewInterface(message) {
    const offline = bridge?.isPreview;
    $('#permission-preview').dataset.previewState = 'idle';
    setPreviewStatus(message || (offline ? 'Live previews are available in the desktop application.' : ''));
    $('#camera-preview-placeholder').hidden = false;
    $('#camera-preview-live').hidden = true;
    $('#media-preview-level-fill').style.width = '0%';
    $('#media-preview-level').setAttribute('aria-valuenow', '0');
    $('#media-preview-camera').disabled = true;
    $('#media-preview-microphone').disabled = true;
  }
  function setPreviewStatus(message = '') {
    $('#media-preview-status').textContent = message;
    $('#media-preview-status').hidden = !message;
  }
  function automaticallyPreviewMedia() {
    const prompt = state.permissionPrompt;
    if (!overlayMode || bridge?.isPreview || !prompt || automaticPreviewId === prompt.id || permissionBusy || document.hidden || activePopup !== 'permission' || state.overlayKind !== 'permission' || String(prompt.tabId) !== String(state.activeTabId)) return;
    if (!promptItems(prompt).some(item => item.key === 'camera' || item.key === 'microphone')) return;
    // One attempt per request. State updates and failures must not reopen hardware.
    automaticPreviewId = prompt.id;
    startMediaPreview();
  }
  function stopMediaPreview(notifyHost = true, message) {
    const id = preview.id;
    preview.epoch++;
    const stream = preview.stream, audio = preview.audio;
    preview.id = null; preview.stream = null; preview.audio = null; preview.starting = false;
    cancelAnimationFrame(preview.frame); preview.frame = 0;
    try { preview.source?.disconnect(); } catch {}
    try { preview.analyser?.disconnect(); } catch {}
    preview.source = null; preview.analyser = null;
    $('#media-preview-video').pause(); $('#media-preview-video').srcObject = null;
    stream?.getTracks().forEach(track => track.stop());
    if (audio && audio.state !== 'closed') audio.close().catch(() => {});
    resetPreviewInterface(message);
    if (id && notifyHost && !bridge?.isPreview) bridge?.invoke('stopMediaPreview', { id }).catch(() => {});
  }
  function previewIsCurrent(id, epoch) {
    return preview.id === id && preview.epoch === epoch && state.permissionPrompt?.id === id && activePopup === 'permission';
  }
  async function refreshPreviewDevices(id, epoch) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!previewIsCurrent(id, epoch) || !preview.stream) return;
    for (const [kind, selector, tracks, fallback] of [
      ['videoinput', '#media-preview-camera', preview.stream.getVideoTracks(), 'Camera'],
      ['audioinput', '#media-preview-microphone', preview.stream.getAudioTracks(), 'Microphone']
    ]) {
      if (!tracks.length) continue;
      const select = $(selector), selected = tracks[0].getSettings().deviceId || select.value;
      const available = devices.filter(device => device.kind === kind && device.deviceId);
      select.replaceChildren();
      if (!available.length) {
        const option = document.createElement('option'); option.value = ''; option.textContent = tracks[0].label || `Default ${fallback.toLowerCase()}`; select.append(option);
      } else available.forEach((device, index) => {
        const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || `${fallback} ${index + 1}`; select.append(option);
      });
      if (Array.from(select.options).some(option => option.value === selected)) select.value = selected;
      select.disabled = available.length < 2;
    }
  }
  function previewError(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') return 'Preview access was denied. Check your operating system’s camera and microphone permissions.';
    if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return 'No matching camera or microphone is available.';
    if (error?.name === 'NotReadableError') return 'This device is unavailable or in use by another application.';
    if (error?.name === 'OverconstrainedError') return 'The selected preview device is unavailable.';
    return 'Could not start the preview. ' + (error?.message || 'Check your device settings.');
  }
  async function startMediaPreview(restart = false) {
    const prompt = state.permissionPrompt;
    if (!prompt || activePopup !== 'permission' || permissionBusy || preview.starting || document.hidden) return;
    if (bridge?.isPreview) { resetPreviewInterface(); return; }
    if (!overlayMode || state.overlayKind !== 'permission' || String(prompt.tabId) !== String(state.activeTabId)) return;
    if (!navigator.mediaDevices?.getUserMedia) { resetPreviewInterface('Live media previews are unavailable on this system.'); return; }
    const requested = promptItems(prompt), wantsVideo = requested.some(item => item.key === 'camera'), wantsAudio = requested.some(item => item.key === 'microphone');
    if (!wantsVideo && !wantsAudio) return;
    const videoDevice = restart ? $('#media-preview-camera').value : '', audioDevice = restart ? $('#media-preview-microphone').value : '';
    stopMediaPreview(false);
    const id = prompt.id, epoch = preview.epoch; preview.id = id; preview.starting = true;
    $('#permission-preview').dataset.previewState = 'starting';
    setPreviewStatus('Starting the live preview…');
    try {
      await invoke('startMediaPreview', { id });
      if (!previewIsCurrent(id, epoch)) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: wantsVideo ? { ...(videoDevice ? { deviceId: { exact: videoDevice } } : {}), width: { ideal: 640 }, height: { ideal: 360 } } : false,
        audio: wantsAudio ? { ...(audioDevice ? { deviceId: { exact: audioDevice } } : {}), echoCancellation: true, noiseSuppression: true } : false
      });
      if (!previewIsCurrent(id, epoch)) { stream.getTracks().forEach(track => track.stop()); return; }
      preview.stream = stream;
      stream.getTracks().forEach(track => track.addEventListener('ended', () => {
        if (preview.stream !== stream) return;
        stopMediaPreview(true, 'The preview device disconnected.');
        $('#permission-preview').dataset.previewState = 'error';
      }, { once: true }));
      if (stream.getVideoTracks().length) {
        const video = $('#media-preview-video'); video.muted = true; video.srcObject = stream;
        await video.play();
        if (!previewIsCurrent(id, epoch)) return;
        $('#camera-preview-placeholder').hidden = true; $('#camera-preview-live').hidden = false;
      }
      if (stream.getAudioTracks().length) {
        const audio = new AudioContext(); preview.audio = audio;
        const source = audio.createMediaStreamSource(stream), analyser = audio.createAnalyser();
        analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.6; source.connect(analyser);
        preview.source = source; preview.analyser = analyser;
        await audio.resume();
        if (!previewIsCurrent(id, epoch)) return;
        const samples = new Float32Array(analyser.fftSize);
        const meter = () => {
          if (!previewIsCurrent(id, epoch) || preview.stream !== stream) return;
          analyser.getFloatTimeDomainData(samples);
          let square = 0; for (const value of samples) square += value * value;
          const level = Math.min(100, Math.max(0, Math.round(Math.sqrt(square / samples.length) * 350)));
          $('#media-preview-level-fill').style.width = level + '%';
          $('#media-preview-level').setAttribute('aria-valuenow', String(level));
          preview.frame = requestAnimationFrame(meter);
        };
        meter();
      }
      await refreshPreviewDevices(id, epoch);
      if (!previewIsCurrent(id, epoch)) return;
      preview.starting = false; $('#permission-preview').dataset.previewState = 'active';
      setPreviewStatus();
      positionPopup();
    } catch (error) {
      if (!previewIsCurrent(id, epoch)) return;
      stopMediaPreview(true, previewError(error));
      $('#permission-preview').dataset.previewState = 'error';
    }
  }

  async function respondPermission(decision) {
    const id = state.permissionPrompt?.id;
    if (!id || permissionBusy) return;
    permissionBusy = true;
    stopMediaPreview();
    $$('[data-permission-decision]').forEach(button => { button.disabled = true; });
    try { await invoke('respondPermission', { id, decision }); }
    catch (error) { notice(error.message || String(error)); }
    finally { permissionBusy = false; $$('[data-permission-decision]').forEach(button => { button.disabled = false; }); automaticallyPreviewMedia(); }
  }
  function renderPopupState() {
    const tab = activeTab(), hasSite = (state.tabs || []).some(t => t.kind === 'site');
    const zoom = Math.round((Number(tab?.kind === 'site' ? tab.zoom : state.lastSiteZoom) || 1) * 100);
    $('#menu-back').disabled = !tab?.canGoBack;
    $('#menu-forward').disabled = !tab?.canGoForward;
    $('#menu-print').disabled = tab?.kind !== 'site';
    $('#menu-devtools').disabled = !hasSite;
    $('#menu-restart').disabled = ['starting', 'loading', 'preparing'].includes(state.host?.status);
    $('#menu-zoom-reset').textContent = `${zoom}%`;
    $('#menu-zoom-reset').disabled = !hasSite;
    $('#menu-zoom-out').disabled = !hasSite || zoom <= 50;
    $('#menu-zoom-in').disabled = !hasSite || zoom >= 300;
    $('#menu-fullscreen').setAttribute('aria-label', state.fullscreen ? 'Exit full screen' : 'Enter full screen');
    if (activePopup === 'tabs') renderSearchTabs();
    if (activePopup === 'site') renderSiteInformation();
    if (activePopup === 'permission') { renderPermissionPrompt(); automaticallyPreviewMedia(); }
    if (activePopup) positionPopup();
    else updatePopupTriggers(state.overlayKind || null);
  }
  function applyState(update) {
    if (!update) return;
    if (update.action === 'stop-media-preview') { if (!update.id || update.id === preview.id) stopMediaPreview(false); return; }
    if (update.action === 'open-popup') { openPopup(update.kind, true); return; }
    if (update.action === 'open-tab-search') { openPopup('tabs', true); return; }
    if (update.action === 'close-popups') { closePopup(false, false); return; }
    if (update.action === 'focus-address') { $('#address-input').focus(); $('#address-input').select(); return; }
    if (update.toast || update.notice) { notice(update.toast || update.notice); if (!update.tabs) return; }
    const oldActive = activeTab();
    state = { ...state, ...update };
    if (preview.id && (state.permissionPrompt?.id !== preview.id || String(state.permissionPrompt?.tabId) !== String(state.activeTabId) || (state.overlayKind !== 'permission' && !bridge?.isPreview))) stopMediaPreview();
    document.documentElement.dataset.theme = state.theme === 'dark' ? 'dark' : 'light';
    renderTabs();
    const tab = activeTab(), internal = !tab || tab.kind !== 'site';
    $('#internal-content').hidden = !internal;
    const settings = tab && ['settings', 'about'].includes(tab.kind);
    $('#welcome-page').hidden = Boolean(settings);
    $('#settings-page').hidden = !settings;
    if (tab?.id !== oldActive?.id || tab?.kind !== oldActive?.kind || tab?.url !== oldActive?.url) {
      if (tab?.kind === 'about') setSection('about');
      else if (tab?.kind === 'settings') {
        const match = /^pseudo:\/\/settings\/(appearance|website|startup|about)(?:$|[?#])/.exec(tab.url || '');
        setSection(match ? match[1] : 'appearance');
      }
    }
    if (document.activeElement !== $('#address-input')) $('#address-input').value = displayAddress(tab) || 'pseudo://welcome';
    $('#back').disabled = !tab?.canGoBack;
    $('#forward').disabled = !tab?.canGoForward;
    $('#reload-symbol').setAttribute('href', tab?.loading ? '#i-close' : '#i-reload');
    $('#reload').setAttribute('aria-label', tab?.loading ? 'Stop loading' : 'Reload');
    $('#reload').title = tab?.loading ? 'Stop loading (Esc)' : 'Reload (Ctrl+R)';
    const zoom = Math.round((Number(tab?.kind === 'site' ? tab.zoom : state.lastSiteZoom) || 1) * 100);
    $('#zoom-indicator').hidden = zoom === 100 || tab?.kind !== 'site';
    $('#zoom-indicator').textContent = `${zoom}%`;
    $('#settings-zoom').textContent = `${zoom}%`;
    $('#maximize').title = state.maximized ? 'Restore down' : 'Maximize';
    $('#maximize').setAttribute('aria-label', state.maximized ? 'Restore down' : 'Maximize');
    $('#maximize-icon').innerHTML = state.maximized ? '<path d="M4 1.5h6.5V8H9M1.5 4H8v6.5H1.5Z"/>' : '<rect x="1.5" y="1.5" width="9" height="9"/>';
    $('#app-version').textContent = `Version ${state.version || '1.0.0'}`;
    renderForms(); renderHost(); renderSiteControl(); renderPopupState();
    if (overlayMode) {
      if (state.overlayKind && activePopup !== state.overlayKind) openPopup(state.overlayKind, true);
      else if (!state.overlayKind && activePopup) closePopup(false, false);
    }
  }

  $('#new-tab').addEventListener('click', () => action('newTab'));
  $('#back').addEventListener('click', () => action('back'));
  $('#forward').addEventListener('click', () => action('forward'));
  $('#reload').addEventListener('click', () => action(activeTab()?.loading ? 'stop' : 'reload'));
  $('#minimize').addEventListener('click', () => action('window', { action: 'minimize' }));
  $('#maximize').addEventListener('click', () => action('window', { action: 'maximize' }));
  $('#close-window').addEventListener('click', () => action('window', { action: 'close' }));
  $('#menu').addEventListener('click', () => openPopup('main'));
  $('#tab-search').addEventListener('click', () => openPopup('tabs'));
  $('#profile').addEventListener('click', () => openPopup('profile'));
  $('#site-info').addEventListener('click', () => openPopup(state.permissionPrompt && String(state.permissionPrompt.tabId) === String(activeTab()?.id) ? 'permission' : 'site'));
  for (const selector of ['#media-preview-camera','#media-preview-microphone']) $(selector).addEventListener('change', () => startMediaPreview(true));
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (preview.id && preview.stream) refreshPreviewDevices(preview.id, preview.epoch).catch(() => {}); });
  window.addEventListener('pagehide', () => stopMediaPreview());
  window.addEventListener('beforeunload', () => stopMediaPreview());
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopMediaPreview(); else automaticallyPreviewMedia(); });
  $('#allow-external-programs').addEventListener('click', async () => {
    if (externalProgramsSaving) return;
    externalProgramsSaving = true; $('#allow-external-programs').disabled = true;
    try { await invoke('saveSettings', { allowExternalPrograms: state.settings?.allowExternalPrograms !== true }); }
    catch (error) { notice(error.message || String(error)); }
    finally { externalProgramsSaving = false; $('#allow-external-programs').disabled = false; renderForms(); }
  });
  $('#site-close').addEventListener('click', () => closePopup());
  $('#permission-close').addEventListener('click', () => respondPermission('dismiss'));
  $$('[data-permission-decision]').forEach(button => button.addEventListener('click', () => respondPermission(button.dataset.permissionDecision)));
  $('#reset-site-permissions').addEventListener('click', () => action('resetSitePermissions'));
  $('#site-connection').addEventListener('click', () => { siteDetail = 'connection'; renderSiteInformation(); positionPopup(); $('#site-back').focus(); });
  $('#site-cookies').addEventListener('click', () => { siteDetail = 'cookies'; renderSiteInformation(); positionPopup(); $('#site-back').focus(); });
  $('#site-back').addEventListener('click', () => { const previous = siteDetail; siteDetail = 'overview'; renderSiteInformation(); positionPopup(); $(previous === 'cookies' ? '#site-cookies' : '#site-connection').focus(); });
  $('#menu-profile').addEventListener('click', () => openPopup('profile'));
  $('#popup-backdrop').addEventListener('pointerdown', () => closePopup());
  $$('[data-popup-command]').forEach(button => button.addEventListener('click', () => popupCommand(button.dataset.popupCommand)));
  $$('[data-popup-route]').forEach(button => button.addEventListener('click', () => popupCommand('navigate', { url: button.dataset.popupRoute })));
  $('#menu-exit').addEventListener('click', () => popupCommand('window', { action: 'close' }));
  $('#menu-zoom-out').addEventListener('click', () => action('zoom', { delta: -0.1 }));
  $('#menu-zoom-in').addEventListener('click', () => action('zoom', { delta: 0.1 }));
  $('#menu-zoom-reset').addEventListener('click', () => action('zoom', { reset: true }));
  $('#menu-fullscreen').addEventListener('click', () => popupCommand('window', { action: 'fullscreen' }));
  $('#tab-search-input').addEventListener('input', () => { renderSearchTabs(); positionPopup(); });
  document.addEventListener('pointerdown', event => {
    if (activePopup && !event.target.closest('.chrome-popup') && !event.target.closest('#menu,#tab-search,#profile,#site-info')) closePopup(false);
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'a') { event.preventDefault(); openPopup('tabs'); return; }
    if (!activePopup) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePopup(); return; }
    const focusables = popupFocusables(), index = focusables.indexOf(document.activeElement);
    if (event.key === 'Tab') {
      event.preventDefault();
      focusables[(index + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length]?.focus();
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && document.activeElement?.tagName !== 'SELECT') {
      event.preventDefault();
      focusables[(index + (event.key === 'ArrowUp' ? -1 : 1) + focusables.length) % focusables.length]?.focus();
    } else if ((event.key === 'Home' || event.key === 'End') && !['INPUT','SELECT'].includes(document.activeElement?.tagName)) {
      event.preventDefault(); focusables[event.key === 'Home' ? 0 : focusables.length - 1]?.focus();
    } else if (event.key === 'Enter' && document.activeElement === $('#tab-search-input')) {
      event.preventDefault(); $('.search-tab-select')?.click();
    }
  });
  window.addEventListener('resize', () => { cancelAnimationFrame(popupResizeFrame); popupResizeFrame = requestAnimationFrame(positionPopup); });
  // The main process handles actual window blur for permission prompts. Focus
  // transfers back to a granted page must not cancel the next queued request.
  window.addEventListener('blur', () => { if (activePopup && activePopup !== 'permission') closePopup(false); });
  $('#address-form').addEventListener('submit', event => { event.preventDefault(); const url = $('#address-input').value.trim(); if (url) { $('#address-input').blur(); action('navigate', { url }); } });
  $('#address-input').addEventListener('focus', event => event.target.select());
  $('#address-input').addEventListener('keydown', event => { if (event.key === 'Escape') { event.target.value = displayAddress(activeTab()); event.target.blur(); } });
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); $('#address-input').focus(); $('#address-input').select(); } });
  $('#zoom-indicator').addEventListener('click', () => action('zoom', { reset: true }));
  $('#zoom-out').addEventListener('click', () => action('zoom', { delta: -0.1 }));
  $('#zoom-in').addEventListener('click', () => action('zoom', { delta: 0.1 }));
  $('#zoom-reset').addEventListener('click', () => action('zoom', { reset: true }));
  $('#open-website').addEventListener('click', () => action('navigate', { url: state.host?.url || '/' }));
  $('#welcome-settings').addEventListener('click', () => { setSection('website'); action('navigate', { url: 'pseudo://settings/website' }); });
  $('#restart-site').addEventListener('click', () => action('restartSite'));
  $$('[data-command]').forEach(button => button.addEventListener('click', () => action(button.dataset.command)));
  $$('[data-section]').forEach(button => button.addEventListener('click', () => {
    setSection(button.dataset.section);
    action('navigate', { url: `pseudo://settings/${button.dataset.section}` });
  }));
  $('#theme-select').addEventListener('change', event => action('saveSettings', { theme: event.target.value }));
  $('#profile-name').addEventListener('input', () => {
    profileNameEdit++;
    profileNameDirty = true;
    clearTimeout(profileNameStatusTimer);
    $('#profile-name').removeAttribute('aria-invalid');
    $('#profile-name-status').classList.remove('error');
    $('#profile-name-status').textContent = 'Unsaved changes';
  });
  $('#profile-name-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (profileNameSaving) return;
    const field = $('#profile-name'), status = $('#profile-name-status');
    const raw = field.value, name = raw.trim(), edit = profileNameEdit;
    clearTimeout(profileNameStatusTimer);
    status.classList.remove('error');
    field.removeAttribute('aria-invalid');
    try {
      if (!name) throw new Error('Enter a profile name.');
      if (name.length > 64) throw new Error('Use a profile name with no more than 64 characters.');
      if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error('The profile name cannot contain control characters.');
      profileNameSaving = true;
      $('#profile-name-save').disabled = true;
      status.textContent = 'Saving…';
      await invoke('saveSettings', { profileName: name });
      if (edit === profileNameEdit && field.value === raw) {
        profileNameDirty = false;
        field.value = state.settings?.profileName || name;
        status.textContent = 'Saved';
        profileNameStatusTimer = setTimeout(() => { if (!profileNameDirty) status.textContent = ''; }, 3000);
      } else status.textContent = 'Unsaved changes';
    } catch (error) {
      status.textContent = error.message || String(error);
      status.classList.add('error');
      field.setAttribute('aria-invalid', 'true');
    } finally {
      profileNameSaving = false;
      $('#profile-name-save').disabled = false;
    }
  });
  $$('input[name="profileAvatar"]').forEach(input => input.addEventListener('change', () => {
    if (input.checked) saveProfileAvatar(input.value);
  }));
  $$('.profile-choice img').forEach(img => {
    img.addEventListener('error', () => markUnavailableAvatar(img), { once: true });
    if (img.complete && !img.naturalWidth) markUnavailableAvatar(img);
  });
  $('#settings-search').addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    if (!query) { setSection(section); return; }
    let matches = 0;
    $$('.settings-section').forEach(el => { const match = `${el.dataset.keywords} ${el.textContent}`.toLowerCase().includes(query); el.hidden = !match; if (match) matches++; });
    $$('[data-section]').forEach(el => el.classList.remove('selected'));
    $('#settings-no-results').hidden = matches > 0;
  });
  $('#site-form').addEventListener('input', () => { siteDirty = true; $('#site-save-status').textContent = 'Unsaved changes'; });
  $('#site-form').addEventListener('change', () => { siteDirty = true; $('#site-save-status').textContent = 'Unsaved changes'; });
  $('#site-form').addEventListener('submit', async event => {
    event.preventDefault(); $('#site-form-error').hidden = true;
    try {
      let args, env;
      try { args = JSON.parse($('#site-args').value || '[]'); } catch { throw new Error('Arguments must be a valid JSON array, for example ["--example", "value"].'); }
      try { env = JSON.parse($('#site-env').value || '{}'); } catch { throw new Error('Environment variables must be a valid JSON object.'); }
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Arguments must be an array containing only strings.');
      if (!env || Array.isArray(env) || typeof env !== 'object' || Object.values(env).some(value => typeof value !== 'string')) throw new Error('Environment variables must be an object with string values.');
      const port = Number($('#site-port').value || 0), backendPort = Number($('#site-backend-port').value || 0), timeout = Number($('#site-timeout').value || 30);
      if (![port, backendPort].every(p => Number.isInteger(p) && p >= 0 && p <= 65535)) throw new Error('Ports must be whole numbers from 0 through 65535.');
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 180) throw new Error('Startup timeout must be from 1 to 180 seconds.');
      const config = { mode: $('#site-mode').value, documentRoot: $('#site-document-root').value.trim() || '.', entry: $('#site-entry').value.trim(), npmScript: $('#site-npm-script').value.trim(), args, env, spa: $('#site-spa').checked, port, backendPort, startupTimeoutMs: timeout * 1000 };
      $('#save-site').disabled = true; $('#site-save-status').textContent = 'Saving…';
      await invoke('saveSiteConfig', config);
      siteDirty = false;
      await invoke('restartSite');
      $('#site-save-status').textContent = 'Saved';
    } catch (error) {
      $('#site-form-error').textContent = error.message || String(error); $('#site-form-error').hidden = false; $('#site-save-status').textContent = 'Could not apply configuration';
    } finally { $('#save-site').disabled = false; }
  });
  $('#startup-form').addEventListener('input', () => { startupDirty = true; $('#startup-save-status').textContent = 'Unsaved changes'; });
  $('#startup-form').addEventListener('submit', async event => {
    event.preventDefault();
    try { await invoke('saveSettings', { startupUrl: $('#startup-url').value.trim() || '/', restoreWindow: $('#restore-window').checked }); startupDirty = false; $('#startup-save-status').textContent = 'Saved'; }
    catch (error) { $('#startup-save-status').textContent = error.message || String(error); }
  });
  if (bridge) {
    bridge.onState(applyState);
    invoke('getState').then(result => { if (result) applyState(result); }).catch(error => notice(error.message));
  } else {
    $('#welcome-status-text').textContent = 'The application bridge is unavailable.';
    $('#welcome-description').textContent = 'Start Pseudo-Chrome using its executable. This page is part of the desktop application.';
    $('#open-website').disabled = true;
  }
})();
