'use strict';
const http = require('node:http');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Node website example</title><style>:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}body{max-width:760px;margin:50px auto;padding:0 24px}h1{font-size:34px}form,pre{padding:24px;border:1px solid #80909f66;border-radius:12px}input,button{font:inherit;padding:9px 12px;border:1px solid #80909f88;border-radius:7px}input{max-width:100%;margin-right:8px}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}small{opacity:.7}</style><h1>A real Node.js backend.</h1><p>The page below reads a JSON API and submits a POST request to the local server.</p><form id="form"><label for="message">Message</label><p><input id="message" name="message" value="Hello from the website"><button>Send to backend</button></p></form><h2>Backend response</h2><pre id="result" aria-live="polite">Loading…</pre><small>Uses bundled Node.js and no third-party packages.</small><script>const output=document.getElementById('result');async function show(url,options){try{const response=await fetch(url,options);output.textContent=JSON.stringify(await response.json(),null,2)}catch(error){output.textContent=error.message}}document.getElementById('form').addEventListener('submit',e=>{e.preventDefault();show('/api/echo',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(e.target))})});show('/api/status');</script></html>`;
function json(res, code, data) { const body = JSON.stringify(data, null, 2); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }); res.end(body); }
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/' && ['GET', 'HEAD'].includes(req.method)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page); return; }
  if (pathname === '/api/status' && req.method === 'GET') { json(res, 200, { ready: true, node: process.version, time: new Date().toISOString(), host, port }); return; }
  if (pathname === '/api/echo' && req.method === 'POST') {
    let body = '', length = 0;
    req.on('data', chunk => { length += chunk.length; if (length > 65536) { json(res, 413, { error: 'Message too large' }); req.destroy(); } else body += chunk; });
    req.on('end', () => { if (!res.writableEnded) json(res, 200, { message: new URLSearchParams(body).get('message') || '', receivedAt: new Date().toISOString() }); });
    return;
  }
  json(res, 404, { error: 'Not found' });
});
server.listen(port, host, () => console.log(`Node example listening on http://${host}:${server.address().port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
