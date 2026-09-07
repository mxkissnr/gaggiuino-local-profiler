// Package achievements is the Go port of the achievements ("stamp card")
// domain (Phase 2b, #901): lib/achievements/{registry,helpers,context,
// secrets}.js + lib/services/AchievementService.js + routes/achievements.js.
//
//	GET /api/achievements?lang=<de|en|it|fr|es|nl>
//	  -> { cards: CARD_KEYS, badges: <state for lang> }
//
// The `achievements` table is created by internal/db/db.go — this is a
// pure-logic port, no schema work.
//
// # File layout (mirrors the Node source)
//
//	registry.go    lib/achievements/registry.js — the 48 open + 6 secret
//	               badge catalogue and every check()/progress() predicate,
//	               plus CARD_KEYS.
//	helpers.go     lib/achievements/helpers.js — the pure math the checks
//	               share (stddev, pressure-plateau, bag-rest ages, day
//	               streaks, the maintenance clean-streak approximation).
//	context.go     lib/achievements/context.js — buildContext(): the single
//	               read snapshot every check runs against, gathered across
//	               ALL machines (per-install, not per-machine — see
//	               registry.go's header).
//	secrets.go     lib/achievements/secrets.js — the 6 secret badges'
//	               base64-obfuscated name/description text. Kept encoded
//	               server-side for the same reason the Node file states: it
//	               keeps the plaintext out of the shipped i18n bundle / a
//	               casual `grep`, and the bytes never reach a browser until
//	               the handler confirms the badge is unlocked.
//	repository.go  lib/repositories/AchievementRepository.js — thin (id,
//	               unlocked_at, progress) persistence.
//	service.go     lib/services/AchievementService.js — evaluateAll() +
//	               getState().
//	handlers.go    routes/achievements.js.
//
// # No event bus (deviation, documented)
//
// Node drives evaluateAll() from six bus events plus one boot sweep. This
// port has no event bus: GetState() runs a full evaluateAll(nil) pass
// before every read instead (evaluateAll early-returns the moment no badge
// is still locked, so a mostly-stamped install pays almost nothing). The
// four live-moment badges — first_profile, profile_edit, backup, restock —
// only ever unlock on their specific event and have no retroactive path in
// Node either; they stay permanently locked in this port until an event
// bus or explicit Service.EvaluateEvent call sites exist. See service.go's
// header comment.
//
// # up_to_date badge
//
// Reads internal/system's cached GitHub-release check
// (system.Handlers.CachedVersion — lib/version-check.js's getCached()) via
// the Deps.VersionFn callback cmd/server wires, not a direct import (same
// no-cross-domain-import discipline the rest of this rewrite keeps).
package achievements
