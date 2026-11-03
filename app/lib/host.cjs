'use strict';

// A single trusted website, with a private document-root gateway and optional
// nginx front end. Website processes run as the current user, not in a sandbox.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { timingSafeEqual } = require('node:crypto');
const { spawn } = require('node:child_process');
const { phpIniValue } = require('./php-settings.cjs');

const LOOPBACK = '127.0.0.1';
const ACCESS_HEADER = 'x-pseudo-chrome-access';
const DEFAULT_CONFIG = Object.freeze({ mode: 'auto', documentRoot: '.', entry: '', args: [], env: {}, npmScript: '', spa: false, port: 0, backendPort: 0, startupTimeoutMs: 30000 });
const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.zip': 'application/zip' };
const PRIVATE_NAMES = /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.(?:json|lock)|cargo\.(?:toml|lock)|cmakelists\.txt|dockerfile|site\.json|config\.pseudochrome|pseudo-chrome(?:\.site)?\.json|php\.ini|nginx\.conf|web\.config)$/i;
const SOURCE_EXTENSIONS = /\.(?:php\d*|phtml|phar|cgi|fcgi|pl|py|rb|rs|cpp|cc|c|h|hpp|go|java|class|cs|vb|sql|sqlite\d*|db|pem|key|pfx|p12|env|ini|conf|bak|log|sh|bat|cmd|ps1|exe|dll|so|dylib)$/i;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
// All built-in upstream modules register their temp paths even when unused.
// The Windows nginx distribution defaults to temp/fastcgi_temp, etc., whose
// parent does not exist in a new application profile. nginx only mkdirs the
// final component. Keep every path explicit and create it before launching.
const NGINX_TEMP_PATHS = Object.freeze({ client_body: 'nginx-body', proxy: 'nginx-proxy', fastcgi: 'nginx-fastcgi', uwsgi: 'nginx-uwsgi', scgi: 'nginx-scgi' });

async function readNewLog(filename, start = 0) {
  let handle;
  try {
    // A diagnostic read must never follow a substituted link or create a file.
    // NONBLOCK also lets us reject a FIFO without waiting for a writer.
    handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), 0o600);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) return '';
    const entry = await fsp.lstat(filename);
    if (!entry.isFile() || entry.nlink !== 1 || info.dev !== entry.dev || info.ino !== entry.ino) return '';
    const { size } = info;
    // A replaced/truncated log belongs to this launch too. Bound disk reads.
    const offset = Math.max(size < start ? 0 : start, size - 16384);
    const bytes = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
    return bytes.subarray(0, bytesRead).toString('utf8').trim();
  } catch { return ''; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

async function writePrivateConfig(filename, content) {
  // Exclusive creation inside a private random directory, followed by rename,
  // replaces an old config atomically without opening any existing link target.
  const directory = await fsp.mkdtemp(path.join(path.dirname(filename), '.pseudo-config-'));
  const staged = path.join(directory, 'nginx.conf');
  try {
    await fsp.writeFile(staged, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fsp.rename(staged, filename);
  } finally { await fsp.rm(directory, { recursive: true, force: true }); }
}

async function preparePrivateLog(filename) {
  let handle;
  try {
    try { handle = await fsp.open(filename, 'ax', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), 0o600);
    }
    // Validate the descriptor before changing permissions. On Windows, where
    // O_NOFOLLOW is unavailable, also compare it to the current directory entry.
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1) throw new Error('The hosting log must be a regular file, not a link.');
    const entry = await fsp.lstat(filename);
    if (!entry.isFile() || entry.nlink !== 1) throw new Error('The hosting log must be a regular file, not a link.');
    if (current.dev !== entry.dev || current.ino !== entry.ino) throw new Error('The hosting log changed while opening it.');
    if (process.platform !== 'win32') await handle.chmod(0o600);
    return (await handle.stat()).size;
  } finally { if (handle) await handle.close(); }
}

function validateConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Site configuration must be a JSON object.');
  const c = { ...DEFAULT_CONFIG, ...value };
  if (!['auto', 'static', 'node', 'php', 'native'].includes(c.mode)) throw new Error('Hosting mode must be auto, static, node, php or native.');
  for (const key of ['documentRoot', 'entry', 'npmScript']) if (typeof c[key] !== 'string' || c[key].includes('\0')) throw new Error(`${key} must be a text value.`);
  if (path.isAbsolute(c.documentRoot) || /^[a-z]:/i.test(c.documentRoot)) throw new Error('Document root must be a relative path inside www.');
  if (!Array.isArray(c.args) || c.args.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('Arguments must be a JSON array of strings.');
  if (!c.env || typeof c.env !== 'object' || Array.isArray(c.env) || Object.entries(c.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0'))) throw new Error('Environment must be an object of variable names and string values.');
  if (Object.keys(c.env).some(k => /^ELECTRON_/i.test(k) || k === 'NODE_OPTIONS')) throw new Error('Electron control variables and NODE_OPTIONS cannot be set in website configuration.');
  for (const k of ['port', 'backendPort']) if (!Number.isInteger(c[k]) || c[k] < 0 || c[k] > 65535) throw new Error(`${k} must be 0 (automatic) or a port from 1 to 65535.`);
  if (c.port && c.backendPort && c.port === c.backendPort) throw new Error('The public port and backend port must be different.');
  if (!Number.isInteger(c.startupTimeoutMs) || c.startupTimeoutMs < 1000 || c.startupTimeoutMs > 180000) throw new Error('Startup timeout must be between 1000 and 180000 milliseconds.');
  c.spa = Boolean(c.spa);
  return c;
}

async function existingFile(filename) { try { return (await fsp.stat(filename)).isFile(); } catch { return false; } }
async function availablePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(preferred, LOOPBACK, () => { const port = s.address().port; s.close(err => err ? reject(err) : resolve(port)); });
  });
}
async function resolveDocumentRoot(www, relative) {
  const root = await fsp.realpath(www);
  const resolved = await fsp.realpath(path.resolve(root, relative)).catch(() => { throw new Error(`Document root does not exist: ${relative}`); });
  if (!within(root, resolved) || !(await fsp.stat(resolved)).isDirectory()) throw new Error('Document root must be a directory inside www; links outside www are not allowed.');
  return resolved;
}

function requestPath(rawUrl) {
  const raw = (rawUrl || '/').split('?', 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { throw Object.assign(new Error('Malformed request path.'), { statusCode: 400 }); }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\x00-\x1f\x7f:]/.test(decoded)) throw Object.assign(new Error('Invalid request path.'), { statusCode: 400 });
  const segments = decoded.split('/');
  if (segments.some(p => p === '..' || p === '.' || p.startsWith('.') || PRIVATE_NAMES.test(p.replace(/[. ]+$/, '')) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw Object.assign(new Error('This path is not public website content.'), { statusCode: 403 });
  return decoded;
}
async function publicFile(root, pathname) {
  const candidate = path.resolve(root, '.' + pathname);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw Object.assign(new Error('Path outside website root.'), { statusCode: 403 });
  let real;
  try { real = await fsp.realpath(candidate); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
  const realRelative = path.relative(root, real);
  if (realRelative.startsWith('..' + path.sep) || realRelative === '..' || path.isAbsolute(realRelative)) throw Object.assign(new Error('Links outside the website root are not public.'), { statusCode: 403 });
  requestPath('/' + path.relative(root, real).split(path.sep).map(encodeURIComponent).join('/'));
  return { path: real, stat: await fsp.stat(real) };
}
function errorResponse(res, code, message) {
  if (res.headersSent) { res.destroy(); return; }
  const body = `${code} ${message}\n`;
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function sendStatic(req, res, file) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); errorResponse(res, 405, 'Method not allowed'); return; }
  if (SOURCE_EXTENSIONS.test(file.path)) { errorResponse(res, 403, 'Backend source and private data are not served as files'); return; }
  const size = file.stat.size;
  const etag = `W/"${size.toString(16)}-${Math.trunc(file.stat.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': MIME[path.extname(file.path).toLowerCase()] || 'application/octet-stream', 'Last-Modified': file.stat.mtime.toUTCString(), ETag: etag, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  if (req.headers['if-none-match'] === etag || (!req.headers['if-none-match'] && req.headers['if-modified-since'] && Date.parse(req.headers['if-modified-since']) >= Math.floor(file.stat.mtimeMs / 1000) * 1000)) { res.writeHead(304, headers); res.end(); return; }
  let start = 0, end = size - 1, code = 200;
  if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === headers['Last-Modified'])) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2]) || size === 0) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); res.end(); return; }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else start = Number(match[1]);
    if (match[1] && match[2]) end = Math.min(size - 1, Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); res.end(); return; }
    code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(code, headers);
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  const stream = fs.createReadStream(file.path, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}

function fcgiRecord(type, data = Buffer.alloc(0)) {
  const h = Buffer.alloc(8); h[0] = 1; h[1] = type; h.writeUInt16BE(1, 2); h.writeUInt16BE(data.length, 4);
  return Buffer.concat([h, data]);
}
function fcgiLength(n) { if (n < 128) return Buffer.from([n]); const b = Buffer.alloc(4); b.writeUInt32BE((n | 0x80000000) >>> 0); return b; }
function fcgiParams(entries) {
  const chunks = [];
  for (const [key, value] of Object.entries(entries)) { const k = Buffer.from(key), v = Buffer.from(String(value)); chunks.push(fcgiLength(k.length), fcgiLength(v.length), k, v); }
  return Buffer.concat(chunks);
}
function writeFcgiChunks(socket, type, bytes) { for (let pos = 0; pos < bytes.length; pos += 65535) socket.write(fcgiRecord(type, bytes.subarray(pos, pos + 65535))); }

async function servePhp(req, res, script, documentRoot, phpPort, publicPort, log) {
  let buffered = null;
  if (!req.headers['content-length'] && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const body = []; let size = 0;
    for await (const data of req) { size += data.length; if (size > 16 * 1024 * 1024) { errorResponse(res, 413, 'Chunked PHP request body exceeds 16 MiB; send Content-Length for larger uploads'); return; } body.push(data); }
    buffered = Buffer.concat(body);
  }
  const scriptName = '/' + path.relative(documentRoot, script.path).split(path.sep).join('/');
  const params = { GATEWAY_INTERFACE: 'CGI/1.1', SERVER_SOFTWARE: 'Pseudo-Chrome', SERVER_PROTOCOL: req.httpVersion === '1.0' ? 'HTTP/1.0' : 'HTTP/1.1', REQUEST_METHOD: req.method, REQUEST_URI: req.url, QUERY_STRING: req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '', SCRIPT_FILENAME: script.path, SCRIPT_NAME: scriptName, DOCUMENT_ROOT: documentRoot, SERVER_NAME: LOOPBACK, SERVER_ADDR: LOOPBACK, SERVER_PORT: publicPort, REMOTE_ADDR: LOOPBACK, REMOTE_PORT: req.socket.remotePort || '', REDIRECT_STATUS: '200', CONTENT_TYPE: req.headers['content-type'] || '', CONTENT_LENGTH: buffered ? buffered.length : req.headers['content-length'] || '0' };
  const pathname = requestPath(req.url);
  if (pathname.startsWith(scriptName + '/')) params.PATH_INFO = pathname.slice(scriptName.length);
  for (const [key, value] of Object.entries(req.headers)) if (value !== undefined && !['content-type', 'content-length', 'proxy', ACCESS_HEADER].includes(key) && !HOP_HEADERS.has(key)) params['HTTP_' + key.toUpperCase().replace(/-/g, '_')] = Array.isArray(value) ? value.join(', ') : value;
  const socket = net.createConnection({ host: LOOPBACK, port: phpPort });
  socket.setTimeout(120000);
  let pending = Buffer.alloc(0), headerBytes = Buffer.alloc(0), parsedHeaders = false, finished = false;
  const fail = message => { if (!finished) { finished = true; socket.destroy(); errorResponse(res, 502, message); } };
  socket.on('error', e => fail('PHP backend connection failed: ' + e.message)); socket.on('timeout', () => fail('PHP request timed out'));
  req.on('aborted', () => socket.destroy()); res.on('close', () => { if (!res.writableEnded) socket.destroy(); });
  socket.on('connect', () => {
    socket.write(fcgiRecord(1, Buffer.from([0, 1, 0, 0, 0, 0, 0, 0])));
    writeFcgiChunks(socket, 4, fcgiParams(params)); socket.write(fcgiRecord(4));
    if (buffered) { writeFcgiChunks(socket, 5, buffered); socket.write(fcgiRecord(5)); }
    else if (req.readableEnded || ['GET', 'HEAD'].includes(req.method) && !req.headers['content-length']) socket.write(fcgiRecord(5));
    else { req.on('data', chunk => { writeFcgiChunks(socket, 5, chunk); if (socket.writableLength > 1024 * 1024) req.pause(); }); socket.on('drain', () => req.resume()); req.on('end', () => socket.write(fcgiRecord(5))); req.on('error', () => socket.destroy()); }
  });
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      const type = pending[1], len = pending.readUInt16BE(4), total = 8 + len + pending[6];
      if (pending.length < total) break;
      const content = pending.subarray(8, 8 + len); pending = pending.subarray(total);
      if (type === 6 && content.length) {
        let body = content;
        if (!parsedHeaders) {
          headerBytes = Buffer.concat([headerBytes, content]);
          let idx = headerBytes.indexOf('\r\n\r\n'), separator = 4;
          if (idx === -1) { idx = headerBytes.indexOf('\n\n'); separator = 2; }
          if (idx === -1) { if (headerBytes.length > 65536) fail('PHP returned oversized response headers'); continue; }
          const headers = {}; let status = 200, explicitStatus = false;
          for (const line of headerBytes.subarray(0, idx).toString('latin1').split(/\r?\n/)) {
            const colon = line.indexOf(':'); if (colon < 1) continue;
            const key = line.slice(0, colon).trim(), value = line.slice(colon + 1).trim();
            if (key.toLowerCase() === 'status') { const n = parseInt(value, 10); if (n >= 100 && n <= 599) { status = n; explicitStatus = true; } }
            else if (!HOP_HEADERS.has(key.toLowerCase())) { if (key.toLowerCase() === 'set-cookie') { headers[key] = [...(headers[key] || []), value]; } else headers[key] = value; }
          }
          if (!explicitStatus && Object.keys(headers).some(k => k.toLowerCase() === 'location')) status = 302;
          try { res.writeHead(status, headers); } catch { fail('PHP returned invalid response headers'); return; }
          body = headerBytes.subarray(idx + separator); parsedHeaders = true; headerBytes = Buffer.alloc(0);
        }
        if (body.length && req.method !== 'HEAD' && !res.write(body)) { socket.pause(); res.once('drain', () => socket.resume()); }
      } else if (type === 7 && content.length) log('[PHP] ' + content.toString('utf8'));
      else if (type === 3) {
        if (!parsedHeaders) { fail('PHP ended without a valid response'); return; }
        finished = true; res.end(); socket.end();
      }
    }
  });
  socket.on('end', () => { if (!finished) fail('PHP response ended unexpectedly'); });
}

function proxyHttp(req, res, port) {
  const headers = { ...req.headers, 'x-forwarded-for': LOOPBACK, 'x-forwarded-proto': 'http', 'x-forwarded-host': req.headers.host || '' };
  delete headers['proxy-connection'];
  delete headers[ACCESS_HEADER];
  const upstream = http.request({ hostname: LOOPBACK, port, method: req.method, path: req.url, headers, timeout: 120000 }, response => {
    res.writeHead(response.statusCode || 502, response.headers); response.pipe(res); response.on('error', () => res.destroy());
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Backend request timed out')));
  upstream.on('error', e => errorResponse(res, 502, 'Website backend unavailable: ' + e.message));
  req.on('aborted', () => upstream.destroy()); res.on('close', () => { if (!res.writableEnded) upstream.destroy(); }); req.pipe(upstream);
}
function proxyUpgrade(req, socket, head, port) {
  try { requestPath(req.url); } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  const upstream = net.createConnection({ host: LOOPBACK, port });
  upstream.on('connect', () => {
    let headers = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() !== ACCESS_HEADER) headers += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(headers + '\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
}

class SiteHost extends EventEmitter {
  constructor({ www, configDir, runtimes = {}, accessPolicy }) {
    super(); this.www = path.resolve(www); this.configDir = path.resolve(configDir); this.runtimes = runtimes;
    this.logs = []; this.children = []; this.connections = new Set(); this.gateway = null; this._token = 0; this._stopping = false; this._starting = false; this._startPromise = null; this._cleanupPromise = null;
    this.status = { state: 'stopped', status: 'stopped', mode: '', url: '', error: '', engine: '' };
    // The desktop app supplies a per-launch capability. Keeping the low-level
    // host permissive by default preserves its direct test/development API.
    this._accessPolicy = { allowExternalPrograms: true, token: '' };
    this._appConnections = new WeakSet();
    if (accessPolicy) this.setAccessPolicy(accessPolicy);
  }
  setAccessPolicy({ allowExternalPrograms, token = this._accessPolicy.token } = {}) {
    if (typeof allowExternalPrograms !== 'boolean' || typeof token !== 'string'
      || (token !== '' && !/^[A-Za-z0-9_-]{32,256}$/.test(token)) || (!allowExternalPrograms && !token)) throw new Error('Invalid local website access policy.');
    const tokenChanged = token !== this._accessPolicy.token;
    const restrict = !allowExternalPrograms && (this._accessPolicy.allowExternalPrograms || tokenChanged);
    this._accessPolicy = { allowExternalPrograms, token };
    if (tokenChanged) this._appConnections = new WeakSet();
    // Already-open external streams must not outlive a switch to app-only
    // access. Authenticated in-app streams keep running on a normal toggle.
    // Rotating the capability clears that classification and closes all.
    if (restrict) for (const socket of this.connections) if (!this._appConnections.has(socket)) socket.destroy();
  }
  _authorizedRequest(req) {
    const supplied = req.headers[ACCESS_HEADER];
    const expected = Buffer.from(this._accessPolicy.token);
    const candidate = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
    const authenticated = expected.length > 0 && candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (authenticated) this._appConnections.add(req.socket); else this._appConnections.delete(req.socket);
    return this._accessPolicy.allowExternalPrograms || authenticated;
  }
  _log(message) {
    for (const line of String(message).split(/\r?\n/).filter(Boolean)) {
      const text = `[${new Date().toISOString()}] ${line.slice(0, 3000)}`; this.logs.push(text); if (this.logs.length > 500) this.logs.shift(); this.emit('log', text);
    }
  }
  _set(fields) { this.status = { ...this.status, ...fields }; this.status.status = this.status.state; this.emit('status', { ...this.status }); }
  _spawn(label, executable, args, options = {}) {
    this._check(this._activeToken);
    const supervised = process.platform === 'win32' && this.runtimes.processRunner;
    const child = spawn(supervised || executable, supervised ? [executable, ...args] : args, { cwd: this.www, windowsHide: true, detached: process.platform !== 'win32', stdio: [supervised ? 'pipe' : 'ignore', 'pipe', 'pipe'], ...options });
    const record = { child, label, exited: false, closed: false, supervised: Boolean(supervised), stderr: '' };
    record.closePromise = new Promise(resolve => child.once('close', () => { record.closed = true; resolve(); }));
    this.children.push(record);
    // A backend may finish before its stop request. Consume a late EPIPE; the
    // supervisor close event still determines whether shutdown completed.
    if (supervised) child.stdin.on('error', () => {});
    child.stdout.on('data', d => this._log(`[${label}] ${d.toString('utf8')}`));
    child.stderr.on('data', d => { record.stderr = (record.stderr + d.toString('utf8')).slice(-16384); this._log(`[${label}] ${d.toString('utf8')}`); });
    child.on('error', e => { record.error = `${label} could not start: ${e.message}`; this._log(record.error); });
    child.on('exit', (code, signal) => {
      record.shutdownIncomplete = supervised && code === 0x50534346;
      record.exited = true; record.error = `${label} exited (${signal || code}).`;
      if (!this._stopping) { this._log(record.error); if (!this._starting && this.status.state === 'ready') { this._set({ state: 'error', error: this._failureMessage(record) }); void this._cleanup().catch(error => this._log(error.message)); } }
    });
    return record;
  }
  _failureMessage(record) {
    if (record.label !== 'nginx') return `${record.error} Check the website entry, dependencies and hosting logs.`;
    const detail = record.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-4).join('\n').slice(-4000);
    return `${record.error}${detail ? '\n' + detail : ''}\nnginx could not serve the local website. See hosting logs and ${path.join(this.configDir, 'nginx-error.log')}.`;
  }
  _check(token) {
    if (token !== this._token) throw new Error('Website startup was cancelled.');
    const failed = this.children.find(r => r.error || r.exited);
    if (failed) throw new Error(this._failureMessage(failed));
  }
  async _waitPort(port, token, timeout, httpReady = false) {
    // Readiness can use only a numeric loopback port. Config file bytes never
    // become a request host, path, header or body.
    const localPort = Number(port);
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('Invalid local readiness port.');
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      this._check(token);
      const ready = await new Promise(resolve => {
        if (httpReady) {
          const req = http.get({ host: LOOPBACK, port: localPort, path: '/', timeout: 600 }, r => { r.resume(); req.destroy(); resolve(true); });
          req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
        } else {
          const sock = net.createConnection({ host: LOOPBACK, port: localPort }); sock.setTimeout(400);
          sock.once('connect', () => { sock.destroy(); resolve(true); }); sock.once('error', () => resolve(false)); sock.once('timeout', () => { sock.destroy(); resolve(false); });
        }
      });
      if (ready) { this._check(token); return; }
      await sleep(100);
    }
    throw new Error(`Website did not become ready within ${Math.round(timeout / 1000)} seconds. It must listen on HOST=127.0.0.1 and PORT=${port}. Check hosting logs and startup settings.`);
  }
  start(value = {}) {
    if (this._startPromise) return Promise.reject(new Error('Website startup is already in progress.'));
    const token = ++this._token; this._activeToken = token; this._starting = true;
    this._startPromise = this._start(value, token).finally(() => { this._startPromise = null; this._starting = false; });
    return this._startPromise;
  }
  async _start(value, token) {
    try {
      await this._cleanup(); this._check(token);
      this._set({ state: 'starting', error: '', url: '', mode: '', engine: this.runtimes.nginx ? 'nginx' : 'built-in' });
      const cfg = validateConfig(value); this.config = cfg;
      await fsp.mkdir(this.www, { recursive: true }); await fsp.mkdir(this.configDir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await fsp.chmod(this.configDir, 0o700);
      let root = await resolveDocumentRoot(this.www, cfg.documentRoot);
      let mode = cfg.mode; let pkg = null;
      const pkgPath = path.join(this.www, 'package.json');
      if (await existingFile(pkgPath)) { try { pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8')); } catch { throw new Error('www/package.json is not valid JSON.'); } }
      if (mode === 'auto') {
        if (cfg.entry) mode = /\.php$/i.test(cfg.entry) ? 'php' : /\.[cm]?js$/i.test(cfg.entry) ? 'node' : 'native';
        else if (await existingFile(path.join(root, 'index.html'))) mode = 'static';
        else if (await existingFile(path.join(root, 'index.php'))) mode = 'php';
        else if (cfg.documentRoot === '.' && await existingFile(path.join(root, 'public', 'index.php'))) { root = await resolveDocumentRoot(this.www, 'public'); mode = 'php'; }
        else if (cfg.documentRoot === '.' && await existingFile(path.join(root, 'dist', 'index.html'))) { root = await resolveDocumentRoot(this.www, 'dist'); mode = 'static'; }
        else if (cfg.documentRoot === '.' && await existingFile(path.join(root, 'build', 'index.html'))) { root = await resolveDocumentRoot(this.www, 'build'); mode = 'static'; }
        else if (pkg?.scripts?.start || pkg?.main || await existingFile(path.join(this.www, 'server.js'))) mode = 'node';
        else mode = 'static';
      }
      this.documentRoot = root; this.mode = mode;
      this._set({ mode, documentRoot: root }); this._log(`Starting ${mode} website in ${root}`);
      const publicPort = this.runtimes.nginx ? await availablePort(cfg.port) : cfg.port;
      let backendPort = 0;
      if (mode === 'node' || mode === 'native' || mode === 'php') {
        backendPort = await availablePort(cfg.backendPort);
        if (backendPort === publicPort) backendPort = await availablePort(0);
        let env = { ...process.env, ...cfg.env, HOST: LOOPBACK, HOSTNAME: LOOPBACK, BIND_HOST: LOOPBACK, PORT: String(backendPort), NODE_ENV: cfg.env.NODE_ENV || 'production' };
        delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE; delete env.NODE_OPTIONS;
        if (this.runtimes.node) env.PATH = path.dirname(this.runtimes.node) + path.delimiter + (env.PATH || '');
        if (mode === 'php') {
          if (!this.runtimes.php || !await existingFile(this.runtimes.php)) throw new Error('The PHP-CGI runtime is unavailable. Install the complete Pseudo-Chrome package or configure its runtime.');
          const dir = path.dirname(this.runtimes.php);
          env.PHP_FCGI_MAX_REQUESTS = '0'; env.PHP_FCGI_CHILDREN = '0';
          const temp = path.join(this.configDir, 'php-temp'), sessions = path.join(temp, 'sessions');
          await fsp.mkdir(sessions, { recursive: true });
          const args = ['-c', path.join(dir, 'php.ini'), '-d', `extension_dir=${phpIniValue(path.join(dir, 'ext'))}`, '-d', `curl.cainfo=${phpIniValue(path.join(dir, 'cacert.pem'))}`, '-d', `openssl.cafile=${phpIniValue(path.join(dir, 'cacert.pem'))}`, '-d', `session.save_path=${phpIniValue(sessions)}`, '-d', `upload_tmp_dir=${phpIniValue(temp)}`, '-d', `sys_temp_dir=${phpIniValue(temp)}`, '-d', 'cgi.fix_pathinfo=0', '-d', 'cgi.force_redirect=0', '-b', `${LOOPBACK}:${backendPort}`];
          this._spawn('PHP', this.runtimes.php, args, { env, cwd: root });
        } else if (mode === 'node') {
          if (!this.runtimes.node || !await existingFile(this.runtimes.node)) throw new Error('The bundled Node.js runtime is unavailable. Re-extract the complete Pseudo-Chrome package.');
          const script = cfg.npmScript || (!cfg.entry && pkg?.scripts?.start ? 'start' : '');
          if (script && !cfg.entry) {
            if (!pkg?.scripts || typeof pkg.scripts[script] !== 'string') throw new Error(`package.json does not define the npm script "${script}".`);
            if (!this.runtimes.npmCli || !await existingFile(this.runtimes.npmCli)) throw new Error('npm is unavailable. Set an explicit Node entry file or restore the bundled npm runtime.');
            this._spawn('Node', this.runtimes.node, [this.runtimes.npmCli, 'run', script, '--', ...cfg.args], { env });
          } else {
            const entry = cfg.entry || pkg?.main || 'server.js';
            const actual = await this._entry(entry); this._spawn('Node', this.runtimes.node, [actual, ...cfg.args], { env });
          }
        } else {
          if (!cfg.entry) throw new Error('Native hosting requires an entry: the path to an already compiled Windows/Linux server executable inside www.');
          const actual = await this._entry(cfg.entry); this._spawn('Native backend', actual, cfg.args, { env });
        }
        await this._waitPort(backendPort, token, cfg.startupTimeoutMs, mode !== 'php');
        // Catch the common accidental 0.0.0.0/:: binding. The reverse proxy is
        // private, and a custom backend must also honor its loopback setting.
        const wildcard = await new Promise(resolve => {
          const socket = net.createConnection({ host: '127.0.0.2', port: backendPort }); socket.setTimeout(250);
          socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); });
        });
        if (wildcard) throw new Error(`The website backend is listening on all interfaces. Configure its start command to bind specifically to 127.0.0.1 (HOST), rather than 0.0.0.0 or ::.`);
      }
      this.backendPort = backendPort;
      this.phpEntry = '';
      if (mode === 'php' && cfg.entry) {
        this.phpEntry = await this._entry(cfg.entry);
        if (!within(root, this.phpEntry) || !/\.php$/i.test(this.phpEntry)) throw new Error('PHP entry must be a .php file within the selected document root.');
      }
      this._check(token);
      this.gateway = http.createServer((req, res) => { void this._request(req, res).catch(e => { this._log(e.message); errorResponse(res, e.statusCode || 500, e.statusCode ? e.message : 'Website request failed'); }); });
      this.gateway.headersTimeout = 30000; this.gateway.requestTimeout = 120000;
      this.gateway.on('connection', s => { this.connections.add(s); s.on('close', () => this.connections.delete(s)); });
      this.gateway.on('clientError', (_e, s) => { if (s.writable) s.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
      this.gateway.on('upgrade', (req, socket, head) => { if (!this._localRequest(req, true)) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); else if (mode === 'node' || mode === 'native') proxyUpgrade(req, socket, head, backendPort); else socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
      await new Promise((resolve, reject) => { this.gateway.once('error', reject); this.gateway.listen(this.runtimes.nginx ? 0 : cfg.port, LOOPBACK, resolve); });
      this._check(token); const gatewayPort = this.gateway.address().port;
      this.publicPort = this.runtimes.nginx ? publicPort : gatewayPort;
      if (this.runtimes.nginx) {
        if (!await existingFile(this.runtimes.nginx)) throw new Error('The bundled nginx executable is missing. Re-extract the complete package.');
        const rootUser = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0 ? 'user root;\n' : '';
        const tempPaths = Object.entries(NGINX_TEMP_PATHS).map(([module, directory]) => ` ${module}_temp_path ${directory};`).join('\n');
        // Relative ASCII paths avoid passing profile names through nginx's
        // narrow Windows argv. cwd is set through Node/CreateProcessW.
        const conf = `${rootUser}worker_processes 1;\nmaster_process off;\npid nginx.pid;\nerror_log nginx-error.log warn;\nerror_log stderr warn;\nevents { worker_connections 512; }\nhttp {\n access_log off;\n${tempPaths}\n map $http_upgrade $connection_upgrade { default upgrade; '' close; }\n server {\n  listen 127.0.0.1:${publicPort};\n  server_name localhost;\n  client_max_body_size 256m;\n  location / {\n   proxy_pass http://127.0.0.1:${gatewayPort};\n   proxy_http_version 1.1;\n   proxy_set_header Host $http_host;\n   proxy_set_header Upgrade $http_upgrade;\n   proxy_set_header Connection $connection_upgrade;\n   proxy_set_header X-Forwarded-For 127.0.0.1;\n   proxy_set_header X-Forwarded-Proto http;\n   proxy_buffering off;\n   proxy_request_buffering off;\n   proxy_read_timeout 120s;\n  }\n }\n}\n`;
        for (const directory of Object.values(NGINX_TEMP_PATHS)) await fsp.mkdir(path.join(this.configDir, directory), { recursive: true });
        const confPath = path.join(this.configDir, 'nginx.conf'); await writePrivateConfig(confPath, conf);
        const logPath = path.join(this.configDir, 'nginx-error.log');
        const logStart = await preparePrivateLog(logPath);
        const nginx = this._spawn('nginx', this.runtimes.nginx, ['-p', './', '-c', 'nginx.conf', '-e', 'stderr', '-g', 'daemon off;'], { cwd: this.configDir });
        try { await this._waitPort(publicPort, token, 10000, true); }
        catch (error) {
          if (token !== this._token) throw error;
          const freshLog = await readNewLog(logPath, logStart);
          if (freshLog) { this._log('[nginx log] ' + freshLog); nginx.stderr = (nginx.stderr + '\n' + freshLog).slice(-16384); }
          if (!nginx.error) nginx.error = error.message;
          throw new Error(this._failureMessage(nginx));
        }
      }
      this._check(token); const url = `http://${LOOPBACK}:${this.publicPort}`;
      this._starting = false; this._set({ state: 'ready', url, error: '', pid: this.children.find(r => r.label !== 'nginx')?.child.pid || null }); this._log(`Website ready at ${url}`);
      return { ...this.status };
    } catch (e) {
      this._starting = false; this._log(e.message); await this._cleanup();
      if (token !== this._token) { e.code = 'ABORT_ERR'; this._set({ state: 'stopped', error: '', url: '' }); }
      else this._set({ state: 'error', error: e.message, url: '' });
      throw e;
    }
  }
  async _entry(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || /^[a-z]:/i.test(relative)) throw new Error('Website entry must be a relative path inside www.');
    const root = await fsp.realpath(this.www), candidate = await fsp.realpath(path.resolve(root, relative)).catch(() => { throw new Error(`Website entry was not found: ${relative}`); });
    if (!within(root, candidate) || !(await fsp.stat(candidate)).isFile()) throw new Error('Website entry must be a file inside www.');
    return candidate;
  }
  async _request(req, res) {
    const pathname = requestPath(req.url);
    // Reject hostile Host headers as well as internet-facing bindings. Website
    // resources may still make outgoing requests normally.
    if (!this._localRequest(req, !['GET', 'HEAD', 'OPTIONS'].includes(req.method))) { errorResponse(res, 403, 'This server accepts local website requests only'); return; }
    if (this.mode === 'node' || this.mode === 'native') { proxyHttp(req, res, this.backendPort); return; }
    let file = await publicFile(this.documentRoot, pathname);
    if (file?.stat.isDirectory()) {
      if (!pathname.endsWith('/')) {
        // Encode decoded filename characters before using them as URL syntax.
        // Verify the final URL against the app's actual loopback origin so a
        // directory request can never redirect to an external authority.
        const origin = `http://${LOOPBACK}:${this.publicPort}`;
        const target = new URL(pathname.split('/').map(encodeURIComponent).join('/') + '/', origin);
        if (req.url.includes('?')) target.search = req.url.slice(req.url.indexOf('?'));
        if (target.origin !== origin) throw Object.assign(new Error('Invalid directory redirect.'), { statusCode: 400 });
        res.writeHead(301, { Location: target.href }); res.end(); return;
      }
      file = null;
      for (const name of this.mode === 'php' ? ['index.php', 'index.html', 'index.htm'] : ['index.html', 'index.htm']) {
        const candidate = await publicFile(this.documentRoot, pathname + name); if (candidate?.stat.isFile()) { file = candidate; break; }
      }
    }
    if (!file && this.mode === 'php') {
      const info = /^(.*?\.php)\/.*$/i.exec(pathname);
      if (info) { const candidate = await publicFile(this.documentRoot, info[1]); if (candidate?.stat.isFile()) file = candidate; }
    }
    if (!file && this.mode === 'php') file = await publicFile(this.documentRoot, this.phpEntry ? '/' + path.relative(this.documentRoot, this.phpEntry).split(path.sep).join('/') : '/index.php');
    if (!file && this.mode === 'static' && this.config.spa && !path.posix.extname(pathname)) file = await publicFile(this.documentRoot, '/index.html');
    if (!file?.stat.isFile()) { errorResponse(res, 404, 'Not found'); return; }
    if (this.mode === 'php' && /\.php$/i.test(file.path)) { await servePhp(req, res, file, this.documentRoot, this.backendPort, this.publicPort, m => this._log(m)); return; }
    sendStatic(req, res, file);
  }
  _localRequest(req, checkOrigin) {
    if (!this._authorizedRequest(req)) return false;
    const hostname = String(req.headers.host || '').split(':')[0].toLowerCase();
    if (![LOOPBACK, 'localhost'].includes(hostname)) return false;
    if (checkOrigin && req.headers.origin && ![`http://${LOOPBACK}:${this.publicPort}`, `http://localhost:${this.publicPort}`].includes(req.headers.origin)) return false;
    return true;
  }
  async _cleanup() {
    if (this._cleanupPromise) return this._cleanupPromise;
    this._cleanupPromise = this._cleanupNow();
    try { await this._cleanupPromise; }
    catch (error) { this._set({ state: 'error', error: error.message, url: '', pid: null }); throw error; }
    finally { this._cleanupPromise = null; }
  }
  async _cleanupNow() {
    this._stopping = true;
    try {
      if (this.gateway) {
        const gateway = this.gateway; this.gateway = null;
        for (const s of this.connections) s.destroy(); this.connections.clear();
        await new Promise(resolve => { try { gateway.close(() => resolve()); } catch { resolve(); } });
      }
      const children = this.children.splice(0).reverse();
      const incomplete = [];
      for (const record of children) {
        const { child, supervised } = record;
        try {
          if (child.pid) {
            if (process.platform === 'win32') {
              if (child.exitCode === null && child.signalCode === null) {
                if (supervised) {
                  // Keep the supervisor alive while Windows terminates its Job
                  // Object. EOF asks it to exit only after every backend exits.
                  child.stdin.end();
                }
                else {
                  await new Promise(resolve => {
                    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                    const finish = () => { clearTimeout(timer); resolve(); };
                    const fallback = () => { try { child.kill(); } catch {} finish(); };
                    const timer = setTimeout(() => { try { killer.kill(); } catch {} fallback(); }, 3000);
                    killer.once('error', fallback);
                    killer.once('exit', code => { if (code) fallback(); else finish(); });
                  });
                }
              }
            } else {
              try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
              if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(700)]);
              // An exited leader may still have live descendants in its group.
              try { process.kill(-child.pid, 'SIGKILL'); } catch {}
            }
          }
          // The supervised close follows the Job Object's empty-process barrier;
          // Node's close additionally waits for all inherited stdio handles.
          let timer;
          try {
            await Promise.race([record.closePromise, new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${record.label} did not finish stopping within 5 seconds.`)), 5000);
            })]);
          } finally { clearTimeout(timer); }
          if (record.shutdownIncomplete) throw new Error(`${record.label} could not verify that its Windows process tree stopped.`);
        } catch (error) { incomplete.push(record); this._log(error.message); }
      }
      if (incomplete.length) {
        this.children.push(...incomplete);
        throw new Error('Website shutdown is incomplete. Check the hosting logs before replacing backend files.');
      }
    } finally { this._stopping = false; }
  }
  async stop() { ++this._token; await this._cleanup(); if (this._startPromise) await this._startPromise.catch(() => {}); await this._cleanup(); this._set({ state: 'stopped', url: '', error: '', pid: null }); }
}

module.exports = { SiteHost, DEFAULT_CONFIG, validateConfig, resolveDocumentRoot, requestPath, within, ACCESS_HEADER };
