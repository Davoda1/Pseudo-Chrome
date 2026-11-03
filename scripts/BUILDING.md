# Building the release packages

The supplied application packages already include Electron, the website Node.js/npm runtime, nginx, PHP-CGI, and the PHP runtime dependencies. Building the complete eight-file release is a separate developer workflow. The cross-platform release workflow below runs on Linux with Python 3.12 or later, Node.js 26.13.0, npm, GCC/make, musl, MinGW-w64, dpkg-deb, GnuPG, and cabextract.

The application's Electron runtime is 45.2.1 (Chromium 156.0.8078.75, embedded Node.js 24.22.1). Hosted Node websites use the separately bundled Node.js 26.13.0 LTS runtime. These are two distinct runtimes.

## Build dependencies

On an Ubuntu/Debian build machine, install the development packages needed by PHP and the packaging helpers. Package names may differ between distribution releases:

```sh
sudo apt-get install build-essential python3 pkg-config autoconf bison re2c \
  musl-tools gcc-mingw-w64-x86-64-posix dpkg-dev gnupg cabextract xz-utils \
  libxml2-dev libsqlite3-dev libssl-dev libcurl4-openssl-dev libonig-dev \
  libsodium-dev libzip-dev zlib1g-dev libbz2-dev libgmp-dev libxslt1-dev \
  libicu-dev libpq-dev libpng-dev libjpeg-dev libwebp-dev libfreetype-dev
npm ci
npm ci --prefix scripts/build-tools
```

The `scripts/build-tools` dependency is `resedit`, used to embed the application icon and version metadata in the Windows executable without Wine. The modified Windows application executable is unsigned.

## Fetch and build the pinned runtimes

Run these commands from the source root. The build directories are outside the source tree so they cannot enter the source archives accidentally.

```sh
python3 scripts/fetch-core-runtimes.py --cache ../pseudo-build/downloads --stage ../pseudo-build
python3 scripts/fetch-nginx.py --work-dir ../pseudo-build/nginx-work --output ../pseudo-build/runtimes
python3 scripts/fetch-php.py --cache ../pseudo-build/php-downloads --work ../pseudo-build/php-work --output ../pseudo-build/runtimes --jobs 4
python3 scripts/build-process-runner.py --out ../pseudo-build/runtimes/win/process-runner.exe
```

Core distributions are checked against their official SHA256 manifests. The nginx script verifies pinned checksums and its official signing key/signatures. The PHP script verifies the pinned source archive, Windows runtime, Microsoft runtime, and dated CA bundle. Keep the recorded runtime manifests and license notices with the packaged files.

Linux nginx is linked statically with musl, PCRE2, and zlib. Linux PHP uses a small static native entry point and a private bundled glibc loader/library directory. The latter prevents PHP's bundled libraries from changing the environment of unrelated system programs. Do not add that directory globally to `LD_LIBRARY_PATH`.

The official Windows nginx runtime is x86 and runs under Windows x64's WOW64 support. The application, Node.js, PHP, and Windows process supervisor are x64.

## Stage and validate

```sh
python3 scripts/package.py --stage ../pseudo-build --out ../pseudo-deliverables --phase stage
```

This creates these unpacked packages:

- `../pseudo-build/packages/Pseudo-Chrome-Linux-x64/pseudo-chrome`
- `../pseudo-build/packages/Pseudo-Chrome-Windows-x64/Pseudo-Chrome.exe`

They are the actual Electron executables, with no application launcher script. The stage operation recreates the package directories; stop running copies before restaging. Runtime command locations are recorded in `resources/runtimes/paths.json`.

For development, point `PSEUDO_CHROME_RUNTIMES` at the appropriate runtime directory and start the source application with `npm start`. Run the tests declared in the root `package.json` and validate representative static, Node, PHP, and native sites before packaging. Validate Windows on Windows; a PE/resource inspection is not a Windows GUI execution test.

## Produce the eight files

Finish the release documentation and regenerate the standalone interface preview from the current UI:

```sh
node scripts/build-preview.cjs
```

Then run:

```sh
python3 scripts/package.py --stage ../pseudo-build --out ../pseudo-deliverables --phase release
```

The output consists of the Windows portable ZIP, Linux TAR.GZ, Debian DEB, source ZIP, source TAR.GZ, standalone Preview HTML, README text file, and one `SHA256SUM.txt` manifest for the other seven files.

The Debian package installs a real statically linked native ELF entry point at `/usr/bin/pseudo-chrome`. It executes the private Electron engine under `/usr/lib/pseudo-chrome`; it is neither a symlink nor a shell script. This keeps generic Electron resources out of `/usr/bin`. The source for this entry point is `scripts/debian-entry.c`.

The Windows `process-runner.exe` helper contains each backend process tree in a Job Object. Closing or terminating the helper also closes the job and terminates its descendants, including cases where an intermediate npm process has already exited. It is a backend lifetime helper, not the application entry point.

No code-signing certificate is included. The local `scripts/package.py` command only produces files; it does not publish a repository or release.

## Repository automation

The repository's [validation workflow](../.github/workflows/validate.yml) builds the packages and runs the real unit/hosting and Electron suites on Linux and Windows. The [packaged test runner](ci/run-tests.cjs) supplies the bundled runtime paths. The [release verifier](ci/verify-release.py) checks the eight-file set, checksums, archive layouts, packaged sources, licenses, and notices.

A push of a `v*` release tag can publish only after both platform jobs pass. The tag must match the package version. The [publisher](ci/publish-release.py) uses [RELEASE_NOTES.md](../RELEASE_NOTES.md), opens a draft, uploads the verified eight assets, checks their GitHub-reported SHA256 digests, and publishes only after the complete set is present. It refuses to replace an existing release. Review the version, release notes, and tag target before pushing a release tag.

The repository also defines [CodeQL](../.github/workflows/codeql.yml), [dependency review](../.github/workflows/dependency-review.yml), and [scheduled dependency auditing](../.github/workflows/dependency-audit.yml). Private-repository security entitlement and opt-in requirements are described in [SECURITY.md](../SECURITY.md). Workflow configuration alone does not mean a pending run passed.
