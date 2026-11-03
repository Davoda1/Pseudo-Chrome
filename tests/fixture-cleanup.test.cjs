'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { removeExecutableFixture } = require('./helpers/fixture-cleanup.cjs');

test('fixture removal attempts deletion immediately without an initial delay', async () => {
  const calls = [];
  assert.equal(await removeExecutableFixture('fixture.exe', {
    platform: 'win32', unlink: async file => calls.push(file), wait: async () => assert.fail('unexpected delay')
  }), 0);
  assert.deepEqual(calls, ['fixture.exe']);
});

test('Windows fixture removal retries only transient file-lock errors', async () => {
  const errors = ['EPERM', 'EBUSY'];
  const waits = [];
  let calls = 0;
  assert.equal(await removeExecutableFixture('fixture.exe', {
    platform: 'win32',
    unlink: async () => { const code = errors[calls++]; if (code) throw Object.assign(new Error(code), { code }); },
    wait: async ms => waits.push(ms)
  }), 2);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [50, 50]);
});

test('fixture removal does not retry other errors or non-Windows failures', async () => {
  for (const [platform, code] of [['win32', 'ENOENT'], ['win32', 'EACCES'], ['linux', 'EPERM'], ['darwin', 'EBUSY']]) {
    const error = Object.assign(new Error(code), { code });
    let calls = 0;
    await assert.rejects(removeExecutableFixture('fixture.exe', {
      platform, unlink: async () => { calls++; throw error; }, wait: async () => assert.fail('unexpected retry')
    }), result => result === error);
    assert.equal(calls, 1);
  }
});

test('persistent Windows fixture locks still fail after bounded retries', async () => {
  const error = Object.assign(new Error('locked'), { code: 'EPERM' });
  let calls = 0, elapsed = 0;
  await assert.rejects(removeExecutableFixture('fixture.exe', {
    platform: 'win32', unlink: async () => { calls++; throw error; }, wait: async ms => { elapsed += ms; }
  }), result => result === error);
  assert.equal(calls, 101);
  assert.equal(elapsed, 5000);
});
