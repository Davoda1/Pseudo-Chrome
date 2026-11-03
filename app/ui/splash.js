'use strict';
(() => {
  const bridge = window.pseudoChrome;
  const media = matchMedia('(prefers-color-scheme: dark)');
  document.documentElement.dataset.theme = media.matches ? 'dark' : 'light';
  function update(state) {
    if (!state) return;
    if (state.theme) document.documentElement.dataset.theme = state.theme === 'dark' ? 'dark' : 'light';
    const progress = state.splashProgress || state.host || state;
    const status = progress.status || progress.state;
    const message = progress.message || (status === 'ready' ? 'Opening your website…' : status === 'error' ? 'Opening website settings…' : 'Starting website…');
    document.querySelector('#message').textContent = message;
    const bar = document.querySelector('#progress');
    const complete = ['ready', 'complete'].includes(status);
    bar.setAttribute('aria-label', message);
    bar.classList.toggle('finished', complete);
    bar.classList.toggle('error', status === 'error');
    // Startup stages have no measurable percentage; only completion is determinate.
    if (complete) bar.setAttribute('aria-valuenow', '100');
    else bar.removeAttribute('aria-valuenow');
  }
  document.querySelector('#minimize').addEventListener('click', () => bridge?.invoke('window', { action: 'minimize' }).catch(() => {}));
  document.querySelector('#close').addEventListener('click', () => bridge?.invoke('window', { action: 'close' }).catch(() => {}));
  if (bridge) { bridge.onState(update); bridge.invoke('getState').then(update).catch(() => {}); }
})();
