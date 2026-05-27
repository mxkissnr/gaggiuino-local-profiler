# Security Policy

## Supported Versions

Only the **latest release** receives security fixes. Please update before reporting.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Send a private report to **maximilian.kissner24@gmail.com** with:

- A clear description of the vulnerability
- Steps to reproduce (proof-of-concept if possible)
- Potential impact

I will acknowledge your report within **7 days** and aim to release a fix within **30 days** depending on severity.

## Scope

This add-on runs locally on your Home Assistant instance and communicates only with your Gaggiuino machine on the local network. The primary attack surface is:

- The HTTP API (token-protected endpoints)
- The HA ingress proxy
- Imported shot data (JSON parsing)

Out of scope: vulnerabilities in Home Assistant itself, the Gaggiuino firmware, or third-party dependencies that have already been reported upstream.
