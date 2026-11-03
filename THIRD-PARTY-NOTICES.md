# Third-party components and notices

Original Pseudo-Chrome code, documentation, and project artwork are licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`); see [LICENSE](LICENSE). This license does not replace the licenses of the third-party components listed below.

Desktop packages include Electron/Chromium, Node.js/npm, nginx, PHP, and their dependencies. Their original licenses and notices are retained in the packaged runtime directories, including Electron's `LICENSE` and `LICENSES.chromium.html`. Runtime manifests record pinned distributions and verification information. Keep those notices and manifests when redistributing packages. The project license is also packaged as `LICENSE-PSEUDO-CHROME` at the portable package root and as `resources/app/LICENSE`; these copies do not overwrite Electron’s own `LICENSE`. The Debian package additionally installs its copyright notice under `/usr/share/doc/pseudo-chrome/copyright`.

PHP includes additional shared libraries on Linux and Microsoft runtime components on Windows. Their notices are retained with the corresponding runtime. Linux nginx includes its linked dependencies. The build scripts record the sources and checks used to obtain and build these components.

The Windows resource editor `resedit` is a build dependency, not an application runtime dependency. Its pinned dependencies are recorded in [scripts/build-tools/package.json](scripts/build-tools/package.json) and [scripts/build-tools/package-lock.json](scripts/build-tools/package-lock.json). Electron and Playwright development dependencies are recorded in [package.json](package.json) and [package-lock.json](package-lock.json).

Google Chrome and Chromium names and marks belong to their respective owners. Pseudo-Chrome is an independent project; its name, interface, and project-specific icon do not imply Google affiliation, sponsorship, or endorsement. The project license grants no rights to third-party trademarks.
