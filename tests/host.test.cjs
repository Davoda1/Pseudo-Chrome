'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { SiteHost, validateConfig, requestPath } = require('../app/lib/host.cjs');

async function fixture(t, runtimes = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pseudo-host-'));
  const www = path.join(dir, 'www'); await fs.mkdir(www);
  const host = new SiteHost({ www, configDir: path.join(dir, 'config'), runtimes: { ...(process.env.PSEUDO_TEST_RUNNER ? { processRunner: process.env.PSEUDO_TEST_RUNNER } : {}), ...(process.env.PSEUDO_TEST_NGINX ? { nginx: process.env.PSEUDO_TEST_NGINX } : {}), ...runtimes } });
  t.after(async () => { await host.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, www, host, write: (name, content) => fs.writeFile(path.join(www, name), content) };
}
function request(url, pathname = '/', options = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: parsed.hostname, port: parsed.port, path: pathname, method: options.method || 'GET', headers: options.headers || {} }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }); req.on('error', reject); req.end(options.body);
  });
}

test('configuration and URL validation reject escaping paths and malformed input', () => {
  assert.throws(() => validateConfig({ port: -1 }), /port/);
  assert.throws(() => validateConfig({ args: 'one two' }), /array/);
  assert.throws(() => validateConfig({ env: { NODE_OPTIONS: '--require evil' } }), /NODE_OPTIONS/);
  assert.throws(() => validateConfig({ documentRoot: '/tmp' }), /relative/);
  for (const pathname of ['/../secret', '/%2e%2e/secret', '/.env', '/dir/.git/config', '/package.json', '/a%5cb', '/bad%zz', '/a%00']) assert.throws(() => requestPath(pathname));
  assert.equal(requestPath('/assets/hello%20world.svg?version=3'), '/assets/hello world.svg');
});

test('static site serves files, real subdirectory indexes, ranges, HEAD and conditional requests', async t => {
  const f = await fixture(t); await f.write('index.html', '<h1>Demo</h1>'); await f.write('sample.txt', '0123456789');
  await fs.mkdir(path.join(f.www, 'section')); await f.write('section/index.html', 'section index');
  const state = await f.host.start({ mode: 'auto' }); assert.equal(state.mode, 'static'); assert.equal(state.state, 'ready');
  const page = await request(state.url); assert.equal(page.status, 200); assert.match(page.body, /Demo/); assert.match(page.headers['content-type'], /text\/html/);
  assert.equal((await request(state.url, '/section')).status, 301);
  assert.equal((await request(state.url, '/section/')).body, 'section index');
  const range = await request(state.url, '/sample.txt', { headers: { Range: 'bytes=3-6' } }); assert.equal(range.status, 206); assert.equal(range.body, '3456'); assert.equal(range.headers['content-range'], 'bytes 3-6/10');
  assert.equal((await request(state.url, '/sample.txt', { headers: { Range: 'bytes=30-60' } })).status, 416);
  const head = await request(state.url, '/sample.txt', { method: 'HEAD' }); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], '10');
  assert.equal((await request(state.url, '/', { headers: { 'If-None-Match': page.headers.etag } })).status, 304);
  assert.equal((await request(state.url, '/sample.txt', { method: 'POST', body: 'x' })).status, 405);
});

test('static gateway prevents source, secret, directory listing and symlink escape exposure', async t => {
  const f = await fixture(t); await f.write('index.html', 'safe'); await f.write('.env', 'SECRET'); await f.write('index.php', '<?php secret ?>'); await f.write('data.sqlite', 'SECRET');
  await fs.mkdir(path.join(f.www, 'empty')); await fs.writeFile(path.join(f.dir, 'secret.txt'), 'SECRET');
  try { await fs.symlink(path.join(f.dir, 'secret.txt'), path.join(f.www, 'outside.txt')); } catch (e) { if (process.platform !== 'win32') throw e; }
  await f.write('.credentials.json', '{"secret":true}');
  try { await fs.symlink(path.join(f.www, '.credentials.json'), path.join(f.www, 'public.json')); } catch (e) { if (process.platform !== 'win32') throw e; }
  const { url } = await f.host.start({ mode: 'static' });
  for (const pathname of ['/.env', '/index.php', '/data.sqlite']) assert.equal((await request(url, pathname)).status, 403, pathname);
  assert.ok([400, 403].includes((await request(url, '/%2e%2e/secret.txt')).status), 'Traversal is rejected by nginx or the gateway');
  assert.equal((await request(url, '/empty/')).status, 404);
  if (await fs.lstat(path.join(f.www, 'outside.txt')).catch(() => null)) assert.equal((await request(url, '/outside.txt')).status, 403);
  if (await fs.lstat(path.join(f.www, 'public.json')).catch(() => null)) assert.equal((await request(url, '/public.json')).status, 403);
  assert.equal((await request(url, '/', { headers: { Host: 'attacker.example' } })).status, 403);
  await assert.rejects(f.host.start({ documentRoot: '..' }), /inside www/);
});

test('SPA routing and built React output detection serve index only for page routes', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.www, 'dist')); await f.write('dist/index.html', 'built-react');
  const { url, mode, documentRoot } = await f.host.start({ spa: true }); assert.equal(mode, 'static'); assert.match(documentRoot, /dist$/);
  assert.equal((await request(url, '/account/preferences')).body, 'built-react');
  assert.equal((await request(url, '/missing.js')).status, 404);
  assert.equal((await request(url, '/.env')).status, 403);
});

const nodeSource = `const http=require('http'); const s=http.createServer((req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{res.setHeader('Set-Cookie',['first=1; Path=/','second=2; Path=/']);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({path:req.url,body,host:req.headers.host}));});});s.on('upgrade',(req,socket,head)=>{socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n');if(head.length)socket.write(head);socket.on('data',b=>socket.write(b));});s.listen(+process.env.PORT,process.env.HOST);`;

test('Node backend receives bodies, routes and cookies; stop terminates its listening port', async t => {
  const f = await fixture(t, { node: process.execPath }); await f.write('server.cjs', nodeSource);
  const { url, pid, mode } = await f.host.start({ mode: 'node', entry: 'server.cjs' }); assert.equal(mode, 'node'); assert.ok(pid);
  const response = await request(url, '/api/echo?x=1', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello backend' });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).body, 'hello backend'); assert.equal(JSON.parse(response.body).path, '/api/echo?x=1'); assert.equal(response.headers['set-cookie'].length, 2);
  assert.equal((await request(url, '/api/echo', { method: 'POST', headers: { Origin: 'https://unrelated.example' }, body: 'blocked' })).status, 403);
  const port = f.host.backendPort; await f.host.stop(); assert.equal(f.host.status.state, 'stopped');
  await assert.rejects(new Promise((resolve,reject)=>{const s=net.createConnection({host:'127.0.0.1',port});s.on('connect',()=>{s.destroy();resolve()});s.on('error',reject)}));
});

test('Node WebSocket-style upgrade is tunneled bidirectionally', async t => {
  const f = await fixture(t, { node: process.execPath }); await f.write('server.cjs', nodeSource); const { url } = await f.host.start({ mode: 'node', entry: 'server.cjs' });
  const port = Number(new URL(url).port);
  const data = await new Promise((resolve, reject) => {
    const s = net.createConnection({ host: '127.0.0.1', port }); let text = '', sent = false;
    s.setTimeout(3000,()=>{s.destroy();reject(Error('Upgrade timeout'))});
    s.on('connect', () => s.write(`GET /socket HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`));
    s.on('data', b => { text += b; if (!sent && text.includes('\r\n\r\n')) { sent = true; s.write('echo-data'); } if(text.includes('echo-data')) {s.destroy();resolve(text)} }); s.on('error',reject);
  }); assert.match(data,/101 Switching Protocols/); assert.match(data,/echo-data/);
});

test('backend startup failure and all-interface binding produce actionable errors and clean up', async t => {
  const f = await fixture(t, { node: process.execPath });
  await assert.rejects(f.host.start({ mode: 'node', entry: 'missing.js' }), /not found/);
  await f.write('bad.cjs', 'process.exit(9)'); await assert.rejects(f.host.start({ mode: 'node', entry: 'bad.cjs', startupTimeoutMs: 1000 }), /exited/);
  await f.write('wide.cjs', "require('http').createServer((q,s)=>s.end('ok')).listen(+process.env.PORT,'0.0.0.0')");
  await assert.rejects(f.host.start({ mode: 'node', entry: 'wide.cjs' }), /all interfaces/); assert.equal(f.host.children.length,0);
});

test('concurrent starts are rejected and stop waits for startup cancellation', async t => {
  const f = await fixture(t, { node: process.execPath });
  await f.write('slow.cjs', "setTimeout(()=>require('http').createServer((q,s)=>s.end('late')).listen(+process.env.PORT,process.env.HOST),3000)");
  const first = f.host.start({ mode: 'node', entry: 'slow.cjs', startupTimeoutMs: 5000 });
  const rejected = assert.rejects(first, e => e.code === 'ABORT_ERR');
  await assert.rejects(f.host.start({ mode: 'node', entry: 'slow.cjs' }), /already in progress/);
  await new Promise(resolve => setTimeout(resolve, 100)); await f.host.stop(); await rejected;
  assert.equal(f.host.status.state, 'stopped'); assert.equal(f.host.children.length, 0); assert.equal(f.host.gateway, null);
  await f.write('index.html', 'restarted'); const state = await f.host.start({ mode: 'static' }); assert.equal((await request(state.url)).body, 'restarted');
});

test('exited Linux process leaders do not leave a listening descendant behind', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { node: process.execPath });
  await f.write('child.cjs', "require('fs').writeFileSync('child-port.txt',process.env.PORT);require('http').createServer((q,s)=>s.end('descendant')).listen(+process.env.PORT,process.env.HOST,()=>process.send('ready'))");
  await f.write('parent.cjs', "const child=require('child_process').spawn(process.execPath,['child.cjs'],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>process.exit(0))");
  await f.host.start({ mode: 'node', entry: 'parent.cjs' }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 650));
  const port = Number(await fs.readFile(path.join(f.www, 'child-port.txt'), 'utf8'));
  await assert.rejects(new Promise((resolve,reject)=>{const s=net.createConnection({host:'127.0.0.1',port});s.on('connect',()=>{s.destroy();resolve()});s.on('error',reject)}));
  assert.equal(f.host.children.length, 0);
});
