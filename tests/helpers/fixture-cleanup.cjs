'use strict';
const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');

// Process-exit assertions must run before this helper. Windows can retain a
// separate file/mapping handle after the process that used a fixture exits.
async function removeExecutableFixture(file, { platform = process.platform, unlink = fs.unlink, wait = delay } = {}) {
  const limit = platform === 'win32' ? 100 : 0;
  for (let retries = 0; ; retries++) {
    try {
      await unlink(file);
      return retries;
    } catch (error) {
      if (retries === limit || !['EPERM', 'EBUSY'].includes(error.code)) throw error;
      await wait(50);
    }
  }
}

module.exports = { removeExecutableFixture };
