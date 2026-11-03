'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { phpIniValue } = require('../app/lib/php-settings.cjs');

test('bundled PHP preserves quoted path settings, including Windows short names and INI metacharacters', { skip: !process.env.PSEUDO_TEST_PHP }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pseudo-php~ini-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'probe.php');
  await fs.writeFile(script, '<?php echo json_encode(ini_get("session.save_path"), JSON_THROW_ON_ERROR);');
  // Values are parsed, not opened, so both Windows and POSIX paths are checked
  // on every platform. Quotes/backslashes are legal filename bytes on POSIX.
  const values = [
    String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\config\php-temp\sessions`,
    String.raw`C:\Demo sites\a; b & c! (preview)\O'Brien\sessions`,
    'C:\\Demo\\${PSEUDO_INI_VALUE_PROBE}\\$literal\\sessions',
    String.raw`C:\Demo\backslash\n\t` + '\\',
    '/tmp/path "with quotes" and \\backslash & ~ ; (parentheses)',
    '/tmp/${PSEUDO_INI_VALUE_PROBE}/literal $value'
  ];
  for (const value of values) {
    const result = spawnSync(process.env.PSEUDO_TEST_PHP,
      ['-n', '-d', 'session.save_path=' + phpIniValue(value), '-f', script],
      { encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, PSEUDO_INI_VALUE_PROBE: 'must-not-expand' } });
    const diagnostic = `Path: ${JSON.stringify(value)}\nPHP stdout: ${result.stdout}\nPHP stderr: ${result.stderr}`;
    assert.ifError(result.error);
    assert.equal(result.status, 0, diagnostic);
    assert.equal(result.stderr, '', diagnostic);
    let parsed;
    try { parsed = JSON.parse(result.stdout); }
    catch (error) { throw new Error('PHP path probe returned invalid JSON.\n' + diagnostic, { cause: error }); }
    assert.equal(parsed, value, diagnostic);
  }
});
