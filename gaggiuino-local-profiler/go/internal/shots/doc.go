// Package shots implements the shot-history domain: the REST endpoints
// (list/last/defaults/detail/card/annotate/trash/restore/delete/image), shot
// scoring, the annotation/trash/blocklist logic, and the shot/defaults DB
// access — the first REST domain to go the full HTTP-request -> handler ->
// internal/db -> response path, per go/README.md's Status section.
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
// Still deliberately not implemented, documented at its stub site rather than
// silently missing:
//
//   - The #450 bean-target score enhancement and the #456 low-stock
//     notification annotate() fires — both need internal/library
//     (resolveBeanForAnnotation), which is still a placeholder. See
//     service.go's ComputeScoreDetail and handlers.go's annotate doc comments.
//
// See openapi.yaml's Shots tag for the frozen response-shape contract; where
// this package and the OpenAPI doc disagree on a status code actually returned
// (e.g. POST .../trash's 404 on a missing shot, absent from openapi.yaml but
// present in the handler), this package follows the real behavior, not the doc.
package shots
