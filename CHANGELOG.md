# Changelog

## 1.0.0

Initial release of Pseudo-Chrome.

- Chromium-based desktop presentation of one local website, with tabs, navigation, zoom, downloads, and printing.
- Managed nginx hosting for static/frontend builds, prepared Node.js and PHP applications, and compiled native HTTP backends.
- Quoted PHP runtime paths support Windows short names and INI metacharacters; Windows backend shutdown waits for the complete supervised process tree to exit before returning, including descendants that outlive their parent.
- Superseded tab loads are treated as cancellations while genuine page-loading failures remain visible.
- Canonical website path checks, same-origin directory redirects, bounded config reads, private nginx files, and validated preview messages.
- Dockable native DevTools with element inspection, Console, Sources, Network, and remembered dock position.
- Persistent website storage and origin-scoped permission controls with automatic media previews.
- Display-only domain aliases, configurable ports, and optional same-computer access through the local gateway.
- System/light/dark appearance, profile customization, bounded menus, and a bundled offline manual.
- Windows portable ZIP, Linux portable TAR.GZ, Debian DEB, source archives, standalone interface preview, README, and checksums.
- GNU Affero General Public License v3.0 only for original project code, documentation, and artwork; original notices retained for third-party components.
