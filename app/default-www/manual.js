'use strict';
(() => {
  const chapters = [...document.querySelectorAll('.chapter')];
  const navLinks = [...document.querySelectorAll('#chapter-nav a')];
  const search = document.querySelector('#manual-search');
  const clearSearch = document.querySelector('#clear-search');
  const results = document.querySelector('#search-results');
  const resultList = document.querySelector('#result-list');
  const summary = document.querySelector('#search-summary');
  const readingPane = document.querySelector('.reading-pane');
  const footer = document.querySelector('.chapter-footer');
  const current = document.querySelector('#current-chapter');
  const toast = document.querySelector('#toast');
  let toastTimer;
  let activeId = '';
  function readableText(root) {
    const boundaries = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL']);
    const parts = [];
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) { parts.push(node.nodeValue); return; }
      if (node.nodeType !== Node.ELEMENT_NODE || ['BUTTON', 'SCRIPT', 'STYLE'].includes(node.tagName) || node.getAttribute('aria-hidden') === 'true') return;
      const boundary = boundaries.has(node.tagName);
      if (boundary) parts.push(' ');
      for (const child of node.childNodes) visit(child);
      if (boundary) parts.push(' ');
    }
    visit(root);
    return parts.join('').replace(/\s+/g, ' ').trim();
  }
  const records = chapters.map(chapter => ({
    id: chapter.id,
    title: chapter.dataset.title,
    text: readableText(chapter),
    keywords: chapter.dataset.keywords || ''
  }));
  function chapterId() {
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { id = ''; }
    return chapters.some(chapter => chapter.id === id) ? id : 'overview';
  }
  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
  }
  function adjacentLink(selector, record, direction) {
    const link = document.querySelector(selector);
    link.setAttribute('aria-disabled', String(!record));
    link.tabIndex = record ? 0 : -1;
    if (!record) return;
    link.href = '#' + record.id;
    link.querySelector('strong').textContent = record.title + (direction === 'next' ? ' →' : '');
  }
  function showChapter({focus = false} = {}) {
    const id = chapterId();
    const index = records.findIndex(record => record.id === id);
    const changed = activeId !== id;
    activeId = id;
    search.value = '';
    clearSearch.hidden = true;
    document.querySelector('.search-key').hidden = false;
    results.hidden = true;
    footer.hidden = false;
    chapters.forEach(chapter => { chapter.hidden = chapter.id !== id; });
    navLinks.forEach(link => {
      if (link.dataset.chapter === id) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    current.textContent = records[index].title;
    document.title = records[index].title + ' — Pseudo-Chrome Manual';
    adjacentLink('#previous-chapter', records[index - 1], 'previous');
    adjacentLink('#next-chapter', records[index + 1], 'next');
    if (changed || focus) readingPane.scrollTop = 0;
    if (focus) document.getElementById(id).querySelector('h1').focus({preventScroll: true});
  }
  function escapedPattern(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function addHighlighted(element, text, terms) {
    const pattern = new RegExp('(' + terms.map(escapedPattern).join('|') + ')', 'ig');
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > cursor) element.append(document.createTextNode(text.slice(cursor, match.index)));
      const mark = document.createElement('mark');
      mark.textContent = match[0];
      element.append(mark);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) element.append(document.createTextNode(text.slice(cursor)));
  }
  function performSearch() {
    const query = search.value.trim().slice(0, 160);
    clearSearch.hidden = !query;
    document.querySelector('.search-key').hidden = Boolean(query);
    if (!query) { showChapter(); return; }
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
    const matches = records.map(record => {
      const haystack = (record.title + ' ' + record.keywords + ' ' + record.text).toLowerCase();
      const score = terms.every(term => haystack.includes(term)) ? terms.reduce((sum, term) => sum + (record.title.toLowerCase().includes(term) ? 10 : 0) + (record.keywords.includes(term) ? 3 : 0) + 1, 0) : 0;
      return {...record, score};
    }).filter(record => record.score).sort((a, b) => b.score - a.score);
    chapters.forEach(chapter => { chapter.hidden = true; });
    navLinks.forEach(link => link.removeAttribute('aria-current'));
    results.hidden = false;
    footer.hidden = true;
    current.textContent = 'Search';
    document.title = 'Search — Pseudo-Chrome Manual';
    resultList.replaceChildren();
    summary.textContent = matches.length + (matches.length === 1 ? ' chapter matches ' : ' chapters match ') + '“' + query + '”.';
    document.querySelector('#no-results').hidden = matches.length > 0;
    for (const record of matches) {
      const link = document.createElement('a');
      link.className = 'result-card';
      link.href = '#' + record.id;
      const title = document.createElement('h2');
      addHighlighted(title, record.title, terms);
      const text = document.createElement('p');
      const position = Math.min(...terms.map(term => record.text.toLowerCase().indexOf(term)).filter(value => value >= 0));
      const start = Number.isFinite(position) ? Math.max(0, position - 65) : 0;
      const excerpt = (start ? '…' : '') + record.text.slice(start, start + 240).trim() + (start + 240 < record.text.length ? '…' : '');
      addHighlighted(text, excerpt, terms);
      link.append(title, text);
      resultList.append(link);
    }
    readingPane.scrollTop = 0;
  }
  search.addEventListener('input', performSearch);
  clearSearch.addEventListener('click', () => { showChapter(); search.focus(); });
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    if (link.classList.contains('skip-link')) { event.preventDefault(); readingPane.focus(); return; }
    if (link.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
    const target = link.getAttribute('href').slice(1);
    if (!chapters.some(chapter => chapter.id === target)) return;
    if (location.hash === '#' + target) { event.preventDefault(); showChapter({focus: true}); }
  });
  window.addEventListener('hashchange', () => showChapter({focus: true}));
  document.addEventListener('keydown', event => {
    const editing = event.target instanceof Element && (event.target.closest('input,textarea,select,[contenteditable="true"]'));
    if (event.key === '/' && !event.ctrlKey && !event.altKey && !event.metaKey && !editing) {
      event.preventDefault(); search.focus(); search.select();
    } else if (event.key === 'Escape' && search.value) {
      showChapter(); search.focus();
    }
  });
  document.querySelector('#print-manual').addEventListener('click', () => window.print());
  for (const button of document.querySelectorAll('.copy-code')) {
    button.addEventListener('click', async () => {
      const code = button.closest('.code-block').querySelector('code');
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(code.textContent);
        showToast('Configuration copied.');
      } catch {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges(); selection.addRange(range);
        showToast('Example selected. Press Ctrl+C to copy.');
      }
    });
  }
  showChapter();
})();
