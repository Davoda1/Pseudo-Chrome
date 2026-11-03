'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { selectElectronSuites, selectUnitTestArguments } = require('../scripts/ci/run-tests.cjs');

test('Windows serializes runtime test files while preserving the complete file list', () => {
  const files = ['tests/host-access.test.cjs', 'tests/host-lifecycle.test.cjs', 'tests/runtime.test.cjs'];
  assert.deepEqual(selectUnitTestArguments('win32', files), ['--test', '--test-concurrency=1', ...files]);
  assert.deepEqual(selectUnitTestArguments('linux', files), ['--test', ...files]);
  assert.deepEqual(selectUnitTestArguments('darwin', files), ['--test', ...files]);
  assert.deepEqual(files, ['tests/host-access.test.cjs', 'tests/host-lifecycle.test.cjs', 'tests/runtime.test.cjs']);
});

test('Windows default requires direct launch and functional suites while extended geometry is explicit', () => {
  const required = ['launch', 'smoke', 'storage', 'favicons', 'navigation'];
  assert.deepEqual(selectElectronSuites('win32'), required);
  assert.deepEqual(selectElectronSuites('win32', '0'), required);
  assert.deepEqual(selectElectronSuites('win32', 'true'), required);
  assert.deepEqual(selectElectronSuites('win32', '1'), ['launch', 'smoke', 'popups', 'permissions', 'storage', 'devtools', 'favicons', 'navigation']);
});

test('Linux always requires every Electron suite regardless of the Windows-only setting', () => {
  const all = ['launch', 'smoke', 'popups', 'permissions', 'storage', 'devtools', 'favicons', 'navigation'];
  for (const value of [undefined, '', '0', '1']) assert.deepEqual(selectElectronSuites('linux', value), all);
});

function execute(suites) {
  // Run the real orchestrator and real subprocesses in an isolated Node process.
  // A failed aggregate must become a nonzero process status, not just a log line.
  return spawnSync(process.execPath, ['-e', `
    const { runSuites } = require('./scripts/ci/run-tests.cjs');
    process.exitCode = runSuites(JSON.parse(process.argv[1]), process.env);
  `, JSON.stringify(suites)], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000 });
}

test('CI runs later suites after nonzero exits, timeouts and launch exceptions while preserving failure', () => {
  const result = execute([
    { label: 'nonzero exit', args: ['-e', 'process.exit(7)'], timeout: 5000 },
    { label: 'timed out process', args: ['-e', 'setInterval(() => {}, 1000)'], timeout: 500 },
    { label: 'launch exception', args: 'invalid argument array', timeout: 5000 },
    { label: 'later suite', args: ['-e', 'console.log("LATER_SUITE_EXECUTED")'], timeout: 5000 }
  ]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /LATER_SUITE_EXECUTED/);
  assert.match(result.stderr, /nonzero exit: exit=7/);
  assert.match(result.stderr, /timed out process:.*ETIMEDOUT/);
  assert.match(result.stderr, /FAILED launch exception:/);
  assert.match(result.stderr, /3 required suite\(s\) failed/);
});

test('CI succeeds only when every required suite succeeds', () => {
  const result = execute([
    { label: 'first suite', args: ['-e', 'console.log("FIRST_SUITE_EXECUTED")'], timeout: 5000 },
    { label: 'second suite', args: ['-e', 'console.log("SECOND_SUITE_EXECUTED")'], timeout: 5000 }
  ]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FIRST_SUITE_EXECUTED/);
  assert.match(result.stdout, /SECOND_SUITE_EXECUTED/);
  assert.equal(result.stderr, '');
});
