package shots

// This file implements the optional per-profile target time window (#1504):
// a min/max extraction time in whole seconds, keyed by machine and profile
// name. Nothing scores against it yet — this is the store and the REST API.
// The whole store is one JSON blob under kv.key = 'profile_time_targets',
// shaped {"<machineId>": [{"profileName": "...", "minS": 40, "maxS": 48}]},
// following the shot-defaults precedent in defaults.go. It deliberately does
// not live in machine_profiles: those rows are pruned by sync and their body
// belongs to the machine.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

const profileTimeTargetsKey = "profile_time_targets"

// Limits shared by the PUT handler and the restore sanitiser.
const (
	minTimeTargetS           = 5
	maxTimeTargetS           = 300
	maxProfileNameRunes      = 200
	maxTimeTargetsPerMachine = 200
)

// TimeTarget is a per-profile extraction-time window in whole seconds.
type TimeTarget struct{ MinS, MaxS int }

// ProfileTimeTarget is one stored window, as served by the API.
type ProfileTimeTarget struct {
	ProfileName string `json:"profileName"`
	MinS        int    `json:"minS"`
	MaxS        int    `json:"maxS"`
}

// timeTargetsMu serialises the PUT handler's read-merge-write over the kv row.
var timeTargetsMu sync.Mutex

// NormalizeProfileName is the one profile-name comparison key: trimmed and
// lower-cased. Matching is per machine and case-insensitive.
func NormalizeProfileName(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func validTimeWindow(minS, maxS int) bool {
	return minS >= minTimeTargetS && minS < maxS && maxS <= maxTimeTargetS
}

// GetProfileTimeTargets returns the stored windows per machine. A missing row
// or malformed JSON reads as an empty map rather than an error — the store is
// a best-effort cache, like ui-prefs.
func (r *Repository) GetProfileTimeTargets() (map[string][]ProfileTimeTarget, error) {
	out := map[string][]ProfileTimeTarget{}
	var value string
	err := r.db.QueryRow(`SELECT value FROM kv WHERE key = ?`, profileTimeTargetsKey).Scan(&value)
	if err == sql.ErrNoRows {
		return out, nil
	}
	if err != nil {
		return nil, fmt.Errorf("shots: reading profile time targets: %w", err)
	}
	var stored map[string][]ProfileTimeTarget
	if err := json.Unmarshal([]byte(value), &stored); err != nil || stored == nil {
		return out, nil
	}
	for machine, list := range stored {
		if len(list) > 0 {
			out[machine] = list
		}
	}
	return out, nil
}

// SaveProfileTimeTargets replaces the stored windows. Callers pass sanitized
// data — Save itself does no validation (mirrors SaveShotDefaults).
func (r *Repository) SaveProfileTimeTargets(m map[string][]ProfileTimeTarget) error {
	clean := make(map[string][]ProfileTimeTarget, len(m))
	for machine, list := range m {
		if len(list) > 0 {
			clean[machine] = list
		}
	}
	b, err := json.Marshal(clean)
	if err != nil {
		return fmt.Errorf("shots: encoding profile time targets: %w", err)
	}
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, profileTimeTargetsKey, string(b)); err != nil {
		return fmt.Errorf("shots: saving profile time targets: %w", err)
	}
	return nil
}

// sortedTimeTargets returns a copy of list ordered by normalized profile name,
// never nil, so the API always answers with an array.
func sortedTimeTargets(list []ProfileTimeTarget) []ProfileTimeTarget {
	out := make([]ProfileTimeTarget, len(list))
	copy(out, list)
	sort.SliceStable(out, func(i, j int) bool {
		return NormalizeProfileName(out[i].ProfileName) < NormalizeProfileName(out[j].ProfileName)
	})
	return out
}

// getProfileTimeTargets serves GET /api/profile-time-targets?machineId=N.
func (h *Handlers) getProfileTimeTargets(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.URL.Query().Get("machineId"), 10, 64)
	if err != nil || id < 1 {
		writeError(w, http.StatusBadRequest, "machineId is required")
		return
	}
	stored, err := h.repo.GetProfileTimeTargets()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, sortedTimeTargets(stored[strconv.FormatInt(id, 10)]))
}

// bodyTimeTargetS reads body[key] as an optional whole-second value.
// present is false for an absent or null key; ok is false for anything that
// is not a whole JSON number.
func bodyTimeTargetS(body map[string]any, key string) (value int, present, ok bool) {
	raw, exists := body[key]
	if !exists || raw == nil {
		return 0, false, true
	}
	f, isNum := raw.(float64)
	if !isNum || !isJSONInt(f) || f < -1e9 || f > 1e9 {
		return 0, true, false
	}
	return int(f), true, true
}

// putProfileTimeTarget serves PUT /api/profile-time-targets: one profile's
// window for one machine, upserted or (with both minS and maxS null) deleted.
func (h *Handlers) putProfileTimeTarget(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}

	var issues []ValidationIssue
	var machineID int64
	if f, isNum := body["machineId"].(float64); !isNum || !isJSONInt(f) || f < 1 || f > float64(1<<53) {
		issues = append(issues, ValidationIssue{"machineId", "expected a whole number of at least 1"})
	} else {
		machineID = int64(f)
	}

	name := ""
	if raw, exists := body["profileName"]; exists {
		if s, isString := raw.(string); isString {
			name = strings.TrimSpace(s)
		}
	}
	if n := utf8.RuneCountInString(name); n < 1 || n > maxProfileNameRunes {
		issues = append(issues, ValidationIssue{"profileName", fmt.Sprintf("String must contain between 1 and %d character(s)", maxProfileNameRunes)})
	}

	minS, minSet, minOK := bodyTimeTargetS(body, "minS")
	maxS, maxSet, maxOK := bodyTimeTargetS(body, "maxS")
	switch {
	case !minOK:
		issues = append(issues, ValidationIssue{"minS", "expected a whole number of seconds"})
	case !maxOK:
		issues = append(issues, ValidationIssue{"maxS", "expected a whole number of seconds"})
	case minSet != maxSet:
		issues = append(issues, ValidationIssue{"minS", "set both minS and maxS, or neither"})
	case minSet && !validTimeWindow(minS, maxS):
		issues = append(issues, ValidationIssue{"minS", fmt.Sprintf("expected %d <= minS < maxS <= %d", minTimeTargetS, maxTimeTargetS)})
	}
	if len(issues) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Validation failed", "issues": issues})
		return
	}

	key := strconv.FormatInt(machineID, 10)
	timeTargetsMu.Lock()
	defer timeTargetsMu.Unlock()

	stored, err := h.repo.GetProfileTimeTargets()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	list := stored[key]
	normalized := NormalizeProfileName(name)
	match := -1
	for i, target := range list {
		if NormalizeProfileName(target.ProfileName) == normalized {
			match = i
			break
		}
	}
	if !minSet {
		if match >= 0 {
			list = append(list[:match], list[match+1:]...)
		}
	} else {
		target := ProfileTimeTarget{ProfileName: name, MinS: minS, MaxS: maxS}
		if match >= 0 {
			list[match] = target
		} else {
			if len(list) >= maxTimeTargetsPerMachine {
				writeJSON(w, http.StatusBadRequest, map[string]any{
					"error":  "Validation failed",
					"issues": []ValidationIssue{{"profileName", fmt.Sprintf("at most %d target times per machine", maxTimeTargetsPerMachine)}},
				})
				return
			}
			list = append(list, target)
		}
	}
	stored[key] = list
	if err := h.repo.SaveProfileTimeTargets(stored); err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, sortedTimeTargets(list))
}
