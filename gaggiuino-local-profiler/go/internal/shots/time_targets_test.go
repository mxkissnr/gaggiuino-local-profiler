package shots

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

func TestNormalizeProfileName(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"trims and lower-cases", "  Adaptive V2 ", "adaptive v2"},
		{"already normalized", "v60", "v60"},
		{"only whitespace", "   ", ""},
		{"empty", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizeProfileName(tc.input); got != tc.want {
				t.Fatalf("NormalizeProfileName(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestScoreProfileName_FallsBackToProfileName(t *testing.T) {
	cases := []struct {
		name string
		shot Shot
		want string
	}{
		{"top-level null falls back", Shot{"profileName": nil, "profile": map[string]any{"name": "Adaptive v2"}}, "Adaptive v2"},
		{"blank top-level falls back", Shot{"profileName": "  ", "profile": map[string]any{"name": "X"}}, "X"},
		{"top-level wins", Shot{"profileName": "Lever"}, "Lever"},
		{"neither name present", Shot{"machineId": int64(1)}, ""},
		{"profile is not an object", Shot{"profile": "Adaptive v2"}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := scoreProfileName(tc.shot); got != tc.want {
				t.Fatalf("scoreProfileName = %q, want %q", got, tc.want)
			}
		})
	}
}

func decodeTargets(t *testing.T, raw []byte) []ProfileTimeTarget {
	t.Helper()
	var targets []ProfileTimeTarget
	if err := json.Unmarshal(raw, &targets); err != nil {
		t.Fatalf("decoding %q: %v", raw, err)
	}
	if targets == nil {
		t.Fatalf("decoded a null array from %q; the API must serve []", raw)
	}
	return targets
}

func TestProfileTimeTargets_PutGetDelete(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	first := ProfileTimeTarget{ProfileName: "Adaptive v2", MinS: 40, MaxS: 48}

	t.Run("put stores the trimmed name", func(t *testing.T) {
		rec := doJSON(t, mux, http.MethodPut, "/api/profile-time-targets", []byte(`{"machineId":1,"profileName":" Adaptive v2 ","minS":40,"maxS":48}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("PUT status = %d, body %s", rec.Code, rec.Body.Bytes())
		}
		targets := decodeTargets(t, rec.Body.Bytes())
		if len(targets) != 1 || targets[0] != first {
			t.Fatalf("PUT returned %+v", targets)
		}
	})

	t.Run("get returns the machine list", func(t *testing.T) {
		rec := doJSON(t, mux, http.MethodGet, "/api/profile-time-targets?machineId=1", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET status = %d, body %s", rec.Code, rec.Body.String())
		}
		targets := decodeTargets(t, rec.Body.Bytes())
		if len(targets) != 1 || targets[0] != first {
			t.Fatalf("GET returned %+v", targets)
		}
	})

	t.Run("another machine is empty", func(t *testing.T) {
		rec := doJSON(t, mux, http.MethodGet, "/api/profile-time-targets?machineId=2", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET other machine status = %d", rec.Code)
		}
		if got := decodeTargets(t, rec.Body.Bytes()); len(got) != 0 {
			t.Fatalf("other machine returned %+v, want []", got)
		}
	})

	t.Run("put matches case-insensitively and replaces", func(t *testing.T) {
		rec := doJSON(t, mux, http.MethodPut, "/api/profile-time-targets", []byte(`{"machineId":1,"profileName":"adaptive V2","minS":38,"maxS":46}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("replacing PUT status = %d, body %s", rec.Code, rec.Body.Bytes())
		}
		targets := decodeTargets(t, rec.Body.Bytes())
		want := ProfileTimeTarget{ProfileName: "adaptive V2", MinS: 38, MaxS: 46}
		if len(targets) != 1 || targets[0] != want {
			t.Fatalf("after replace: %+v", targets)
		}
	})

	t.Run("null window deletes the entry", func(t *testing.T) {
		rec := doJSON(t, mux, http.MethodPut, "/api/profile-time-targets", []byte(`{"machineId":1,"profileName":"Adaptive v2","minS":null,"maxS":null}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("deleting PUT status = %d, body %s", rec.Code, rec.Body.Bytes())
		}
		if got := decodeTargets(t, rec.Body.Bytes()); len(got) != 0 {
			t.Fatalf("after delete: %+v, want []", got)
		}
	})
}

func TestProfileTimeTargets_Validation(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	cases := []struct {
		name string
		body string
	}{
		{"min below the floor", `{"machineId":1,"profileName":"V60","minS":4,"maxS":40}`},
		{"max above the ceiling", `{"machineId":1,"profileName":"V60","minS":40,"maxS":301}`},
		{"min equals max", `{"machineId":1,"profileName":"V60","minS":40,"maxS":40}`},
		{"fractional min", `{"machineId":1,"profileName":"V60","minS":40.5,"maxS":48}`},
		{"only min set", `{"machineId":1,"profileName":"V60","minS":40}`},
		{"blank profile name", `{"machineId":1,"profileName":"   ","minS":40,"maxS":48}`},
		{"machine id zero", `{"machineId":0,"profileName":"V60","minS":40,"maxS":48}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doJSON(t, mux, http.MethodPut, "/api/profile-time-targets", []byte(tc.body))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("PUT %s status = %d, want 400 (body %s)", tc.body, rec.Code, rec.Body.Bytes())
			}
			var payload struct {
				Error  string            `json:"error"`
				Issues []ValidationIssue `json:"issues"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decoding %q: %v", rec.Body.Bytes(), err)
			}
			if payload.Error != "Validation failed" || len(payload.Issues) == 0 {
				t.Fatalf("PUT %s body = %s, want a Validation failed issue list", tc.body, rec.Body.Bytes())
			}
		})
	}

	t.Run("rejected puts leave the store untouched", func(t *testing.T) {
		stored, err := h.repo.GetProfileTimeTargets()
		if err != nil {
			t.Fatalf("GetProfileTimeTargets: %v", err)
		}
		if len(stored) != 0 {
			t.Fatalf("rejected PUTs wrote the store: %+v", stored)
		}
	})

	t.Run("get without machine id", func(t *testing.T) {
		rec := doJSON(t, mux, http.MethodGet, "/api/profile-time-targets", nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("GET without machineId status = %d, want 400", rec.Code)
		}
	})
}

func TestLoadTimeTargetLookup_PerMachineCaseInsensitive(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	if err := repo.SaveProfileTimeTargets(map[string][]ProfileTimeTarget{
		"1": {{ProfileName: "V60", MinS: 40, MaxS: 48}},
	}); err != nil {
		t.Fatalf("SaveProfileTimeTargets: %v", err)
	}
	lookup := repo.loadTimeTargetLookup()
	want := TimeTarget{MinS: 40, MaxS: 48}

	cases := []struct {
		name string
		shot Shot
		want *TimeTarget
	}{
		{"case and space insensitive on the right machine", Shot{"machineId": int64(1), "profileName": " v60 "}, &want},
		{"same name on another machine", Shot{"machineId": int64(2), "profileName": " v60 "}, nil},
		{"falls back to profile.name", Shot{"machineId": int64(1), "profileName": nil, "profile": map[string]any{"name": "V60"}}, &want},
		{"shot without a name", Shot{"machineId": int64(1)}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := lookup(tc.shot)
			switch {
			case tc.want == nil && got != nil:
				t.Fatalf("lookup = %+v, want nil", got)
			case tc.want != nil && (got == nil || *got != *tc.want):
				t.Fatalf("lookup = %+v, want %+v", got, *tc.want)
			}
		})
	}
}

func TestSanitizeProfileTimeTargetsForRestore(t *testing.T) {
	t.Run("valid blob round-trips trimmed", func(t *testing.T) {
		valid := map[string]any{
			"1": []any{
				map[string]any{"profileName": " V60 ", "minS": float64(40), "maxS": float64(48)},
				map[string]any{"profileName": "lever", "minS": float64(25), "maxS": float64(30)},
			},
		}
		out, ok := SanitizeProfileTimeTargetsForRestore(valid)
		if !ok {
			t.Fatal("valid blob rejected")
		}
		if list := out["1"]; len(list) != 2 || list[0] != (ProfileTimeTarget{ProfileName: "V60", MinS: 40, MaxS: 48}) {
			t.Fatalf("sanitized = %+v", out)
		}
	})

	invalid := []struct {
		name string
		blob any
	}{
		{"inverted window", map[string]any{"1": []any{map[string]any{"profileName": "V60", "minS": float64(50), "maxS": float64(40)}}}},
		{"machine key is not a number", map[string]any{"abc": []any{map[string]any{"profileName": "V60", "minS": float64(40), "maxS": float64(48)}}}},
		{"list is not an array", map[string]any{"1": "not-an-array"}},
		{"blob is not an object", []any{}},
	}
	for _, tc := range invalid {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := SanitizeProfileTimeTargetsForRestore(tc.blob); ok {
				t.Fatalf("blob %+v accepted, want rejection", tc.blob)
			}
		})
	}
}

// The helpers below (#1504) are the store's scoring lookup and the
// restore sanitiser. Nothing in the production binary reaches them yet — the
// blocking deadcode gate builds ./cmd/... and the slices that call them (the
// scorer, and backup restore) land later — so they stay test-local under
// their planned production names, exactly as card.go's Fraunces helpers did
// for #2166. Moving the blocks back into time_targets.go unchanged is all
// those slices need.

// timeTargetErrOnce logs a failing store only once — a DB read error would
// otherwise print on every scored shot without ever being actionable.
var timeTargetErrOnce sync.Once

// scoreProfileName is the profile name a shot was brewed with: the top-level
// profileName when non-empty after trimming, otherwise profile.name.
// Gaggiuino history shots carry profileName: null and name the profile only
// in profile.name.
func scoreProfileName(shot Shot) string {
	if name, ok := shot["profileName"].(string); ok && strings.TrimSpace(name) != "" {
		return name
	}
	if profile, ok := shot["profile"].(map[string]any); ok {
		if name, ok := profile["name"].(string); ok {
			return name
		}
	}
	return ""
}

// wholeSeconds reads one already-decoded JSON value as a whole number of
// seconds. ok is false for anything that is not a finite whole number.
func wholeSeconds(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok || !isJSONInt(f) || f < -1e9 || f > 1e9 {
		return 0, false
	}
	return int(f), true
}

// SanitizeProfileTimeTargetsForRestore validates an untrusted
// profile_time_targets blob (e.g. one carried in a restored backup bundle)
// and field-picks the known keys, returning ok=false when anything is off so
// the caller can leave the stored windows untouched. SaveProfileTimeTargets
// itself does no validation and a restored bundle is untrusted input, so the
// restore path must go through here.
func SanitizeProfileTimeTargetsForRestore(v any) (map[string][]ProfileTimeTarget, bool) {
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	out := make(map[string][]ProfileTimeTarget, len(obj))
	for machine, raw := range obj {
		id, err := strconv.ParseInt(machine, 10, 64)
		if err != nil || id < 1 {
			return nil, false
		}
		entries, ok := raw.([]any)
		if !ok || len(entries) > maxTimeTargetsPerMachine {
			return nil, false
		}
		list := make([]ProfileTimeTarget, 0, len(entries))
		seen := make(map[string]int, len(entries)) // normalized name → index in list
		for _, rawEntry := range entries {
			entry, ok := rawEntry.(map[string]any)
			if !ok {
				return nil, false
			}
			name, ok := entry["profileName"].(string)
			if !ok {
				return nil, false
			}
			name = strings.TrimSpace(name)
			if name == "" || utf8.RuneCountInString(name) > maxProfileNameRunes {
				return nil, false
			}
			minS, minOK := wholeSeconds(entry["minS"])
			maxS, maxOK := wholeSeconds(entry["maxS"])
			if !minOK || !maxOK || !validTimeWindow(minS, maxS) {
				return nil, false
			}
			target := ProfileTimeTarget{ProfileName: name, MinS: minS, MaxS: maxS}
			if i, dup := seen[NormalizeProfileName(name)]; dup {
				list[i] = target
				continue
			}
			seen[NormalizeProfileName(name)] = len(list)
			list = append(list, target)
		}
		out[machine] = list
	}
	return out, true
}

// loadTimeTargetLookup reads the stored windows once and returns a per-shot
// lookup over that snapshot. A read error yields a lookup that always returns
// nil — the shot is handled exactly as without a window, and the request
// never fails over a target-time problem.
func (r *Repository) loadTimeTargetLookup() func(Shot) *TimeTarget {
	none := func(Shot) *TimeTarget { return nil }
	stored, err := r.GetProfileTimeTargets()
	if err != nil {
		timeTargetErrOnce.Do(func() {
			log.Printf("shots: profile time targets unavailable, scoring against the generic band: %v", err)
		})
		return none
	}
	lookup := make(map[int64]map[string]TimeTarget, len(stored))
	for machine, list := range stored {
		id, err := strconv.ParseInt(machine, 10, 64)
		if err != nil || id < 1 {
			continue
		}
		byName := make(map[string]TimeTarget, len(list))
		for _, target := range list {
			if !validTimeWindow(target.MinS, target.MaxS) {
				continue
			}
			byName[NormalizeProfileName(target.ProfileName)] = TimeTarget{MinS: target.MinS, MaxS: target.MaxS}
		}
		if len(byName) > 0 {
			lookup[id] = byName
		}
	}
	return func(shot Shot) *TimeTarget {
		name := NormalizeProfileName(scoreProfileName(shot))
		if name == "" {
			return nil
		}
		target, ok := lookup[shot.machineID()][name]
		if !ok {
			return nil
		}
		return &target
	}
}
