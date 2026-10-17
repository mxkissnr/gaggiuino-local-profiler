// Package shots implements the shot-history domain: the REST endpoints
// (list/last/defaults/detail/card/annotate/trash/restore/delete/image), shot
// scoring, the annotation/trash/blocklist logic, and the shot/defaults DB
// access.
//
// GET /api/shots/:id/card renders the share-card PNG (see card.go /
// card_model.go / card_palette.go): an SVG template rasterised with a
// cgo-free resvg-wasm renderer, with a short list of deliberate cosmetic
// deviations documented in card.go's header (no frozen LEGACY_GLP layout, no
// shot-photo/icon.png, Go-font metrics). It also carries one behavioral
// tightening: a dedicated "card:<ip>" feature rate limit
// (cardRateLimitPerMin, 30/min) on top of the app-wide 600/min backstop — the
// resvg-wasm render is a measured concurrency hot-spot (#977), so this
// package limits it. See handlers.go's getCard and #999 / security audit #977
// round 3 finding 3.2.
//
// The #450 bean-target score and the #456 low-stock notification need
// internal/library, which this package cannot import: cmd/server installs
// them as hooks (library.ScoreBean via the score path, the low-stock check
// via SetAnnotationSavedHook).
//
// See openapi.yaml's Shots tag for the response-shape contract.
package shots
