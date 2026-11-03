# Security policy

## Reporting a vulnerability

Use this repository's **Security → Report a vulnerability** option for a private report when available. Include affected versions, reproduction steps, the security impact, and a minimal example without real credentials or personal data.

If private reporting is unavailable, open an issue requesting a private reporting channel without including exploit details, sensitive logs, or secrets. Do not put access tokens or private website content into public issues or pull requests.

Security fixes are developed against `master`. Use the latest release when checking whether an issue is still present.

## Security boundaries

- Website renderer content is sandboxed and does not receive the application bridge or Node APIs.
- Top-level navigation is restricted to the configured local website. Internet subresources remain available subject to Chromium security rules.
- Website permission decisions are scoped to the relevant origin and lifetime. Media previews do not grant the website access.
- The public gateway binds to loopback and restricts ordinary clients by default. The optional external-program switch allows other clients on the same computer; it does not enable LAN access.
- The gateway access control is not an operating-system boundary against another process running as the same user, and it does not secure a custom backend's separately exposed ports.
- Hosted Node, PHP, and native code runs with the user's file and network permissions. Use trusted, deployment-ready projects. Pseudo-Chrome is not a container for executing untrusted backend code.
- A simulated domain changes the displayed address only. It does not provide DNS, TLS, or a public-origin security identity.

## Updates and dependencies

Electron, Chromium, Node.js, nginx, PHP, and build dependencies are pinned and must be reviewed when updating. Keep the included runtime manifests and upstream notices intact. Dependency alerts and automated scanning supplement tests and review; they do not certify that the application or a hosted website is vulnerability-free.

The repository workflows include dependency auditing, CodeQL, and dependency review. CodeQL and dependency review run automatically when the repository is public. For a private repository, set the repository variable `SECURITY_ANALYSIS_ENABLED` to `true` only when the required GitHub security entitlement is available. Dependency auditing remains part of validation in either visibility mode.
