// Package achievements implements the achievements ("stamp card") domain.
//
//	GET /api/achievements?lang=<de|en|it|fr|es|nl>
//	  -> { cards: CARD_KEYS, badges: <state for lang> }
//
// The `achievements` table is created by internal/db/db.go — this package is
// pure logic, no schema work.
//
// # File layout
//
//	registry.go    the 48 open + 6 secret badge catalogue and every
//	               check()/progress() predicate, plus CARD_KEYS.
//	helpers.go     the pure math the checks share (stddev,
//	               pressure-plateau, bag-rest ages, day streaks, the
//	               maintenance clean-streak approximation).
//	context.go     buildContext(): the single read snapshot every check
//	               runs against, gathered across ALL machines (per-install,
//	               not per-machine — see registry.go's header).
//	secrets.go     the 6 secret badges' base64-obfuscated name/description
//	               text. Kept encoded server-side because it keeps the
//	               plaintext out of the shipped i18n bundle / a casual
//	               `grep`, and the bytes never reach a browser until the
//	               handler confirms the badge is unlocked.
//	repository.go  thin (id, unlocked_at, progress) persistence.
//	service.go     evaluateAll() + getState().
//	handlers.go    the GET /api/achievements HTTP handler.
//
// # No event bus
//
// There is no event bus: GetState() runs a full evaluateAll(nil) pass before
// every read instead (evaluateAll early-returns the moment no badge is still
// locked, so a mostly-stamped install pays almost nothing), and cmd/server
// drives the four live-moment badges through explicit Service.EvaluateEvent
// calls -- machines.Handlers.SetOnProfileSaved runs after a profile
// create/update succeeds (first_profile/profile_edit, #1286 R1),
// backup.Handlers.SetOnExported after a successful export (backup), and
// library.Handlers.SetOnBeanRestocked after a new bag lands on an empty bean
// (restock, #1286 R2). See service.go's header comment.
//
// # up_to_date badge
//
// Reads internal/system's cached GitHub-release check
// (system.Handlers.CachedVersion) via the Deps.VersionFn callback cmd/server
// wires, not a direct import (the no-cross-domain-import discipline the rest
// of the codebase keeps).
package achievements
