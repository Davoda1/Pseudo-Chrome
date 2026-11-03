# Pseudo-Chrome 1.0.0

Pseudo-Chrome presents one deployment-ready local website inside a Chromium desktop window and manages its local hosting processes.

## Included

- Static/frontend builds, prepared Node.js and PHP applications, and compiled native HTTP servers through the bundled host.
- PHP runtime paths handle Windows short names and special characters; backend shutdown waits for process and stream closure, including every member of the Windows supervisor's process tree.
- Rapid tab navigation handles cancelled loads without stale errors. Local path checks, directory redirects, config access, and preview messages are validated.
- Tabs, local navigation history, reload, zoom, downloads, printing, and native Chromium storage.
- DevTools with left, right, bottom, and separate-window positions, element inspection, and a remembered dock preference.
- Site-specific permission controls with automatic camera/microphone previews.
- Optional displayed-domain aliases, configured ports, and same-computer gateway access.
- System/light/dark appearance, profile customization, and a bundled offline manual with the app icon.

## Downloads

- `Pseudo-Chrome-1.0.0-Windows-x64-portable.zip`
- `Pseudo-Chrome-1.0.0-Linux-x64.tar.gz`
- `pseudo-chrome_1.0.0_amd64.deb`
- `Pseudo-Chrome-1.0.0-Source.zip`
- `Pseudo-Chrome-1.0.0-Source.tar.gz`
- `Pseudo-Chrome-1.0.0-Preview.html`
- `Pseudo-Chrome-1.0.0-README.txt`
- `SHA256SUM.txt`

Extract portable packages completely before running them. The Windows package targets Windows 10/11 x64 and is unsigned. Linux packages target x86-64 glibc systems with the desktop dependencies described in the README. The standalone HTML preview demonstrates the interface and does not host a backend.

Application settings and website files live outside the install directory, under the platform's Pseudo-Chrome configuration folder. Existing website files are preserved when replacing the application package.

Projects must include their deployment dependencies. Pseudo-Chrome does not compile source, provision databases, interpret arbitrary Apache/nginx configuration, or recreate a public HTTPS domain. Hosted backend code runs with the current user's permissions.

Original project code, documentation, and artwork are licensed under AGPL-3.0-only. Third-party runtimes retain their original licenses and notices. Pseudo-Chrome is independent of Google.
