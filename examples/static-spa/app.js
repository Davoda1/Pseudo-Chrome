'use strict';
function render() {
  const details = location.pathname === '/details';
  document.title = details ? 'Details — Static website example' : 'Static website example';
  document.querySelectorAll('nav a').forEach(a => { if ((a.dataset.page === 'details') === details) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  document.getElementById('content').innerHTML = details
    ? '<h2>A real page route.</h2><p>The address ends in <code>/details</code>. Reload this page: the local server returns the same app, which reads the route again.</p><p>Use the browser’s back and forward buttons to move between Overview and Details. Open the link in another tab to check independent navigation.</p>'
    : '<h2>Ready to demonstrate.</h2><p>This folder is already built. Copy its contents into <code>www</code>, choose Static mode, and enable SPA routing.</p><div class="cards"><div class="card"><strong>Local assets</strong><p>The stylesheet, script and favicon are served from this folder.</p></div><div class="card"><strong>Browser history</strong><p>Navigation uses ordinary paths and the History API.</p></div><div class="card"><strong>System theme</strong><p>The website chooses its own colors through CSS.</p></div></div>';
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-page]');
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault(); history.pushState(null, '', a.getAttribute('href')); render();
});
addEventListener('popstate', render); render();
