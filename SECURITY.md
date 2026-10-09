# Security Policy

## Supported Versions

Only the **latest release** receives security fixes. Please update before reporting.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please open a **[private security advisory](https://github.com/mxkissnr/gaggiuino-local-profiler/security/advisories/new)** on GitHub and include:

- A clear description of the vulnerability
- Steps to reproduce (proof-of-concept if possible)
- Potential impact

I will acknowledge your report within **7 days** and aim to release a fix within **30 days** depending on severity.

## Scope

This app runs locally on your Home Assistant instance. It talks to:

- your Gaggiuino and GaggiMate machines on the local network
- GitHub: the check for new app and Gaggiuino firmware releases, and the one-time download of the sticker cut-out models
- roaster shop pages, when you import a bean from a URL
- OpenStreetMap Nominatim, to place a bean's origin on the map
- clients of its own optional MCP endpoint, which is off by default and token-protected

The primary attack surface is:

- The HTTP API (token-protected endpoints)
- The HA ingress proxy
- Imported shot data (JSON parsing)

Out of scope: vulnerabilities in Home Assistant itself, the Gaggiuino firmware, or third-party dependencies that have already been reported upstream.
