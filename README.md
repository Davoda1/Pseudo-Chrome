# Pseudo-Chrome

<img src="app/assets/icon.svg" alt="Pseudo-Chrome icon" width="88" height="88">

**Present a local website in a familiar Chromium desktop window.**

Pseudo-Chrome starts a local host and displays one deployment-ready website with real Chromium rendering. It includes tabs, history, zoom, downloads, browser storage, permission prompts, and dockable developer tools. It is an independent project and is not affiliated with or endorsed by Google.

## Features

- Serve static sites and frontend build output, Node.js applications, PHP projects, or already compiled native HTTP servers.
- Use working tabs, Back/Forward, reload, page zoom, printing, and Chromium DevTools.
- Dock DevTools to the left, right, or bottom, or move it to a separate window. The selected position is remembered.
- Keep cookies, local storage, IndexedDB, Cache Storage, service workers, and other Chromium website data between launches.
- Handle website permissions with site-specific controls and live camera/microphone previews.
- Choose system, light, or dark appearance, a profile image, and a saved profile name.
- Present a display-only domain alias while the actual website remains on a local HTTP origin.
- Read the small offline manual included as the default website. Existing website files are preserved on upgrade.

External top-level navigation is disabled. The local website can still request internet images, fonts, scripts, APIs, and embedded frames under normal Chromium security rules.

## Download and run

Release packages are listed on the [Releases page](https://github.com/Davoda1/Pseudo-Chrome/releases).

| Platform | Package | Start |
| --- | --- | --- |
| Windows 10/11 x64 | `Pseudo-Chrome-1.0.0-Windows-x64-portable.zip` | Extract the complete archive and open `Pseudo-Chrome.exe`. |
| Linux x86-64 | `Pseudo-Chrome-1.0.0-Linux-x64.tar.gz` | Extract the complete archive and run `./pseudo-chrome` as your regular user. |
| Debian/Ubuntu amd64 | `pseudo-chrome_1.0.0_amd64.deb` | Install with `sudo apt install ./pseudo-chrome_1.0.0_amd64.deb`, then use the application menu. |

Keep the resources and runtime directories beside the portable executable. Windows binaries are unsigned. Linux requires glibc 2.28 or newer, Electron's desktop libraries, and working sandbox support. The Debian package declares its runtime dependencies; the portable TAR uses the host's supported user-namespace sandbox. ARM, macOS, and Alpine/musl packages are not provided.

Each release contains eight files: the three desktop packages above, source ZIP and TAR.GZ archives, `Pseudo-Chrome-1.0.0-Preview.html`, `Pseudo-Chrome-1.0.0-README.txt`, and `SHA256SUM.txt`. The checksum manifest covers the other seven files. Run `sha256sum -c SHA256SUM.txt` on Linux, or compare `Get-FileHash -Algorithm SHA256 <filename>` on Windows.

The standalone Preview HTML demonstrates the interface with simulated controls. It does not run Electron or host a real backend.

## Present your website

1. Start the app. A fresh, unconfigured installation opens the bundled offline manual.
2. Open **⋮ → Settings → Website → Open folder**. Close the app and back up the current website and configuration before replacing them.
3. Put your prepared website into `www`. Select its website type, document root, and entry in Website settings, then choose **Save and restart**. Set the start page to `/` unless your project needs another path.
4. Use local paths such as `/products`, the address field, links, and tabs to demonstrate the website.

| System | Website directory |
| --- | --- |
| Windows | `%AppData%\Pseudo-Chrome\www` |
| Linux | `$XDG_CONFIG_HOME/Pseudo-Chrome/www`, normally `~/.config/Pseudo-Chrome/www` |

`site.json`, `settings.json`, and saved permission choices are stored beside `www`. Replacing the application package preserves this directory. The default manual is seeded only when `www` is empty and no `site.json` exists.

The manual's source is [app/default-www/index.html](app/default-www/index.html). The packaged copy is `resources/app/app/default-www` in the portable packages. To restore it, close the app, back up the existing website/configuration, copy that directory's contents into `www`, and select Static hosting with document root `.`, no entry, and SPA routing off.

### Supported project types

| Project | Preparation |
| --- | --- |
| HTML/CSS/JavaScript | Copy the website files and select Static or Automatic. |
| React, Vue, or another static frontend | Copy the deployment build, or select its `dist`/`build` directory. Enable SPA routing if needed. |
| Node.js or a prepared SSR application | Supply deployment dependencies and a Node entry file or package start script. |
| PHP | Supply the code and vendor dependencies; select the public directory and front controller where needed. |
| Rust or C++ HTTP server | Supply an executable already built for the target OS/architecture, with its required files and libraries. |

See the included [examples](examples/README.md) and [hosting reference](app/lib/HOSTING.md).

The host does not compile source code, build frontend projects, install npm/Composer dependencies automatically, provision databases, or interpret arbitrary Apache/nginx configuration and `.htaccess`. A document-root copy cannot supply missing databases, queues, custom extensions, credentials, or other services. Node/native backends must listen on the supplied loopback `HOST` and `PORT`.

A local HTTP origin also differs from a public HTTPS domain. Domain-bound cookies, OAuth callbacks, CORS, certificates, mixed-content rules, DRM, browser extensions, account synchronization, and Google-specific services may behave differently. The bundled Chromium version may differ from an installed Chrome version.

### Site configuration

Use Website settings, or edit `site.json` while the application is closed. Paths are relative to `www`; `site.json` belongs beside that directory.

```json
{"mode":"static","documentRoot":"dist","spa":true}
```

```json
{"mode":"node","entry":"server.cjs","env":{"NODE_ENV":"production"}}
```

```json
{"mode":"php","documentRoot":"public","entry":"public/index.php"}
```

```json
{"mode":"native","entry":"server.exe","args":[],"startupTimeoutMs":30000}
```

These are configuration examples: use the paths and executable appropriate to your project. The [hosting reference](app/lib/HOSTING.md) documents all fields and hosting limits.

### Displayed domain and port

Optionally place a UTF-8 `config.pseudochrome` file directly in `www`:

```ini
SIMULATED_DOMAINNAME=demo.example
PORT=43881
```

The supported keys are `SIMULATED_DOMAINNAME` and `PORT`; see the [included example](examples/config.pseudochrome.example). Restart the website after editing. `PORT` overrides the public port in `site.json`; `0` requests automatic selection. An occupied fixed port produces an error.

The domain alias changes only the displayed address. It does not configure DNS or HTTPS, change JavaScript's actual origin, or make domain-bound cookies and authentication behave as if the site were publicly hosted. Connection details show the real local origin. This configuration file is not served as website content.

### Access and stored data

**Settings → Website → Allow other apps on this computer to access the website** is off by default. Turning it on allows other local clients to reach the demo's public address. Both modes bind to `127.0.0.1`; this switch does not enable LAN access. It controls the app's gateway, not arbitrary backend ports or other processes running as the same OS user.

Website storage uses a persistent Chromium session. Keep the same actual scheme, hostname, and port to preserve origin-scoped data. A display alias does not change that origin. **Clear website data** clears browser data without deleting website files, backend databases, or app settings. Saved permissions are reset separately in site controls.

## Controls

| Action | Control |
| --- | --- |
| New / close tab | `Ctrl+T` / `Ctrl+W` |
| Focus address | `Ctrl+L` |
| Back / forward | `Alt+Left` / `Alt+Right` |
| Reload / reload without cache | `Ctrl+R` / `Ctrl+Shift+R` |
| Zoom / reset zoom | `Ctrl++`, `Ctrl+-`, `Ctrl+0` |
| Search open tabs | `Ctrl+Shift+A` |
| Main menu | `Alt+F` or **⋮** |
| Developer tools | `F12`, `Ctrl+Shift+I`, or **⋮ → Developer tools** |
| Inspect an element | Right-click the website element → **Inspect** |
| Full screen / print | `F11` / `Ctrl+P` |

In DevTools, use **⋮ → Dock side** to dock or undock the inspector. Opening tools from Settings or About returns to the target website so a docked inspector is visible. Closing its website tab also closes that inspector.

Appearance, profile name, and profile image are under **Settings → Appearance**. Site controls are opened by the tune icon beside the address. They show only permissions the website has requested. Camera and microphone prompts automatically show preview frames/levels while open; previewing does not grant website access. Responding to or dismissing the prompt stops its preview tracks. Hardware and OS privacy permissions still apply.

Tabs track page titles and favicons, including dynamic updates and reloads. The offline manual uses the app icon. The main window can be resized down to 680 × 540 device-independent pixels; popup panels remain within it.

## Runtime versions

| Component | Pinned version |
| --- | --- |
| Electron | 45.2.1 |
| Chromium | 156.0.8078.75 |
| Node.js inside Electron | 24.22.1 |
| Node.js for hosted websites | 26.13.0 LTS |
| nginx | 1.30.6 |
| PHP | 8.5.12; Windows distribution 8.5.12-1 |

Windows uses the official x86 nginx executable through WOW64; Electron, Node.js, PHP, and the backend process supervisor are x64. Runtime manifests and original license notices accompany the desktop packages.

## Build and test

The [build guide](scripts/BUILDING.md) covers runtime acquisition, toolchains, staging, and release packaging. The [validation guide](VALIDATION.md) lists test commands and what they cover. Repository automation is defined in the [validation workflow](.github/workflows/validate.yml); version-tag publishing is gated on Linux and Windows package tests.

```sh
npm ci
npm run check
npm test
```

Hosting integration needs the prepared runtimes; Electron integration additionally needs an Electron executable. See [VALIDATION.md](VALIDATION.md) before interpreting tests that skip missing-runtime cases. For development, set `PSEUDO_CHROME_RUNTIMES` to the prepared platform runtime directory and run `npm start`.

Report reproducible bugs through the repository's Issues page. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [SECURITY.md](SECURITY.md) for vulnerability reports. Do not include credentials, private website data, or personal paths in reports.

## License

Original project code, documentation, and project artwork are licensed under the **GNU Affero General Public License v3.0 only**, SPDX identifier `AGPL-3.0-only`. See [LICENSE](LICENSE). Desktop packages also include `LICENSE-PSEUDO-CHROME`; Electron’s separate `LICENSE` remains intact.

Third-party components retain their own licenses and notices; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Google Chrome and Chromium names and marks belong to their respective owners. No Google affiliation or endorsement is implied.
