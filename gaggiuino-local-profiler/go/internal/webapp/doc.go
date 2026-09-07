// Package webapp serves the production frontend: the existing Vite/rolldown
// SPA bundle (gaggiuino-local-profiler/public-src, built to
// gaggiuino-local-profiler/public), embedded into the Go binary via
// //go:embed and served at the application root.
//
// # Ship, don't rebuild (Phase 1, #901)
//
// The Go migration deliberately does NOT re-implement the frontend in
// templ. internal/web's eleven templ pages were a foundation experiment;
// re-creating the full SPA that way (shot charts, ECharts analytics,
// dial-in convergence, i18n across six languages, the annotator, orders,
// achievements, ...) is ~15-20k lines of new code chasing a target that
// keeps moving as `dev` ships. The SPA already builds to a set of
// relative-path, REST+SSE-only assets (see vite.config.js: `base: './'`,
// dynamic imports for echarts/topojson-client/qrcode, static import for
// chart.js) that run unmodified behind HA Ingress — the one hard
// requirement. So Phase 1 embeds that build output and serves it here,
// byte-for-byte the same UI the Node app serves today, and the Go frontend
// reaches parity in one step instead of never.
//
// internal/web's templ pages are frozen, not deleted: cmd/server mounts
// them under a /ui/ prefix as a no-JS fallback view. Their
// leading-slash-free relative-path convention (see internal/web/doc.go's
// "Ingress-safe relative paths" section) still holds unchanged — every page
// route simply moved one path segment deeper, together, so a relative link
// from /ui/shots to "beans" still resolves to /ui/beans, and to
// "web/static/style.css" still resolves to /ui/web/static/style.css. The
// scheme's own load-bearing precondition ("every page route is exactly one
// segment deep, every relative reference points at another such route")
// becomes "one segment deep below /ui/" — the relative math is identical.
//
// # Handler parity with server.js
//
// Handlers here mirror server.js's static/PWA-gating block (the
// app.get(['/', '/index.html']) handler plus the express.static that
// follows it, lines ~213-244):
//
//   - GET / and GET /index.html are server-templated: the embedded
//     dist/index.html is sent with a <link rel="manifest"> injected before
//     </head> ONLY when the request did not arrive through HA Ingress
//     (auth.IsIngressRequest — reused, not re-derived). Under Ingress the
//     add-on is framed inside the HA panel and a PWA install prompt /
//     service worker would be wrong; standalone (bare port) it is wanted.
//     Sent with Cache-Control: no-cache, no-store, must-revalidate plus
//     Pragma/Expires, exactly as Node does, so a redeploy's new asset
//     hashes are always picked up.
//   - Everything else in dist/ (the hashed assets/, manifest.json, sw.js,
//     icon.png, countries-110m.json) is served as a plain static file.
//     manifest.json/sw.js are served even under Ingress, matching Node —
//     harmless, since a page that never received the manifest <link> or
//     ran the SW-registration call never requests them.
//   - A .html file (only ever index.html today) carries the same no-cache
//     headers, matching express.static's setHeaders callback.
//
// # CSP
//
// internal/auth.SecurityHeaders's Content-Security-Policy is NOT relaxed
// for these routes. The built bundle was checked against the strict policy
// (script-src 'self', no 'unsafe-inline'/'unsafe-eval'): the emitted
// index.html loads only external same-origin <script type="module"> /
// <link rel="stylesheet"> tags (no inline script, no inline event
// handlers); grepping every chunk in public/assets/ for `eval(` /
// `new Function` / `WebAssembly` / `new Worker` came back empty — modern
// chart.js and ECharts builds need none of them. Dynamic import() of the
// echarts/topojson/qrcode chunks is same-origin and covered by
// script-src 'self'. The SPA's fetch/XHR/EventSource targets are all
// same-origin /api/* (connect-src 'self'); its Blob()/createObjectURL use
// is CSV/.shot/image export via <a download> and <img>, covered by the
// existing img-src 'self' data: blob:. The data: favicon needs img-src
// data: (already present). So no webapp-specific policy carve-out is
// required, and the templ pages under /ui/ keep the identical strict
// policy they already satisfied.
//
// # dist/ and the build
//
// //go:embed all:dist embeds the build output. dist/ is a build artifact:
// `make -C go frontend` (or the Dockerfile's `frontend` stage) runs
// `npm ci && npm run build` and stages gaggiuino-local-profiler/public
// into it. Everything under dist/ is git-ignored EXCEPT a committed
// dist/index.html placeholder, so a bare `go build ./...` / `go test ./...`
// (CI's go-build.yaml test job runs exactly that, with no npm step)
// resolves the embed without the frontend toolchain. The `all:` prefix
// keeps Vite's underscore/dot-prefixed emitted assets in the embed.
package webapp
