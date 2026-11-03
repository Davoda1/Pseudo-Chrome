'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { electronEnvironment } = require('./helpers/electron-env.cjs');

test('Electron launch removes empty and mixed-case Node-mode settings without changing its source', () => {
  const source = Object.freeze({
    ELECTRON_RUN_AS_NODE: '', electron_run_as_node: '1', Electron_Run_As_Node: '0',
    NODE_OPTIONS: '', node_options: '--inspect', Node_Options: '--require=unexpected.cjs',
    Path: 'runtime path', PSEUDO_CHROME_PROFILE: 'profile path', PSEUDO_CHROME_TEST: '1',
    APP_EMPTY_SETTING: ''
  });
  const original = { ...source };
  const env = electronEnvironment(source);
  assert.deepEqual(env, {
    Path: 'runtime path', PSEUDO_CHROME_PROFILE: 'profile path', PSEUDO_CHROME_TEST: '1',
    APP_EMPTY_SETTING: ''
  });
  assert.notEqual(env, source);
  assert.deepEqual(source, original);
  assert.equal(Object.hasOwn(env, 'ELECTRON_RUN_AS_NODE'), false);
  assert.equal(Object.hasOwn(env, 'NODE_OPTIONS'), false);
});

test('sanitized launch environment reaches a real child without inherited Node options or Node mode', () => {
  const env = electronEnvironment({
    ...process.env,
    ELECTRON_RUN_AS_NODE: '', electron_run_as_node: '1',
    NODE_OPTIONS: '--pseudo-chrome-invalid-node-option',
    Node_Options: '--pseudo-chrome-another-invalid-node-option',
    PSEUDO_CHROME_ENV_PROBE: 'preserved'
  });
  const child = spawnSync(process.execPath, ['-e', `
    console.log(JSON.stringify({
      forbidden: Object.keys(process.env).filter(name => /^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/i.test(name)),
      probe: process.env.PSEUDO_CHROME_ENV_PROBE
    }));
  `], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { forbidden: [], probe: 'preserved' });
});
