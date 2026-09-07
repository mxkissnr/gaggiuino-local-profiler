package web

import (
	"fmt"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/web/templates"
)

// toShotRow builds a templates.ShotRow — a typed view struct instead of
// handing shots.Shot's bag-of-any map straight to templ, so a template
// typo (a renamed/missing key) fails at `go build` instead of silently
// rendering nothing. Field selection mirrors public-src/components/
// sidebar.js's _buildShotWrapper (Phase 2a's UI/UX reference, per the
// dispatch brief): profile name, score, coffee/dose, star rating, grind
// setting, time — not shot detail's full chart/annotation surface, which
// stays out of scope for this first template page. templates.ShotRow lives
// in the templates package (not here) so .templ files can reference its
// fields directly without this package importing back into templates.

// scoreClass ports public-src/utils.js's scoreClass: the same 3-tier
// >=90/>=70/else thresholds, single source of truth for shot-score color
// across every GLP frontend (Node and now this one).
func scoreClass(score int) string {
	switch {
	case score >= 90:
		return "score-great"
	case score >= 70:
		return "score-ok"
	default:
		return "score-bad"
	}
}

// formatDuration ports public-src/utils.js's formatTimeLabel(s): tenths of
// a second in, "MM:SS" out.
func formatDuration(tenths int64) string {
	secs := tenths / 10
	return fmt.Sprintf("%02d:%02d", secs/60, secs%60)
}

// annotationField reads a string field off shot["annotation"], mirroring
// the Node original's tolerance for a missing/non-object annotation (ann =
// shot.annotation || {}).
func annotationString(ann map[string]any, key string) string {
	v, _ := ann[key].(string)
	return v
}

func annotationInt(ann map[string]any, key string) int {
	switch v := ann[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
			return n
		}
	}
	return 0
}

// annotationDose formats ann["dose"] as "18.2 g", matching sidebar.js's
// `${parseFloat(ann.dose).toFixed(1)} g` — empty string if unset/not a
// number, same as sidebar.js's dose && ... guard.
func annotationDose(ann map[string]any) string {
	switch v := ann["dose"].(type) {
	case float64:
		return fmt.Sprintf("%.1f g", v)
	case string:
		var f float64
		if _, err := fmt.Sscanf(v, "%f", &f); err == nil && f > 0 {
			return fmt.Sprintf("%.1f g", f)
		}
	}
	return ""
}

// freshnessDays reads annotation.beanAgeDays — the bean's age in days at
// the moment this specific shot was pulled, computed and stored
// client-side when the shot was annotated (public-src/views/shots/
// annotation.js's calcBeanAgeAtShot; internal/shots has no server-side
// equivalent of that computation, it only stores whatever an annotate
// request submits — see internal/shots/doc.go). Unlike shot detail's own
// freshness badge (public-src/views/shots/index.js's renderShotDetail,
// which also falls back to computing "how fresh is this bean right now"
// from roastDate when beanAgeDays is unset — meaningful for one freshly
// selected shot), the Shots LIST spans many days of history, so a
// now-vs-roastDate fallback would mislabel an old row with today's
// freshness instead of the bean's age when that shot was actually pulled.
// This list only ever shows the stored beanAgeDays, a pragmatic, deliberate
// divergence from Node's single-shot logic — see go/README.md's badges
// section (#901, design pass 4 follow-up).
func freshnessDays(ann map[string]any) (int, bool) {
	switch v := ann["beanAgeDays"].(type) {
	case float64:
		return int(v), true
	case int64:
		return int(v), true
	case int:
		return v, true
	}
	return 0, false
}

// freshnessClass mirrors public-src/views/shots/index.js's own
// freshness-badge thresholds (<=21 fresh, <=35 ok, else old), mapped onto
// this rewrite's existing generic badge-ok/badge-warn/badge-err classes
// (style.css) instead of porting a parallel freshness-badge-only class
// family — same "reuse existing tokens" convention view_library.go's own
// stock-bar/badge helpers already follow.
func freshnessClass(days int) string {
	switch {
	case days <= 21:
		return "badge-ok"
	case days <= 35:
		return "badge-warn"
	default:
		return "badge-err"
	}
}

// orderedByLabel builds "Customer · Item · Variant · note" from
// shot["annotation"]["orderedBy"] — written by
// internal/orders.Service.CompleteOrder's read-modify-write onto the shot
// that order's queue-ETA matched against (see internal/shots/repository.go's
// GetAnnotation doc comment), mirroring public-src/views/shots/index.js's
// own orderedBy renderer's "item, or item · variant when both are set"
// drink-label construction.
func orderedByLabel(ann map[string]any) string {
	ob, _ := ann["orderedBy"].(map[string]any)
	customer, _ := ob["customer"].(string)
	if customer == "" {
		return ""
	}
	item, _ := ob["item"].(string)
	variant, _ := ob["variant"].(string)
	note, _ := ob["note"].(string)
	drink := item
	if item != "" && variant != "" {
		drink = item + " · " + variant
	}
	label := customer
	if drink != "" {
		label += " · " + drink
	}
	if note != "" {
		label += " · " + note
	}
	return label
}

// firmwareVersion reads shot["glpFirmwareVersion"] — a top-level field
// lib/sync.js's own shot-history sync engine stamps onto a synced shot
// (r.data.glpFirmwareVersion = state.cachedMachineVersion). That sync
// engine itself is out of this Go rewrite's scope (go/README.md's
// internal/system section: "lib/sync.js entirely ... its own future
// phase"), so this only ever renders a firmware badge for shots that
// already carry the field from before this server started handling them —
// a pass-through display, not a claim this rewrite computes the value
// itself.
func firmwareVersion(shot shots.Shot) string {
	v, _ := shot["glpFirmwareVersion"].(string)
	return v
}

// toShotRow builds a templates.ShotRow from a hydrated shots.Shot plus its
// pre-computed score — the Go-side equivalent of sidebar.js's
// _buildShotWrapper's field extraction.
func toShotRow(shot shots.Shot, score *int) templates.ShotRow {
	row := templates.ShotRow{}

	if id, ok := shot["id"].(int64); ok {
		row.ID = id
	}
	if ts, ok := shot["timestamp"].(int64); ok {
		// "02.01. 15:04": date + time, not just time-of-day — Phase B
		// (#901) widens this list from a same-day rail into a
		// potentially-many-days shot history, per the dispatch brief's
		// "Score, Datum, Sterne, Kaffeename" compact-row spec, so the
		// date itself has to be visible per row (the Node original's
		// day-separator headers, public-src/components/sidebar.js's
		// renderSidebar() groups, aren't ported here — out of scope for
		// this pass, a per-row date is a much smaller change).
		row.Time = time.Unix(ts, 0).Format("02.01. 15:04")
	}
	if pn, ok := shot["profileName"].(string); ok && pn != "" {
		row.ProfileName = pn
	} else {
		row.ProfileName = "Unknown Profile"
	}
	if dur, ok := shot["duration"].(int64); ok {
		row.Duration = formatDuration(dur)
	}
	row.Score = score
	if score != nil {
		row.ScoreClass = scoreClass(*score)
	}

	ann, _ := shot["annotation"].(map[string]any)
	if ann == nil {
		ann = map[string]any{}
	}
	row.Coffee = annotationString(ann, "coffee")
	row.Dose = annotationDose(ann)
	row.Rating = annotationInt(ann, "rating")
	row.GrindSetting = annotationString(ann, "grindSetting")
	row.Grinder = annotationString(ann, "grinder")

	if days, ok := freshnessDays(ann); ok && days >= 0 && days <= 365 {
		row.FreshnessLabel = fmt.Sprintf("%dd", days)
		row.FreshnessClass = freshnessClass(days)
	}
	row.OrderedBy = orderedByLabel(ann)
	row.FirmwareVersion = firmwareVersion(shot)

	return row
}
