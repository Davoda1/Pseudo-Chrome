# Contributing

Pseudo-Chrome presents one local website through a Chromium desktop interface and manages its local hosting processes. Changes should preserve website isolation, ordinary browser behavior, and clear deployment requirements.

## Development

1. Install the pinned dependencies with `npm ci`.
2. Follow [scripts/BUILDING.md](scripts/BUILDING.md) to prepare runtimes.
3. Run the checks in [VALIDATION.md](VALIDATION.md).
4. Keep generated runtime binaries, release archives, local website profiles, credentials, and logs out of commits.

Use `master` as the pull-request target. Keep commits focused, with a title stating the concrete change and a body explaining the problem, resulting behavior, and relevant validation. Update the bundled manual when user-visible behavior changes. Every documented example and local file reference must correspond to repository content or a documented build output.

Bug reports should include the app version, operating system, website type, minimal reproduction steps, expected behavior, and actual behavior. Use a small synthetic example rather than private website code. Remove credentials, personal data, and private filesystem paths from logs and screenshots.

For security issues, follow [SECURITY.md](SECURITY.md) rather than publishing exploit details in an ordinary issue.

## Compatibility

The application targets Windows 10/11 x64 and x86-64 glibc Linux. Website backends must be deployment-ready and respect the configured loopback binding. New functionality must not silently grant general web navigation or expose Electron/Node APIs to website content.

Test native behavior in the real Electron application. An interface preview or a dispatched command alone does not demonstrate working permissions, storage, hosting, or DevTools.

## License

Contributions are submitted under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`), matching [LICENSE](LICENSE). Submit only code, documentation, and artwork you have permission to contribute under those terms. Preserve third-party license and attribution notices.
