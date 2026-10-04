// Package webapp serves the production frontend: the existing Vite/rolldown
// SPA bundle (gaggiuino-local-profiler/public-src, built to
// gaggiuino-local-profiler/public), embedded into the Go binary via
// //go:embed and served at the application root.
//
// # Ship, don't rebuild (#901)
//
// The Go migration deliberately does NOT re-implement the frontend in
// templ. The former eleven server-rendered templ pages were a foundation experiment;
// re-creating the full SPA that way (shot charts, ECharts analytics,
// dial-in convergence, i18n across six languages, the annotator, orders,
// achievements, ...) is ~15-20k lines of new code chasing a target that
// keeps moving as `dev` ships. The SPA already builds to a set of
// relative-path, REST+SSE-only assets (see vite.config.js: `base: './'`,
// dynamic imports for echarts/topojson-client/qrcode, static import for
// chart.js) that run unmodified behind HA Ingress — the one hard
// requirement. So this package embeds that build output and serves it here,
// byte-for-byte the same UI the frontend already produces, rather than
// rebuilding it.
//
// During the migration those templ pages were kept as a no-JS
// fallback mounted under a /ui/ prefix; they have since been removed. The
// only surviving legacy address is GET /ui/kiosk, which
// redirects onto the rebuilt kiosk page (see handlers.go).
//
// # Handler behavior
//
// Handlers here cover the static/PWA-gating block: the SPA shell for
// '/' and '/index.html', then plain static files for everything else:
//
//   - GET / and GET /index.html are server-templated: the embedded
//     dist/index.html is sent with a <link rel="manifest"> injected before
//     </head> ONLY when the request did not arrive through HA Ingress
//     (auth.IsIngressRequest — reused, not re-derived). Under Ingress the
//     add-on is framed inside the HA panel and a PWA install prompt /
//     service worker would be wrong; standalone (bare port) it is wanted.
//     Sent with Cache-Control: no-cache, no-store, must-revalidate plus
//     Pragma/Expires, so a redeploy's new asset hashes are always picked
//     up.
//   - Everything else in dist/ (the hashed assets/, manifest.json, sw.js,
//     icon.png, countries-110m.json) is served as a plain static file.
//     manifest.json/sw.js are served even under Ingress — harmless, since a
//     page that never received the manifest <link> or ran the
//     SW-registration call never requests them.
//   - A .html file (only ever index.html today) carries the same no-cache
//     headers.
//
// # CSP
//
// internal/auth.SecurityHeaders's Content-Security-Policy is NOT relaxed
// for these routes beyond the one 'wasm-unsafe-eval' source the on-device
// cut-out runtime needs: script-src still allows neither 'unsafe-inline' nor
// the general 'unsafe-eval'. The built bundle was checked against that
// policy: the emitted index.html loads only external same-origin
// <script type="module"> / <link rel="stylesheet"> tags (no inline script, no
// inline event handlers); grepping every chunk in public/assets/ for `eval(` /
// `new Function` / `WebAssembly` / `new Worker` came back empty — modern
// chart.js and ECharts builds need none of them. Dynamic import() of the
// echarts/topojson/qrcode chunks is same-origin and covered by
// script-src 'self'. The SPA's fetch/XHR/EventSource targets are all
// same-origin /api/* (connect-src 'self'); its Blob()/createObjectURL use
// is CSV/.shot/image export via <a download> and <img>, covered by the
// existing img-src 'self' data: blob:. The data: favicon needs img-src
// data: (already present). So no webapp-specific policy carve-out is
// required; the SPA is the only UI served from here.
//
// # dist/ and the build
//
// //go:embed all:dist embeds the build output. dist/ is a build artifact:
// `make -C go frontend` (or the Dockerfile's `frontend` stage) runs
// `npm ci && npm run build` and stages gaggiuino-local-profiler/public
// into it. Everything under dist/ is git-ignored EXCEPT a committed
// dist/index.html placeholder, so a bare `go build ./...` / `go test ./...`
// (CI's test.yaml go-test job runs exactly that, with no npm step)
// resolves the embed without the frontend toolchain. The `all:` prefix
// keeps Vite's underscore/dot-prefixed emitted assets in the embed.
package webapp
