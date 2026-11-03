'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { domainToASCII } = require('node:url');
const { TextDecoder } = require('node:util');

const FILENAME = 'config.pseudochrome';
const MAX_BYTES = 16384;

function normalizeDomain(value) {
  if (!value) return '';
  if (/[:/@\\?#\s\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error('SIMULATED_DOMAINNAME must be a hostname without a scheme, port, path, or spaces.');
  const hostname = domainToASCII(value.replace(/\.$/, '')).toLowerCase();
  if (!hostname || hostname.length > 253 || hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('SIMULATED_DOMAINNAME is not a valid hostname.');
  return hostname;
}

function parseDemoConfig(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error(`${FILENAME} must be UTF-8 text of at most ${MAX_BYTES} bytes.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error(`${FILENAME} contains invalid control characters.`);
  const result = { simulatedDomainName: '', port: undefined }, seen = new Set();
  for (const [index, original] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = original.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const fail = message => { throw new Error(`${FILENAME}:${index + 1}: ${message}`); };
    const match = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) fail('Expected KEY=VALUE.');
    const key = match[1]; let value = match[2].trim();
    if (!['SIMULATED_DOMAINNAME', 'PORT'].includes(key)) fail(`Unknown setting ${key}.`);
    if (seen.has(key)) fail(`Duplicate setting ${key}.`);
    seen.add(key);
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) fail('Unclosed quoted value.');
      value = value.slice(1, -1);
      if (value.includes('"') || value.includes("'")) fail('Quoted values cannot contain additional quotes.');
    } else if (value.includes('"') || value.includes("'")) fail('Invalid quoted value.');
    if (key === 'PORT') {
      if (!/^(?:0|[1-9]\d{0,4})$/.test(value) || Number(value) > 65535) fail('PORT must be 0 (automatic) or an integer from 1 to 65535.');
      result.port = Number(value);
    } else {
      try { result.simulatedDomainName = normalizeDomain(value); } catch (error) { fail(error.message); }
    }
  }
  return result;
}

async function loadDemoConfig(www) {
  const filename = path.join(path.resolve(www), FILENAME);
  const invalidFile = () => new Error(`${FILENAME} must be a regular file in www, at most ${MAX_BYTES} bytes.`);
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, path: filename, simulatedDomainName: '', port: undefined };
    if (error.code === 'ELOOP' || error.code === 'EISDIR') throw invalidFile();
    throw new Error(`Cannot read ${FILENAME}: ${error.message}`);
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_BYTES)) throw invalidFile();
    // Windows has no O_NOFOLLOW. Check the opened file's identity as well as
    // the path, then read only through that descriptor even if the path changes.
    const entry = await fs.lstat(filename, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink()) throw invalidFile();
    if (entry.dev !== stat.dev || entry.ino !== stat.ino) throw new Error(`${FILENAME} changed while opening it. Try again.`);
    // Do not allocate based on a mutable file size or read an unbounded file.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error(`${FILENAME} exceeds ${MAX_BYTES} bytes.`);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); } catch { throw new Error(`${FILENAME} must contain valid UTF-8 text.`); }
    return { present: true, path: filename, ...parseDemoConfig(text) };
  } finally {
    await handle.close();
  }
}

module.exports = { FILENAME, MAX_BYTES, normalizeDomain, parseDemoConfig, loadDemoConfig };
