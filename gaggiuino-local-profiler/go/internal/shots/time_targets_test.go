package shots

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestNormalizeProfileName(t *testing.T) {
	if got := NormalizeProfileName("  Adaptive V2 "); got != "adaptive v2" {
		t.Fatalf("NormalizeProfileName = %q, want %q", got, "adaptive v2")
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

	rec := doJSON(t, mux, http.MethodPut, "/api/profile-time-targets", []byte(`{"machineId":1,"profileName":" Adaptive v2 ","minS":40,"maxS":48}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body %s", rec.Code, rec.Body.Bytes())
	}
	targets := decodeTargets(t, rec.Body.Bytes())
	if len(targets) != 1 || targets[0] != (ProfileTimeTarget{ProfileName: "Adaptive v2", MinS: 40, MaxS: 48}) {
		t.Fatalf("PUT returned %+v", targets)
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/profile-time-targets?machineId=1", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body %s", rec.Code, rec.Body.String())
	}
	targets = decodeTargets(t, rec.Body.Bytes())
	if len(targets) != 1 || targets[0] != (ProfileTimeTarget{ProfileName: "Adaptive v2", MinS: 40, MaxS: 48}) {
		t.Fatalf("GET returned %+v", targets)
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/profile-time-targets?machineId=2", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET other machine status = %d", rec.Code)
	}
	if got := decodeTargets(t, rec.Body.Bytes()); len(got) != 0 {
		t.Fatalf("other machine returned %+v, want []", got)
	}

	rec = doJSON(t, mux, http.MethodPut, "/api/profile-time-targets", []byte(`{"machineId":1,"profileName":"adaptive V2","minS":38,"maxS":46}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("replacing PUT status = %d, body %s", rec.Code, rec.Body.Bytes())
	}
	targets = decodeTargets(t, rec.Body.Bytes())
	if len(targets) != 1 || targets[0] != (ProfileTimeTarget{ProfileName: "adaptive V2", MinS: 38, MaxS: 46}) {
		t.Fatalf("after replace: %+v", targets)
	}

	rec = doJSON(t, mux, http.MethodPut, "/api/profile-time-targets", []byte(`{"machineId":1,"profileName":"Adaptive v2","minS":null,"maxS":null}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("deleting PUT status = %d, body %s", rec.Code, rec.Body.Bytes())
	}
	if got := decodeTargets(t, rec.Body.Bytes()); len(got) != 0 {
		t.Fatalf("after delete: %+v, want []", got)
	}
}

func TestProfileTimeTargets_Validation(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	bad := []string{
		`{"machineId":1,"profileName":"V60","minS":4,"maxS":40}`,
		`{"machineId":1,"profileName":"V60","minS":40,"maxS":301}`,
		`{"machineId":1,"profileName":"V60","minS":40,"maxS":40}`,
		`{"machineId":1,"profileName":"V60","minS":40.5,"maxS":48}`,
		`{"machineId":1,"profileName":"V60","minS":40}`,
		`{"machineId":1,"profileName":"   ","minS":40,"maxS":48}`,
		`{"machineId":0,"profileName":"V60","minS":40,"maxS":48}`,
	}
	for _, body := range bad {
		rec := doJSON(t, mux, http.MethodPut, "/api/profile-time-targets", []byte(body))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("PUT %s status = %d, want 400 (body %s)", body, rec.Code, rec.Body.Bytes())
		}
		var payload struct {
			Error  string            `json:"error"`
			Issues []ValidationIssue `json:"issues"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decoding %q: %v", rec.Body.Bytes(), err)
		}
		if payload.Error != "Validation failed" || len(payload.Issues) == 0 {
			t.Fatalf("PUT %s body = %s, want a Validation failed issue list", body, rec.Body.Bytes())
		}
	}

	stored, err := h.repo.GetProfileTimeTargets()
	if err != nil {
		t.Fatalf("GetProfileTimeTargets: %v", err)
	}
	if len(stored) != 0 {
		t.Fatalf("rejected PUTs wrote the store: %+v", stored)
	}

	if rec := doJSON(t, mux, http.MethodGet, "/api/profile-time-targets", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("GET without machineId status = %d, want 400", rec.Code)
	}
}

func TestLoadTimeTargetLookup_PerMachineCaseInsensitive(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	if err := repo.SaveProfileTimeTargets(map[string][]ProfileTimeTarget{
		"1": {{ProfileName: "V60", MinS: 40, MaxS: 48}},
	}); err != nil {
		t.Fatalf("SaveProfileTimeTargets: %v", err)
	}
	lookup := repo.loadTimeTargetLookup()

	got := lookup(Shot{"machineId": int64(1), "profileName": " v60 "})
	if got == nil || *got != (TimeTarget{MinS: 40, MaxS: 48}) {
		t.Fatalf("machine 1 lookup = %+v, want {40 48}", got)
	}

	if got := lookup(Shot{"machineId": int64(2), "profileName": " v60 "}); got != nil {
		t.Fatalf("machine 2 lookup = %+v, want nil", got)
	}

	got = lookup(Shot{"machineId": int64(1), "profileName": nil, "profile": map[string]any{"name": "V60"}})
	if got == nil || *got != (TimeTarget{MinS: 40, MaxS: 48}) {
		t.Fatalf("profile.name lookup = %+v, want {40 48}", got)
	}

	if got := lookup(Shot{"machineId": int64(1)}); got != nil {
		t.Fatalf("nameless shot lookup = %+v, want nil", got)
	}
}

func TestSanitizeProfileTimeTargetsForRestore(t *testing.T) {
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

	invalid := []map[string]any{
		{"1": []any{map[string]any{"profileName": "V60", "minS": float64(50), "maxS": float64(40)}}},
		{"abc": []any{map[string]any{"profileName": "V60", "minS": float64(40), "maxS": float64(48)}}},
		{"1": "not-an-array"},
	}
	for _, blob := range invalid {
		if _, ok := SanitizeProfileTimeTargetsForRestore(blob); ok {
			t.Fatalf("blob %+v accepted, want rejection", blob)
		}
	}
}
