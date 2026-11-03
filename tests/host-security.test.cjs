'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { SiteHost, requestPath } = require('../app/lib/host.cjs');

async function fixture(t, Host = SiteHost, runtimes = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pseudo-host-security-'));
  const www = path.join(directory, 'www'), configDir = path.join(directory, 'config');
  await fs.mkdir(www); await fs.mkdir(configDir);
  const host = new Host({ www, configDir, runtimes });
  t.after(async () => { await host.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, www, configDir, host };
}
function request(origin, target) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: new URL(origin).port, path: target, timeout: 5000 }, response => {
      let body = ''; response.on('data', bytes => { body += bytes; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Request timed out')));
  });
}

test('directory redirects retain the local origin and encode filename URL metacharacters', async t => {
  const f = await fixture(t);
  const names = ['example.com', 'folder #&% name'];
  if (process.platform !== 'win32') names.push('question?mark');
  for (const name of names) {
    await fs.mkdir(path.join(f.www, name)); await fs.writeFile(path.join(f.www, name, 'index.html'), 'directory page');
  }
  const { url } = await f.host.start({ mode: 'static' });
  for (const target of ['//example.com', '/%2fexample.com', '/%2F%2Fexample.com', '/%5cexample.com']) {
    const result = await request(url, target);
    assert.equal(result.status, 400, target); assert.equal(result.headers.location, undefined);
  }
  for (const name of names) {
    const target = '/' + encodeURIComponent(name);
    const result = await request(url, target + '?value=one%20two&next=%2Fproducts');
    assert.equal(result.status, 301);
    const redirect = new URL(result.headers.location, url);
    assert.equal(redirect.origin, url);
    assert.equal(decodeURIComponent(redirect.pathname), '/' + name + '/');
    assert.equal(redirect.search, '?value=one%20two&next=%2Fproducts');
    assert.equal(redirect.hash, '');
    assert.equal((await request(url, redirect.pathname + redirect.search)).body, 'directory page');
  }
});

test('public file resolution rejects traversal and a sibling with the same root prefix', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.www, 'index.html'), 'public');
  const outside = path.join(f.directory, 'www-private');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'hidden.txt'), 'outside root');
  await fs.symlink(outside, path.join(f.www, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const { url } = await f.host.start({ mode: 'static' });
  for (const target of ['/../www-private/hidden.txt', '/%2e%2e/www-private/hidden.txt', '/linked/hidden.txt']) {
    const result = await request(url, target); assert.equal(result.status, 403, target); assert.ok(!result.body.includes('outside root'));
  }
  assert.equal((await request(url, '/')).body, 'public');
  assert.throws(() => requestPath('/%00hidden'), /Invalid request path/);
});

class ConfigProbeHost extends SiteHost {
  _spawn(label, ...args) {
    if (label === 'nginx') throw new Error('Configuration prepared for audit');
    return super._spawn(label, ...args);
  }
}

test('nginx config replacement is atomic and private without following an existing hard link', async t => {
  const f = await fixture(t, ConfigProbeHost, { nginx: process.execPath });
  const outside = path.join(f.directory, 'unrelated.txt');
  await fs.writeFile(outside, 'original unrelated file');
  await fs.link(outside, path.join(f.configDir, 'nginx.conf'));
  await assert.rejects(f.host.start({ mode: 'static' }), /Configuration prepared for audit/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'original unrelated file');
  assert.match(await fs.readFile(path.join(f.configDir, 'nginx.conf'), 'utf8'), /worker_processes 1;/);
  assert.equal((await fs.readdir(f.configDir)).some(name => name.startsWith('.pseudo-config-')), false);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(f.configDir)).mode & 0o777, 0o700);
    for (const name of ['nginx.conf', 'nginx-error.log']) assert.equal((await fs.stat(path.join(f.configDir, name))).mode & 0o777, 0o600);
  }
});

test('nginx cannot append diagnostics through an existing hard link', async t => {
  const f = await fixture(t, ConfigProbeHost, { nginx: process.execPath });
  const outside = path.join(f.directory, 'unrelated.txt');
  await fs.writeFile(outside, 'original unrelated file');
  await fs.link(outside, path.join(f.configDir, 'nginx-error.log'));
  await assert.rejects(f.host.start({ mode: 'static' }), /hosting log must be a regular file, not a link/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'original unrelated file');
  assert.equal(f.host.children.length, 0); assert.equal(f.host.gateway, null);
});

test('readiness requests accept only a bounded numeric loopback port', async t => {
  const f = await fixture(t);
  for (const value of [0, -1, 65536, NaN, Infinity, 'http://example.com/', '80/secret', '43881\r\nHost: example.com']) {
    await assert.rejects(f.host._waitPort(value, 0, 1, true), /Invalid local readiness port/);
  }
});
