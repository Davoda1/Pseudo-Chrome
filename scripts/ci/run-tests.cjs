#!/usr/bin/env node
'use strict';
// Validate the actual portable package with the required suites for each OS.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { electronEnvironment } = require('../../tests/helpers/electron-env.cjs');

const root = path.resolve(__dirname, '../..');

function selectUnitTestArguments(platform, files) {
  // Each Windows file starts real nginx/Node/PHP processes. Run those fixtures
  // sequentially so unrelated suites do not compete during process startup.
  return ['--test', ...(platform === 'win32' ? ['--test-concurrency=1'] : []), ...files];
}

function selectElectronSuites(platform, extendedWindowsUI = '') {
  const suites = ['launch', 'smoke', 'popups', 'permissions', 'storage', 'devtools', 'favicons', 'navigation'];
  if (platform === 'win32' && extendedWindowsUI !== '1') {
    return suites.filter(suite => !['popups', 'permissions', 'devtools'].includes(suite));
  }
  return suites;
}

function runSuites(suites, env) {
  const failures = [];
  for (const { label, args, timeout } of suites) {
    process.stdout.write(`\nRunning ${label} on ${process.platform}\n`);
    try {
      const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', timeout });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`exit=${result.status}, signal=${result.signal}`);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
      process.stderr.write(`FAILED ${failures.at(-1)}\n`);
    }
  }
  if (failures.length) {
    process.stderr.write(`\n${failures.length} required suite(s) failed:\n${failures.map(failure => `- ${failure}`).join('\n')}\n`);
    return 1;
  }
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--package' || !['linux', 'win32'].includes(process.platform)) {
    throw new Error('Usage: node scripts/ci/run-tests.cjs --package ABSOLUTE_PORTABLE_DIRECTORY (Linux or Windows)');
  }
  const portable = path.resolve(args[1]);
  const runtimes = path.join(portable, 'resources', 'runtimes');
  const paths = JSON.parse(fs.readFileSync(path.join(runtimes, 'paths.json'), 'utf8'));
  function runtime(key) {
    if (typeof paths[key] !== 'string') throw new Error(`Missing runtime mapping: ${key}`);
    const result = path.resolve(runtimes, paths[key]);
    if (!result.startsWith(runtimes + path.sep) || !fs.statSync(result).isFile()) throw new Error(`Invalid runtime: ${key}`);
    return result;
  }
  const executable = path.join(portable, process.platform === 'win32' ? 'Pseudo-Chrome.exe' : 'pseudo-chrome');
  if (!fs.statSync(executable).isFile()) throw new Error('Missing packaged Electron executable');
  const env = electronEnvironment({
    ...process.env,
    PSEUDO_CHROME_ELECTRON: executable,
    PSEUDO_CHROME_PACKAGED: '1',
    PSEUDO_CHROME_RUNTIMES: runtimes,
    PSEUDO_CHROME_HEADLESS: process.platform === 'linux' ? '1' : '0',
    PSEUDO_CHROME_TEST_SCALE: '1.25',
    PSEUDO_TEST_NODE: runtime('node'),
    PSEUDO_TEST_NPM_CLI: runtime('npmCli'),
    PSEUDO_TEST_NGINX: runtime('nginx'),
    PSEUDO_TEST_PHP: runtime('php'),
    DEBUG: [process.env.DEBUG, 'pw:browser'].filter(Boolean).join(',')
  });
  if (process.platform === 'win32') env.PSEUDO_TEST_RUNNER = runtime('processRunner');
  else delete env.PSEUDO_TEST_RUNNER;

  const unitFiles = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.cjs')).sort();
  if (unitFiles.length === 0) throw new Error('No unit/integration tests found');
  const suites = [{ label: 'unit and real-runtime integration tests', args: selectUnitTestArguments(process.platform, unitFiles.map(name => `tests/${name}`)), timeout: 10 * 60 * 1000 }];
  if (process.platform === 'win32') process.stdout.write('Windows unit/runtime test files run sequentially; every test file is required.\n');
  if (process.platform === 'win32' && env.PSEUDO_CHROME_EXTENDED_WINDOWS_UI !== '1') {
    process.stdout.write('Windows native-window geometry suites (popups, permissions, devtools) are not selected. Set PSEUDO_CHROME_EXTENDED_WINDOWS_UI=1 to include them.\n');
  }
  for (const suite of selectElectronSuites(process.platform, env.PSEUDO_CHROME_EXTENDED_WINDOWS_UI)) {
    suites.push({ label: `packaged Electron ${suite}`, args: [`tests/electron-${suite}.cjs`], timeout: (suite === 'launch' ? 2 : 8) * 60 * 1000 });
  }
  const result = runSuites(suites, env);
  if (result === 0) process.stdout.write('\nAll selected required suites passed. Windows intentionally omits two Linux/symlink-specific unit cases.\n');
  return result;
}

if (require.main === module) process.exitCode = main();
module.exports = { runSuites, selectElectronSuites, selectUnitTestArguments };
