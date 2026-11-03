'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { SiteHost } = require('../app/lib/host.cjs');

const nginxPath = process.env.PSEUDO_TEST_NGINX;

async function fixture(t, Host = SiteHost, runtimes = {}) {
  // Exercise spaces, non-ASCII profile names and nginx-special punctuation.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pseudo nginx-'));
  const profile = path.join(dir, 'Árvíztűrő 王 $profile');
  const www = path.join(profile, 'www'); await fs.mkdir(www, { recursive: true });
  await fs.writeFile(path.join(www, 'index.html'), '<h1>Windows hosting regression</h1>');
  const host = new Host({ www, configDir: profile, runtimes });
  t.after(async () => { await host.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, profile, www, host };
}

test('nginx launch owns all module temp paths, with ASCII arguments and actionable fresh diagnostics', async t => {
  let launch;
  class FailingNginxHost extends SiteHost {
    _spawn(label, executable, args, options) {
      if (label !== 'nginx') return super._spawn(label, executable, args, options);
      launch = { args, options };
      // A real child exits exactly as nginx does after logging a startup error.
      const script = "require('fs').appendFileSync('nginx-error.log', '[emerg] bind() to 127.0.0.1:43881 failed (10013: Permission denied)\\n'); process.exit(1);";
      return super._spawn(label, process.execPath, ['-e', script], options);
    }
  }
  const f = await fixture(t, FailingNginxHost, { nginx: process.execPath });
  await fs.writeFile(path.join(f.profile, 'nginx-error.log'), '[emerg] STALE PREVIOUS FAILURE\n');
  await assert.rejects(f.host.start({ mode: 'static' }), error => {
    assert.match(error.message, /nginx exited \(1\)/);
    assert.match(error.message, /bind\(\).*10013: Permission denied/);
    assert.match(error.message, /nginx-error\.log/);
    assert.doesNotMatch(error.message, /STALE PREVIOUS FAILURE/);
    return true;
  });
  assert.deepEqual(launch.args, ['-p', './', '-c', 'nginx.conf', '-e', 'stderr', '-g', 'daemon off;']);
  assert.equal(launch.options.cwd, f.profile);
  const conf = await fs.readFile(path.join(f.profile, 'nginx.conf'), 'utf8');
  assert.match(conf, /^error_log stderr warn;$/m);
  for (const [module, directory] of Object.entries({ client_body: 'nginx-body', proxy: 'nginx-proxy', fastcgi: 'nginx-fastcgi', uwsgi: 'nginx-uwsgi', scgi: 'nginx-scgi' })) {
    assert.match(conf, new RegExp(`^ ${module}_temp_path ${directory};$`, 'm'));
    assert.equal((await fs.stat(path.join(f.profile, directory))).isDirectory(), true);
  }
  assert.equal(f.host.gateway, null); assert.equal(f.host.children.length, 0);
  assert.equal(f.host.status.state, 'error'); assert.match(f.host.status.error, /10013/);
});

test('early nginx stderr is retained even before its error log exists', async t => {
  class EarlyFailureHost extends SiteHost {
    _spawn(label, executable, args, options) {
      if (label !== 'nginx') return super._spawn(label, executable, args, options);
      return super._spawn(label, process.execPath, ['-e', "process.stderr.write('nginx: [emerg] invalid option: --broken\\n'); process.exitCode=1;"], options);
    }
  }
  const f = await fixture(t, EarlyFailureHost, { nginx: process.execPath });
  await assert.rejects(f.host.start(), /invalid option: --broken/);
  assert.ok(f.host.logs.some(line => line.includes('invalid option: --broken')));
});

test('official Windows nested temp defaults reproduce exit 1; explicit paths start and serve successfully', { skip: !nginxPath && 'Set PSEUDO_TEST_NGINX to run the real nginx regression' }, async t => {
  const f = await fixture(t, SiteHost, { nginx: nginxPath, ...(process.env.PSEUDO_TEST_RUNNER ? { processRunner: process.env.PSEUDO_TEST_RUNNER } : {}) });
  const { url } = await f.host.start({ mode: 'static' });
  const html = await new Promise((resolve, reject) => http.get(url, response => {
    let body = ''; response.setEncoding('utf8'); response.on('data', b => { body += b; }); response.on('end', () => resolve(body));
  }).on('error', reject));
  assert.match(html, /Windows hosting regression/);
  await f.host.stop();
  const correct = await fs.readFile(path.join(f.profile, 'nginx.conf'), 'utf8');
  // These are the compiled defaults of the packaged official Windows binary.
  // Setting them explicitly reproduces the same initialization on any platform.
  const oldWindowsDefaults = correct.replace(/ (fastcgi|uwsgi|scgi)_temp_path nginx-\1;/g, ' $1_temp_path temp/$1_temp;');
  assert.notEqual(oldWindowsDefaults, correct);
  await fs.writeFile(path.join(f.profile, 'windows-defaults.conf'), oldWindowsDefaults);
  const old = spawnSync(nginxPath, ['-t', '-p', './', '-c', 'windows-defaults.conf', '-e', 'stderr'], { cwd: f.profile, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(old.status, 1, old.stderr || old.error?.message);
  assert.match(old.stderr, /(?:mkdir|CreateDirectory)\(\).*temp[\\/]fastcgi_temp.*failed/);
  const fixed = spawnSync(nginxPath, ['-t', '-p', './', '-c', 'nginx.conf', '-e', 'stderr'], { cwd: f.profile, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(fixed.status, 0, fixed.stderr || fixed.error?.message);
});
