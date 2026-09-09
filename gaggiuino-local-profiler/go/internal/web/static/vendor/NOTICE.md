# Vendored third-party assets

Both files below are vendored verbatim (unmodified) from their official npm
tarballs — not loaded from a CDN at build or run time, per the project's
security-first stance (see go/README.md's "Why"). To upgrade, re-download
the same `dist/` file from a newer npm tarball and update the filename's
version suffix (which the embedded `<script src>` tag in
templates/layout.templ also references — update both together).

| File                              | Package        | Version | License              | Source                                                          |
|------------------------------------|----------------|---------|-----------------------|------------------------------------------------------------------|
| `htmx-2.0.10.min.js`               | htmx.org       | 2.0.10  | 0BSD (MIT-compatible) | https://registry.npmjs.org/htmx.org/-/htmx.org-2.0.10.tgz (dist/htmx.min.js) |
| `htmx-sse-ext-2.0.10.js`           | htmx.org       | 2.0.10  | 0BSD (MIT-compatible) | same tarball, dist/ext/sse.js                                    |
| `alpine-csp-3.16.2.min.js`         | @alpinejs/csp  | 3.16.2  | MIT                   | https://registry.npmjs.org/@alpinejs/csp/-/csp-3.16.2.tgz (dist/cdn.min.js) |
| `chart-4.5.1.umd.min.js`           | chart.js       | 4.5.1   | MIT                   | https://registry.npmjs.org/chart.js/-/chart.js-4.5.1.tgz (dist/chart.umd.min.js) |

`cdn.min.js` is each library's official standalone build meant for a plain
`<script>` tag — no bundler or ESM import needed, matching the "no Node/npm
anywhere" goal. `chart.umd.min.js` is the same kind of build for Chart.js
(a plain global `Chart`, no ESM import) — copied here from this repo's own
existing `node_modules/chart.js` (the same npm package `public-src/`
already depends on and bundles via webpack today), not downloaded fresh,
since it's the identical official tarball asset either way. Only
`templates/live.templ` (Phase 2c, #901) loads this file — every other page
has no chart, so it isn't pulled into `templates/layout.templ`'s shared
`<head>`. No `new Function`/`eval` anywhere in this build (verified by
grepping the minified source), so it needs no CSP relaxation the way
plain Alpine would — script-src 'self' with no 'unsafe-eval' is enough.

**Why `@alpinejs/csp`, not plain `alpinejs`**: core Alpine evaluates
`x-data`/`@click`/... expressions via `new Function(...)`, which needs
`script-src 'unsafe-eval'`. `internal/auth.SecurityHeaders`'s CSP
(`script-src 'self'`, no `'unsafe-eval'`, no `'unsafe-inline'`) is
intentionally strict and out of scope to relax for this package — see
go/README.md's security-parity requirement. The official CSP build
(https://alpinejs.dev/advanced/csp) swaps in a restricted, eval-free
expression evaluator instead. It still runs everything this codebase's
templates use directly in HTML attributes (`x-data="{ open: false }"`,
`@click="open = !open"`, `x-show="open"`, simple property/boolean
expressions) — the restriction that actually matters is arbitrary
multi-statement JS or calling functions not registered via `Alpine.data()`/
`Alpine.magic()`, which nothing here needs.
