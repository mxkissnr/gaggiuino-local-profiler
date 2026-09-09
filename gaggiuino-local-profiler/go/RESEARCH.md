# Phase 0 Research Spikes

Companion to `go/README.md`. Findings only — no code in this package
depends on anything below yet.

- SQLite driver evaluation (modernc vs. ncruces, issue #958):
  `RESEARCH-sqlite-driver.md`.

## 1. Protobuf sources for the Gaggiuino firmware protocol

### What's in this repo today

`lib/gaggiuino-proto.js` (and its siblings `lib/gaggiuino-ws-client.js`,
`lib/machines/gaggimate/ws-client.js`, `lib/gaggiuino-live-client.js`) define
every machine message as a `@protobuf-ts/runtime` `MessageType` — a
reflection descriptor (field number, name, wire kind, scalar-type code,
repeated flag) that protobuf-ts uses at runtime for both binary encode/decode
and JSON. There are **no `.proto` source files anywhere in this repo or in
`node_modules`** — confirmed by search. The file's own header comment says
these were "reconstructed field-for-field from the machine's own web UI
bundle... and verified live against a real machine," with a subset
(`SensorStateSnapshotDto`/`SystemStateDto`/`UpdateSystemStateCommandDto`/
`ServiceTestCommandDto`) sourced instead from Gaggiuino's own published docs.

### The wire format is real binary Protocol Buffers — confirmed against upstream

Fetched `docs/rest-api/websocket.md` from the `GAGGIUINO/gaggiuino.github.io`
docs site today (the exact file `lib/gaggiuino-proto.js`'s header comment
cites). It is unambiguous and current:

> "Every frame - in both directions - is a Protocol Buffers message sent as
> a binary WebSocket frame (`WEBSOCKET_OP_BINARY`), **not** JSON text. This
> is the same nanopb-based wire format used for STM32↔ESP32 communication
> internally. There is no JSON fallback."

The envelope is `WebSocketMessageDto { string action = 1; bytes data = 2; }`
— `action` routes to a type, `data` is a second, independently-encoded
protobuf message of that type. This matches `lib/gaggiuino-proto.js`'s
`WebSocketMessageDto` exactly.

The doc names the actual source paths:

```
lib/Common/**/*.proto
frontend-controls/common/**/*.proto
frontend-controls/webserver/**/*.proto
```

and points at `protobuf-ts` (same library GLP already uses) as the reference
TS-generation tool, with `frontend-controls/web-interface/build_scripts/
build_protobuf.js` as the canonical build script.

**Caveat, not resolved in this spike:** those paths were not found in any
branch I could locate. `Zer0-bit/gaggiuino` (2.6k★, the main firmware repo by
star count) has three branches — `main` (docs/readme only, 12 files),
`community` (community-contributed profile JSON presets, no source), and
`release/stm32-blackpill` (233 files, has a `webserver/src/server/websocket/
websocket.cpp` — but that implementation uses **plain JSON** over
`ArduinoJson`/`WS_TEXT`, not binary protobuf, so it's evidently an older or
divergent hardware-target branch, not the one the docs above describe). None
of the historical `main-<hash>` release tags I checked contain
`frontend-controls/` or `lib/Common/` either. Likely explanation: firmware
development has moved to a repo/layout this spike didn't surface (possibly a
monorepo restructure after the docs were written, or a repo not indexed by
unauthenticated GitHub search — my access here was unauthenticated `curl` +
`gh`-less API calls, which rate-limits code search entirely). **Next step
before Phase 1's machines package work starts: locate the current firmware
repo directly (ask upstream / check the exact repo the release binaries
attached to `Zer0-bit/gaggiuino`'s GitHub Releases are built from) and pull
the real `.proto` files from there.**

### Recommended path to `protoc-gen-go`-ready `.proto` files

In priority order:

1. **Get the real `.proto` files from upstream** (see caveat above) and run
   `protoc-gen-go` directly against them. This is the only option that's
   safe against subtle wire-format mistakes — a wrong scalar type or missed
   `repeated` flag in a hand-reconstructed schema doesn't just misname a
   JSON field, it can silently misdecode a binary payload (wrong varint
   width, wrong wire type entirely).
2. **Fallback — reconstruct by hand, cross-checked against two independent
   sources.** If upstream `.proto` files can't be found in time,
   `docs/rest-api/websocket.md` itself already contains hand-written
   ```protobuf``` code blocks with full field lists (name, number, type) for
   every `Dto` documented server→client and client→server — e.g.
   `SensorStateSnapshotDto`'s 34 fields, `ShotSnapshotDto`'s 10, `ProfileDto`
   and friends, `ServiceTestCommandDto`, etc. Combined with
   `lib/gaggiuino-proto.js`'s own field-number/wire-kind descriptors (already
   verified live for the profile CRUD messages per its header comment), these
   two sources can be cross-checked field-by-field to hand-write real `.proto`
   files with high confidence — much lower risk than either source alone.
   `google.protobuf`'s scalar-type numbering used by protobuf-ts's `T:`
   field (e.g. `T: 2` = float, `T: 8` = bool, `T: 9` = string, `T: 13` =
   uint32) maps directly to `.proto` scalar keywords.
3. Either way, generate with `protoc-gen-go` (`google.golang.org/protobuf`)
   once real `.proto` files exist — standard, low-risk, and gives Go the
   same wire-compatible bindings any other protobuf consumer would get.

This is squarely a Phase 1 (machines package) blocker, not a Phase 0 one —
flagging here so it's picked up before that package's implementation starts
rather than discovered mid-work.

## 2. Image generation: shot-card PNG + QR codes

### Current Node implementation

Shot-card PNG rendering (`GET /api/shots/{id}/card`, `lib/card.js`) uses
`@napi-rs/canvas` — a native (Rust/skia-based) `<canvas>`-API implementation
for Node, giving full 2D canvas drawing (gradients, rounded rects, text
layout/measurement, image compositing) at native speed. QR generation uses
the pure-JS `qrcode` npm package (referenced in the migration plan; not
directly inspected in this spike since it isn't part of the shot-card path
this repo currently ships — the plan lists it as an anticipated future need).

### `fogleman/gg` vs. Go's standard `image` package

- **`image` + `image/draw` + `image/png` (stdlib only):** gives you a raw
  pixel buffer, `draw.Draw` for compositing, and encoders — no path/shape
  drawing, no anti-aliasing, no text layout. Building the shot-card's rounded
  rects, gradients, and multi-line text from this alone means either hand-rolling
  scanline rasterization or pulling in `golang.org/x/image/vector` +
  `golang.org/x/image/font` + a face renderer (e.g. `golang.org/x/image/font/
  gofont` or a loaded TTF via `golang.org/x/image/font/opentype`) as separate
  pieces that don't share one coherent API.
- **`fogleman/gg`:** a `context.Context`-style 2D API on top of
  `golang.org/x/image/{vector,font,draw}` and `golang/freetype` — path
  building, fills/strokes, gradients, clipping, text drawing/measuring with
  a loaded TTF, image compositing, all through one `gg.Context`. This is
  the closer match to what `lib/card.js` already does with the canvas API
  (`ctx.fillRect`, `ctx.roundRect`, gradients via `createLinearGradient`,
  `ctx.fillText`) — porting the card layout logic is close to a 1:1
  translation of drawing calls rather than a redesign.
- Pure Go either way (no CGo, no native skia dependency) — both keep the
  "single static binary, no multi-arch rebuild pain" goal intact, unlike
  `@napi-rs/canvas`'s native bindings today.
- No head-to-head throughput benchmark between the two was found (searched;
  none exists as a maintained/public comparison) — for a single shot-card
  render per user request (not a hot loop), raw throughput is not the
  deciding factor here anyway.

**Recommendation: `fogleman/gg`.** The shot-card layout in `lib/card.js` is
built from exactly the primitives `gg.Context` provides directly; using the
stdlib alone would mean re-implementing (or vendoring) most of what `gg`
already wraps, for no benefit. `gg` is a small, dependency-light, widely-used
library (no known abandonment concerns as of this research) — reasonable to
add as the one graphics dependency.

> **Superseded (Phase 2f, #901).** The maintainer chose an SVG template +
> rasteriser over any `gg`-style immediate-mode canvas API: the card is
> assembled as an SVG string we fully control (`internal/shots/card_model.go`)
> and rendered to PNG by `github.com/kanrichan/resvg-go` — resvg 0.35
> compiled to wasm, run on `github.com/tetratelabs/wazero`, still pure Go /
> no cgo / single static binary. Fonts are `golang.org/x/image/font/gofont`
> (Go typeface; its `.TTF` bytes are already compiled into that package, and
> `fontdb` in the resvg wasm build has no woff2 support, so the bundled
> Fraunces serif can't be used — the bean headline falls back to bold Go
> sans, which is `lib/card.js`'s own `Fs()` fallback). Text metrics for
> wrap/centre come from `golang.org/x/image/font/opentype`. Binary size
> delta from adding all of this: ~+2.7 MB.

### `skip2/go-qrcode`

Well-known, small, pure-Go QR encoder — encode-only (no scanning/decoding),
outputs `image.Image` or PNG bytes directly, matches the npm `qrcode`
package's actual usage in this codebase (encode-only, generating a scannable
image, not reading one). One community-noted alternative,
`qpliu/qrencode-go` (ZXing-based), turned up in this spike's search but with
no evidence it's better-maintained or more capable for GLP's need (a single
QR encode, no exotic error-correction/format requirements) — no reason to
prefer it over `skip2/go-qrcode`'s simpler, more widely-adopted API.

**Recommendation: `skip2/go-qrcode`.** Matches current scope exactly, no
reason to look further unless a future requirement (e.g. custom logo overlay,
non-standard error-correction control) shows up that it can't do.

No implementation of either library happens in this Phase 0 package —
recorded here for the Phase 1/2 image-generation work to start from.
