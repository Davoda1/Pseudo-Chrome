# Website hosting implementation

`SiteHost` manages one trusted, deployment-ready project in the application's
`www` directory. The packaged application supplies nginx, Node.js/npm, PHP-CGI
and a Windows process supervisor. Website code runs with the current user's
permissions. It is not a container or an execution sandbox.

## API

```js
const { SiteHost, DEFAULT_CONFIG, validateConfig } = require('./host.cjs');
const host = new SiteHost({ www, configDir, runtimes });
host.on('status', state => console.log(state));
host.on('log', line => console.log(line));
const state = await host.start(validateConfig(siteConfig));
// state.url is the local HTTP origin, available only after readiness succeeds.
await host.stop();
```

`runtimes` contains absolute paths named `nginx`, `node`, `npmCli`, `php`
(the PHP-CGI executable), and on Windows `processRunner`. Its working directory
is the website root. The in-process static/PHP gateway is private; nginx fronts
it on a separate loopback port. The gateway prevents directory listings,
dotfile/config exposure, backend-source downloads, traversal and links outside
the selected document root. In-root aliases to private files are also blocked.

Status fields include `state` (also exposed as `status`), `mode`, `engine`,
`url`, `documentRoot`, `error` and `pid`. The bounded `logs` array retains the
latest 500 lines. A concurrent `start()` is rejected. `stop()` cancels an
in-progress startup and waits until its processes and sockets are closed.
Cancelled startup promises reject with `code === 'ABORT_ERR'`.

## Site configuration

| Key | Meaning |
| --- | --- |
| `mode` | `auto`, `static`, `node`, `php`, or `native`. |
| `documentRoot` | Directory relative to `www`; default `.`. Use the project's actual public/build directory when it differs from the project root. |
| `entry` | Node script, PHP front controller, or native executable relative to `www`. Native servers must already be compiled for the target OS. |
| `args` | Array of command arguments; no shell command string is used by the launcher. |
| `npmScript` | Named package.json script, such as `start`; an explicit `entry` takes precedence. |
| `env` | Object of environment names and string values. The launcher sets `HOST`, `HOSTNAME`, `BIND_HOST`, and `PORT` to its local backend binding. |
| `spa` | Static single-page applications: return index.html for missing extensionless page routes. Missing assets still return 404. |
| `port` | Public HTTP port, or `0` to allocate one. The main application can retain a stable available port to preserve website storage. |
| `backendPort` | Private backend port, or `0` to allocate one. |
| `startupTimeoutMs` | Readiness timeout, default 30000; accepted range 1000–180000. |

Automatic detection looks for root `index.html`, then `index.php` or a PHP
`public/index.php` front controller, then a built
`dist/index.html` or `build/index.html`, then a Node package start script/main
entry or `server.js`. An explicit entry can select a backend. Empty websites
are handled by the application's welcome page, not populated with sample data.

Node applications must have their deployment dependencies available. npm start
scripts are supported with bundled npm; the launcher does not silently install
dependencies or execute a build. Native servers must honor `HOST` and `PORT`,
or take equivalent explicit arguments/environment settings. A backend that
ignores the loopback host and binds all interfaces is rejected.

PHP is executed through FastCGI, including query strings, POST data, cookies,
sessions, redirects, uploads and PATH_INFO. Missing routes fall back to the
PHP front controller. PHP session and temporary data stay under the app's
configuration directory. Static video/audio byte ranges, conditional requests,
Node/native streaming responses, and WebSocket upgrades are supported.

The bundled PHP configuration limits POST bodies and individual uploads to
64 MiB, memory to 256 MiB, and script execution/input time to 120 seconds.
PHP POST/PUT/PATCH requests using chunked transfer without `Content-Length`
are buffered by the gateway with a separate 16 MiB cap. nginx accepts request
bodies up to 256 MiB, while backend proxy requests and PHP connections use
120-second timeouts; an application's own limits can be lower. Streaming and
upload support therefore do not imply unlimited request sizes or durations.

This is not an Apache configuration interpreter. `.htaccess`, custom nginx
configuration, server modules, databases, worker queues, domain-specific login
callbacks and external credentials may require project-specific adaptation.
The host supplies ordinary local HTTP semantics; it cannot recreate external
infrastructure merely from a document-root copy. External website resources
and API requests remain governed by normal Chromium web security.

## Demo address and client access

The desktop app reads optional `www/config.pseudochrome` through
`demo-config.cjs`. `SIMULATED_DOMAINNAME` is a validated display hostname only;
`PORT` overrides the public port. Neither setting rewrites browser origins,
cookies, TLS, backend Host semantics, or DNS. The gateway blocks this file for
all hosting modes, including when a Node/native backend would otherwise serve
it.

`SiteHost.setAccessPolicy({allowExternalPrograms, token})` changes public-client
access while the host runs. Standalone `SiteHost` callers retain permissive
access unless they set a policy. The desktop app defaults to restricted access
and supplies a fresh in-memory token. Its website session adds the private
`x-pseudo-chrome-access` header only to the active local HTTP/WebSocket origin.
The gateway validates it and strips it before forwarding HTTP, FastCGI, or
WebSocket requests. Tokens are not placed in website URLs, browser storage,
configuration files, UI state, or logs. All sockets still bind to loopback.
This is a gateway access control, not OS process isolation or a guarantee about
custom backend ports.

## Verification

Run `node --test tests/host.test.cjs` from the source root. To exercise the same
tests through nginx, set `PSEUDO_TEST_NGINX` to its absolute executable path.
Additional PHP runtime tests use `PSEUDO_TEST_PHP` as described in their test
file. The tests cover static/SPA behavior, source and path protection, requests,
cookies, upgrades, readiness failures, cancellation and descendant cleanup.
