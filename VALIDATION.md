# Validation

The repository includes unit, hosting, and native Electron integration tests. Test results apply to the commit and platform actually executed. They do not establish compatibility with every website, operating system, codec, hardware device, or external service.

## Available checks

| Command | Coverage |
| --- | --- |
| `npm run check` | JavaScript syntax for the application entry points. |
| `npm test` | Configuration validation, navigation rules, permissions, favicon validation, default-manual seeding, and hosting behavior. |
| `npm run test:launch` | Direct executable startup, GUI and website readiness, and normal shutdown without Playwright's Electron launcher or a Node inspector. |
| `npm run test:electron` | Real website rendering, tabs/history, form targets, navigation restrictions, settings, zoom, process cleanup, and persistence. |
| `npm run test:popups` | Bounded menu/profile/tab popups, keyboard/focus behavior, themes, and profile persistence. |
| `npm run test:permissions` | Native permission requests, automatic synthetic media previews, decision isolation, cleanup, and revocation. |
| `npm run test:storage` | Browser storage across restarts, data clearing, gateway access policy, configured addresses, and dynamic tab metadata. |
| `npm run test:devtools` | Real DevTools frontend/target, Dock side controls, viewport resizing, Elements/Console/Network/Sources, persistence, and tab lifecycle. |
| `npm run test:favicons` | The default manual's app icon across cached and cache-bypassing reloads, chapter history, and new tabs; clearing it on a different document. |
| `npm run test:navigation` | Repeated replacement of pending new-tab loads, visible Chromium connection failures, and recovery. |
| `node tests/preview-messages.cjs` | Local-file and HTTP preview navigation, genuine splash controls, and rejected forged or stale messages. |

The test implementations are in [tests](tests). The example websites in [examples](examples/README.md) support manual acceptance checks.

Hosting regressions exercise PHP's real INI parser with Windows short paths and metacharacters, sessions/uploads in a path containing a tilde, process-tree exit and native-executable replacement after shutdown, and recovery after incomplete shutdown. Windows integration fixtures use the bundled process supervisor, with an additional test for direct process termination. The supervisor checks cover descendants with separate standard streams, a parent that has already exited, and backend stdin isolation. The surviving-child fixture detaches from Node's parent-owned shutdown job while remaining in the application's containing Job Object. Process-exit assertions run immediately after shutdown, require ESRCH rather than access-denied errors, and are followed by a closed-port check. Only deletion of temporary executable fixtures retries Windows EPERM/EBUSY file locks, for up to 100 retries at 50 ms intervals; it does not retry process-exit or port checks. Persistent file locks and other deletion errors still fail validation.

Security regressions cover path traversal, sibling-directory escapes, encoded directory redirects, config replacement and growth during reads, and linked nginx files. Preview-message tests need Playwright's Chromium (`npx playwright install chromium`) or an installed Chromium executable selected by `PSEUDO_CHROME_BROWSER`.

## Prepare dependencies

Run `npm ci`, then prepare the platform runtimes with the scripts in [scripts/BUILDING.md](scripts/BUILDING.md). The commands below assume that guide's sibling `pseudo-build` directory.

For complete hosting tests on Linux:

```sh
PSEUDO_TEST_NGINX="$PWD/../pseudo-build/runtimes/linux/nginx/nginx" \
PSEUDO_TEST_PHP="$PWD/../pseudo-build/runtimes/linux/php/php-cgi" \
PSEUDO_TEST_NODE="$PWD/../pseudo-build/runtimes/linux/node/bin/node" \
PSEUDO_TEST_NPM_CLI="$PWD/../pseudo-build/runtimes/linux/node/lib/node_modules/npm/bin/npm-cli.js" \
npm test
```

Hosting tests that lack their required runtime can be skipped. Some filesystem-link and process-group checks are intentionally platform-specific; distinguish these exclusions from missing dependencies. A release validation run must supply every required runtime and check the reported skip count, rather than treating a partial run as full coverage.

The packaged Windows CI runner executes unit/runtime test files sequentially so their real nginx, Node.js, and PHP fixtures do not compete during startup. It still requires every test file and all selected Electron suites; failures are not retried or ignored.

For native Electron checks on a Linux desktop:

```sh
export PSEUDO_CHROME_ELECTRON="$PWD/../pseudo-build/electron/linux/electron"
export PSEUDO_CHROME_RUNTIMES="$PWD/../pseudo-build/runtimes/linux"
export PSEUDO_CHROME_TEST_SCALE=1.25
npm run test:electron
npm run test:launch
npm run test:popups
npm run test:permissions
npm run test:storage
npm run test:devtools
npm run test:favicons
npm run test:navigation
```

Set `PSEUDO_CHROME_HEADLESS=1` only in a restricted Linux automation environment that needs the headless/no-sandbox test flags. Those flags belong to the test process and are not application defaults. Tests create temporary website profiles, bypass the application single-instance lock for isolated test instances, and remove their profiles after execution.

For packaged-application checks, point `PSEUDO_CHROME_ELECTRON` at the extracted executable and set `PSEUDO_CHROME_PACKAGED=1`. The package's own runtime directory is then available to the app. Use the source checkout's tests with the package built from that same commit.

On Windows, use the matching `win` runtime paths: `node/node.exe`, `node/node_modules/npm/bin/npm-cli.js`, `nginx/nginx.exe`, `php/php-cgi.exe`, and the Windows `process-runner.exe`. Execute Windows binaries and GUI checks on Windows; inspecting PE headers on another system is not equivalent.

## Packaged test runner

The cross-platform [CI test runner](scripts/ci/run-tests.cjs) configures the bundled runtime paths and runs tests against an extracted portable package. Linux requires the unit/hosting tests, direct-launch check, and all seven Electron integration suites. Windows requires the unit/hosting tests, direct-launch check, and smoke, storage, favicon, and navigation suites:

```sh
node scripts/ci/run-tests.cjs --package ../pseudo-build/packages/Pseudo-Chrome-Linux-x64
```

On Windows, pass the extracted Windows package directory instead. The runner uses isolated temporary profiles and 125% scaling. Its Linux automation path enables the test-only headless flags. Use ordinary desktop acceptance tests as well for window-manager and hardware behavior.

Windows popup, permission UI, and DevTools desktop-layout suites are opt-in because they depend on native window and viewport geometry at the runner's display scale. Run them on a Windows desktop by setting `PSEUDO_CHROME_EXTENDED_WINDOWS_UI=1`, or select **extended_windows_ui** when manually dispatching the validation workflow. These suites remain required on Linux. A default Windows CI pass does not establish coverage of those three desktop UI suites.

The runner executes every selected suite even when an earlier suite fails, then reports all failures together. Any selected failure still gives the job a nonzero exit status and prevents release publication. Its regression tests exercise real failing, timed-out, and successful subprocesses, plus platform-specific suite selection.

All GUI launches remove `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` from the inherited environment, including case variants. An empty `ELECTRON_RUN_AS_NODE` value is not equivalent to removing it on Windows. The direct-launch check starts the packaged executable without a shell, checks its real UI and website, and records bounded process diagnostics on failure. Playwright browser launch diagnostics are also enabled in CI.

[verify-release.py](scripts/ci/verify-release.py) checks the eight-file release set, checksums, archive layouts, licenses, and packaged application files. Its command-line usage is available with `python3 scripts/ci/verify-release.py --help`.

## Release checks

Before distributing a release:

1. Run the syntax, unit/hosting, and native Electron suites on the supported platforms.
2. Confirm website launch and clean shutdown for the bundled static, Node, PHP, and native examples.
3. Verify all eight release files, their checksums, archive integrity, and matching application sources.
4. Confirm a real EXE at the Windows ZIP root, a top-level ELF executable in the Linux TAR, and a compiled `/usr/bin/pseudo-chrome` in the DEB.
5. Verify that the application license, third-party notices, runtime manifests, examples, and default manual are packaged.
6. Review reports and archives for private data, credentials, local profiles, logs, and unrelated build output.

## Test limits

Synthetic camera and microphone devices make media tests repeatable; passing them does not verify physical hardware or OS privacy dialogs. Printing, screen/window-manager behavior, installation and sandbox integration, and hardware capture require ordinary target-desktop acceptance checks.

A local HTTP origin does not reproduce public HTTPS identity, domain-specific authentication, external databases, or remote services. A passing storage, networking, or hosting assertion covers its tested behavior, not every framework, Apache/nginx directive, native library, or deployment configuration.

CI results are attached to their individual commits and runs. A configured workflow is not evidence that a pending or skipped job passed.
