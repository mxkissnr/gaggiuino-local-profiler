// Package proto is the wire schema for the Gaggiuino machine's binary
// WebSocket protocol (real Protocol Buffers, confirmed against the upstream
// docs' WebSocket section, docs/rest-api/websocket.md). It defines every
// message type the protocol uses, plus a hand-written binary
// encoder/decoder for each — not generated code.
//
// # Why hand-written instead of protoc-gen-go
//
// The blocker this package starts from: no `.proto` source files exist in
// this repo or in any branch/tag of the firmware repo
// that could be located — the firmware is closed-source and its message
// definitions were "reconstructed field-for-field from the machine's own
// web UI bundle... and verified live against a real machine" (profile
// CRUD), with a documented subset
// transcribed from Gaggiuino's own published API docs (#597, sensor/
// system-state/command messages). The recommended fallback — cross-check
// the two independent sources (the published websocket.md doc's inline
// schema blocks and the reconstructed field descriptors) field-by-field —
// is what schema.proto below records the result of.
//
// schema.proto is written in real, syntactically valid proto3, so
// wire-compatible bindings could be generated from it, but the structs and
// Marshal/Unmarshal methods in messages.go are hand-written against the
// same field numbers/wire types schema.proto documents, verified by:
//
//  1. wire_test.go's low-level encoder/decoder tests (varint, fixed32,
//     length-delimited framing) against manually computed byte sequences.
//  2. node_vectors_test.go's cross-validation against the former
//     implementation: testdata/node_vectors.json is a fixture frozen from
//     the pre-Go baseline (archived at tag archive/node-backend-final),
//     captured from the real @protobuf-ts/runtime-backed encoder/decoder the
//     app shipped before the rewrite (not a reimplementation) — {hex,
//     decoded} pairs for representative instances of every message type,
//     deliberately including zero-valued fields, populated nested messages,
//     and (for ProfileDto) a populated repeated field, since proto3's
//     default-value wire omission makes the zero-value case the one most
//     likely to hide an encoding bug. node_vectors_test.go decodes each hex
//     blob with this package's own Unmarshal and asserts the result matches
//     the recorded `decoded` JSON field-for-field, then re-encodes with this
//     package's own Marshal and asserts the output hex is byte-identical.
//     That encoder is gone, so this fixture is the frozen wire-format
//     reference.
//
// No live-hardware verification happens in this package's tests. See
// cmd/gaggiuino-ws-probe for a small CLI that makes that check a
// `go run` away instead of a from-scratch tool: point it at a real
// machine's ws:// URL and it dumps every decoded frame (with its raw hex)
// for exactly this kind of manual verification.
//
// # What's deliberately not modeled
//
// GaggiaSettingsDto (the REST-only settings payload) is not part of this
// package: the settings proxy (go/internal/machines's settings handlers)
// uses plain JSON over REST, not this binary protocol, and is treated as
// opaque JSON end-to-end specifically so the machine's inconsistent
// bool-as-string quirk (some settings fields are JSON `"true"`/`"false"`
// strings, not real JSON booleans — see go/internal/machines/doc.go) is
// never normalized away by a typed struct.
package proto
