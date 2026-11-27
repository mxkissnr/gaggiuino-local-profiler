package backup

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// Shot ids and timestamps the leak test searches the file for.
const (
	donationGaggiuinoShotID = int64(987654321)
	donationGaggiMateShotID = int64(987654322)
	donationShotTimestamp   = int64(1700000123)
)

// seedDonationFixture seeds a library bean, a GaggiMate machine, a rated
// Gaggiuino shot with every free-text field filled, a rated GaggiMate shot,
// an unrated shot and a shot rated 0. It returns the GaggiMate machine id.
func seedDonationFixture(t *testing.T, deps Dependencies) int64 {
	t.Helper()
	if err := deps.Registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	name, typ, host := "SECRET-MACHINE", "gaggimate", "SECRET-HOST.local"
	gm, err := deps.Registry.CreateMachine(machines.MachineInput{Name: &name, Type: &typ, Host: &host})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	if err := deps.LibRepo.SaveLibrary(library.Library{Beans: []library.Entity{{
		"id": int64(1), "name": "SECRET-BEAN", "roaster": "SECRET-ROASTER",
		"notes": "SECRET-BEAN-NOTES", "roastLevel": "medium", "roastDate": "2026-01-02",
	}}}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	series := func() []any {
		return []any{float64(0), float64(10), float64(20), float64(30), float64(40), float64(50)}
	}
	seed := func(id, machineID int64, extra map[string]any, ann map[string]any) {
		shot := shots.Shot{
			"id": id, "timestamp": donationShotTimestamp, "duration": int64(300),
			"profileName": "SECRET-PROFILE", "machineId": machineID, "image": "jpg",
			"datapoints": map[string]any{
				"timeInShot": series(), "pressure": series(), "shotWeight": series(),
				"phaseIndex": []any{float64(0), float64(0), float64(1), float64(1), nil, "x"},
				"phaseTransitions": []any{map[string]any{
					"t": float64(10), "phase": float64(1), "name": "SECRET-TRANSITION", "reason": float64(2),
				}},
				"finalExitReason":   float64(3),
				"bleScaleConnected": true,
			},
		}
		for k, v := range extra {
			shot[k] = v
		}
		if err := deps.ShotsRepo.Upsert(shot); err != nil {
			t.Fatalf("Upsert %d: %v", id, err)
		}
		if ann != nil {
			if err := deps.ShotsRepo.SaveAnnotation(id, ann); err != nil {
				t.Fatalf("SaveAnnotation %d: %v", id, err)
			}
		}
	}
	seed(donationGaggiuinoShotID, 1, map[string]any{"profile": map[string]any{
		"id": float64(77), "name": "SECRET-PROFILE",
		"phases": []any{map[string]any{
			"name": "SECRET-PHASE", "type": "FLOW", "restriction": float64(3),
			"target":         map[string]any{"curve": "INSTANT", "end": float64(7)},
			"stopConditions": map[string]any{"time": float64(20000)},
		}},
		"recipe":           map[string]any{"coffeeIn": float64(18), "coffeeOut": float64(36)},
		"waterTemperature": float64(93),
	}}, map[string]any{
		"rating": float64(4), "beanId": float64(1), "coffee": "SECRET-BEAN",
		"grinder": "SECRET-GRINDER", "grindSetting": "SECRET-GRIND", "notes": "SECRET-NOTES",
		"drinkType": "m_SECRET", "dose": float64(18), "tds": float64(9.5),
		"beanAgeDays": float64(12), "roastDate": "2026-01-02", "tasteTag": "sour",
	})
	seed(donationGaggiMateShotID, gm.ID, nil, map[string]any{"rating": float64(3), "drinkType": "espresso", "tasteTag": "astringent"})
	seed(987654323, 1, nil, nil)
	seed(987654324, 1, nil, map[string]any{"rating": float64(0)})
	return gm.ID
}

// getDonation GETs /api/shot-donation with the query and decodes the file.
func getDonation(t *testing.T, mux *http.ServeMux, query string) (donationFile, string) {
	t.Helper()
	rec := doJSON(t, mux, http.MethodGet, "/api/shot-donation"+query, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/shot-donation%s = %d; body=%s", query, rec.Code, rec.Body.String())
	}
	var f donationFile
	if err := json.Unmarshal(rec.Body.Bytes(), &f); err != nil {
		t.Fatalf("decoding donation: %v", err)
	}
	return f, rec.Body.String()
}

func donationKeys(f donationFile) map[string]bool {
	keys := map[string]bool{}
	for _, s := range f.Shots {
		keys[s.Key] = true
	}
	return keys
}

func TestShotDonation_RatedShotsOnly(t *testing.T) {
	h, deps, _ := newTestHandlers(t)
	seedDonationFixture(t, deps)
	f, body := getDonation(t, newMux(h), "")
	if f.Format != "glp-shot-donation" || f.Version != 1 || f.AppVersion == "" || len(f.DonationID) != 16 {
		t.Fatalf("envelope = %+v", f)
	}
	if len(f.Shots) != 2 {
		t.Fatalf("shots = %d, want 2 (rated 1-5 only)", len(f.Shots))
	}
	ratings := map[int]bool{}
	for _, s := range f.Shots {
		ratings[s.Annotation.Rating] = true
	}
	if !ratings[4] || !ratings[3] {
		t.Errorf("ratings = %v, want 4 and 3", ratings)
	}
	for _, banned := range []string{"SECRET", "987654321", "1700000123", "timestamp"} {
		if strings.Contains(body, banned) {
			t.Errorf("donation file contains %q", banned)
		}
	}
}

func TestShotDonation_SinceFilter(t *testing.T) {
	h, deps, _ := newTestHandlers(t)
	seedDonationFixture(t, deps)
	mux := newMux(h)
	if f, body := getDonation(t, mux, "?since=2099-01-01"); len(f.Shots) != 0 || !strings.Contains(body, `"shots":[]`) {
		t.Errorf("future since: shots = %d, body %s", len(f.Shots), body)
	}
	if f, _ := getDonation(t, mux, "?since=2020-01-01"); len(f.Shots) != 2 {
		t.Errorf("past since: shots = %d, want 2", len(f.Shots))
	}
	if rec := doJSON(t, mux, http.MethodGet, "/api/shot-donation?since=bad", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("bad since = %d, want 400", rec.Code)
	}
}

func TestShotDonation_KeysStableAcrossExports(t *testing.T) {
	h, deps, _ := newTestHandlers(t)
	seedDonationFixture(t, deps)
	mux := newMux(h)
	a, _ := getDonation(t, mux, "")
	b, _ := getDonation(t, mux, "")
	if a.DonationID != b.DonationID {
		t.Errorf("donationId changed: %s vs %s", a.DonationID, b.DonationID)
	}
	ka, kb := donationKeys(a), donationKeys(b)
	if len(ka) != 2 || len(ka) != len(kb) {
		t.Fatalf("keys = %v vs %v", ka, kb)
	}
	for k := range ka {
		if !kb[k] || len(k) != 16 {
			t.Errorf("key %q not stable or not 16 hex chars", k)
		}
	}
}

func TestShotDonation_KeysDifferAcrossInstalls(t *testing.T) {
	h1, deps1, _ := newTestHandlers(t)
	seedDonationFixture(t, deps1)
	h2, deps2, _ := newTestHandlersInDir(t)
	seedDonationFixture(t, deps2)
	a, _ := getDonation(t, newMux(h1), "")
	b, _ := getDonation(t, newMux(h2), "")
	if a.DonationID == b.DonationID {
		t.Errorf("two installs share donationId %s", a.DonationID)
	}
	kb := donationKeys(b)
	for k := range donationKeys(a) {
		if kb[k] {
			t.Errorf("shot key %s repeats across installs", k)
		}
	}
}

func TestShotDonation_SecretNeverInBackup(t *testing.T) {
	h1, deps1, sqlDB := newTestHandlers(t)
	seedDonationFixture(t, deps1)
	mux1 := newMux(h1)
	first, _ := getDonation(t, mux1, "")
	var stored string
	if err := sqlDB.QueryRow(`SELECT value FROM kv WHERE key = 'donation_secret'`).Scan(&stored); err != nil {
		t.Fatalf("reading stored secret: %v", err)
	}
	secretHex := strings.Trim(stored, `"`)
	rec := doJSON(t, mux1, http.MethodGet, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("backup = %d", rec.Code)
	}
	exported := rec.Body.Bytes()
	if strings.Contains(string(exported), "donation_secret") || strings.Contains(string(exported), secretHex) {
		t.Fatal("backup carries the donation secret")
	}
	h2, _, _ := newTestHandlersInDir(t)
	mux2 := newMux(h2)
	if rec := doJSON(t, mux2, http.MethodPost, "/api/restore", exported); rec.Code != http.StatusOK {
		t.Fatalf("restore = %d; body=%s", rec.Code, rec.Body.String())
	}
	second, _ := getDonation(t, mux2, "")
	if second.DonationID == first.DonationID {
		t.Error("restored install reuses the donation id of the source install")
	}
}

func TestShotDonation_RateLimited(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	for i := 0; i < donationRateLimitPerMin; i++ {
		if rec := doJSON(t, mux, http.MethodGet, "/api/shot-donation", nil); rec.Code != http.StatusOK {
			t.Fatalf("request %d = %d", i+1, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/shot-donation", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("request %d = %d, want 429", donationRateLimitPerMin+1, rec.Code)
	}
}

// Slice 2 (#2220): datapoints, annotation values, profile structure and key,
// machine type and scores.

func TestShotDonation_LeaksNoFreeTextOrIDs(t *testing.T) {
	h, deps, _ := newTestHandlers(t)
	seedDonationFixture(t, deps)
	_, body := getDonation(t, newMux(h), "")
	for _, banned := range []string{
		"SECRET", "987654321", "987654322", "1700000123", "2026-01-02", "jpg",
		`"name"`, `"id"`, "machineId", "timestamp", "test-token-value",
	} {
		if strings.Contains(body, banned) {
			t.Errorf("donation file contains %q:\n%s", banned, body)
		}
	}
}

func TestShotDonation_AnnotationValues(t *testing.T) {
	h, deps, _ := newTestHandlers(t)
	seedDonationFixture(t, deps)
	f, _ := getDonation(t, newMux(h), "")
	if f.Format != "glp-shot-donation" || f.Version != 1 || len(f.DonationID) != 16 {
		t.Fatalf("envelope = %+v", f)
	}
	if len(f.Shots) != 2 {
		t.Fatalf("shots = %d, want 2 (rated 1-5 only)", len(f.Shots))
	}
	var gaggiuino, gaggimate *donationShot
	for i := range f.Shots {
		switch f.Shots[i].Annotation.Rating {
		case 4:
			gaggiuino = &f.Shots[i]
		case 3:
			gaggimate = &f.Shots[i]
		}
	}
	if gaggiuino == nil || gaggimate == nil {
		t.Fatalf("missing shots: %+v", f.Shots)
	}
	a := gaggiuino.Annotation
	if a.Dose == nil || *a.Dose != 18 || a.TDS == nil || *a.TDS != 9.5 || a.Yield == nil {
		t.Errorf("annotation numbers = %+v", a)
	}
	if a.DrinkType == nil || *a.DrinkType != "other" {
		t.Errorf("custom drink = %v, want other", a.DrinkType)
	}
	if gaggimate.Annotation.DrinkType == nil || *gaggimate.Annotation.DrinkType != "espresso" {
		t.Errorf("built-in drink = %v, want espresso", gaggimate.Annotation.DrinkType)
	}
	dp := gaggiuino.Datapoints
	idx, _ := dp["phaseIndex"].([]any)
	if len(idx) != 6 || idx[4] != nil || idx[5] != nil {
		t.Errorf("phaseIndex = %v, want 6 entries with the last two null", dp["phaseIndex"])
	}
	tr, _ := dp["phaseTransitions"].([]any)
	if len(tr) != 1 {
		t.Fatalf("phaseTransitions = %v", dp["phaseTransitions"])
	}
	entry, _ := tr[0].(map[string]any)
	if len(entry) != 3 || entry["t"] != float64(10) || entry["phase"] != float64(1) || entry["reason"] != float64(2) {
		t.Errorf("transition = %v, want only t/phase/reason", entry)
	}
	if dp["finalExitReason"] != float64(3) || dp["bleScaleConnected"] != true {
		t.Errorf("finalExitReason/bleScaleConnected = %v/%v", dp["finalExitReason"], dp["bleScaleConnected"])
	}
}

func TestShotDonation_ProfileKeyIgnoresNamesButNotTargets(t *testing.T) {
	profile := func(name string, id float64, phaseName string, end float64, extra map[string]any) shots.Shot {
		stop := map[string]any{"time": float64(20000)}
		for k, v := range extra {
			stop[k] = v
		}
		return shots.Shot{"profile": map[string]any{
			"id": id, "name": name, "waterTemperature": float64(93),
			"phases": []any{map[string]any{
				"name": phaseName, "type": "FLOW",
				"target":         map[string]any{"curve": "INSTANT", "end": end},
				"stopConditions": stop,
			}},
		}}
	}
	base := donationProfileKey(donationProfileOf(profile("A", 1, "Bloom", 7, nil)))
	renamed := donationProfileKey(donationProfileOf(profile("B", 2, "Soak", 7, nil)))
	changed := donationProfileKey(donationProfileOf(profile("A", 1, "Bloom", 8, nil)))
	zeroField := donationProfileKey(donationProfileOf(profile("A", 1, "Bloom", 7, map[string]any{"weight": float64(0)})))
	if base == nil || len(*base) != 16 {
		t.Fatalf("profile key = %v, want 16 hex chars", base)
	}
	if renamed == nil || *renamed != *base {
		t.Errorf("renamed profile key = %v, want %s", renamed, *base)
	}
	if changed == nil || *changed == *base {
		t.Errorf("changed target kept key %s", *base)
	}
	if zeroField == nil || *zeroField != *base {
		t.Errorf("explicit 0 stop condition changed key: %v vs %s", zeroField, *base)
	}
	if donationProfileOf(shots.Shot{}) != nil || donationProfileKey(nil) != nil {
		t.Error("a shot without profile must give nil profile and nil key")
	}
	numeric := donationProfileOf(shots.Shot{"profile": map[string]any{"phases": []any{map[string]any{
		"type": float64(1), "target": map[string]any{"curve": float64(3)},
	}}}})
	if numeric.Phases[0].Type != "PRESSURE" || numeric.Phases[0].Target.Curve != "LINEAR" {
		t.Errorf("numeric enums = %+v", numeric.Phases[0])
	}
}

func TestShotDonation_LookupFields(t *testing.T) {
	h, deps, _ := newTestHandlers(t)
	seedDonationFixture(t, deps)
	f, _ := getDonation(t, newMux(h), "")
	var gaggiuino, gaggimate *donationShot
	for i := range f.Shots {
		switch f.Shots[i].Annotation.Rating {
		case 4:
			gaggiuino = &f.Shots[i]
		case 3:
			gaggimate = &f.Shots[i]
		}
	}
	if gaggiuino == nil || gaggimate == nil {
		t.Fatalf("missing shots: %+v", f.Shots)
	}
	if gaggiuino.MachineType == nil || *gaggiuino.MachineType != "gaggiuino" {
		t.Errorf("gaggiuino machineType = %v", gaggiuino.MachineType)
	}
	if gaggimate.MachineType == nil || *gaggimate.MachineType != "gaggimate" {
		t.Errorf("gaggimate machineType = %v", gaggimate.MachineType)
	}
	p := gaggiuino.Profile
	if p == nil || gaggiuino.ProfileKey == nil || len(p.Phases) != 1 {
		t.Fatalf("gaggiuino profile = %+v key %v", p, gaggiuino.ProfileKey)
	}
	ph := p.Phases[0]
	if ph.Type != "FLOW" || ph.Target.Curve != "INSTANT" || ph.Target.End != 7 || ph.Restriction != 3 || ph.StopConditions.Time != 20000 {
		t.Errorf("phase = %+v", ph)
	}
	if p.Recipe == nil || p.Recipe.CoffeeIn != 18 || p.WaterTemperature != 93 {
		t.Errorf("recipe/water = %+v / %v", p.Recipe, p.WaterTemperature)
	}
	if gaggimate.Profile != nil || gaggimate.ProfileKey != nil {
		t.Errorf("gaggimate profile = %+v key %v, want nil", gaggimate.Profile, gaggimate.ProfileKey)
	}
	a := gaggiuino.Annotation
	if a.RoastLevel == nil || *a.RoastLevel != "medium" {
		t.Errorf("roastLevel = %v", a.RoastLevel)
	}
	if a.BeanAgeDays == nil || *a.BeanAgeDays != 12 {
		t.Errorf("beanAgeDays = %v", a.BeanAgeDays)
	}
	if _, ok := gaggiuino.Scores["classic"]; !ok {
		t.Errorf("scores = %v, want a classic entry", gaggiuino.Scores)
	}
}

func TestDonationTasteTag_OnlyKnownValues(t *testing.T) {
	for _, known := range []string{"sour", "bitter", "balanced", "thin"} {
		got := donationTasteTag(known)
		if got == nil || *got != known {
			t.Errorf("donationTasteTag(%q) = %v, want %q", known, got, known)
		}
	}
	for _, v := range []any{"astringent", "Sour", "", float64(0), float64(2), nil} {
		if got := donationTasteTag(v); got != nil {
			t.Errorf("donationTasteTag(%v) = %q, want nil", v, *got)
		}
	}
}

func TestShotDonation_TasteTagAllowListed(t *testing.T) {
	h, deps, _ := newTestHandlers(t)
	seedDonationFixture(t, deps)
	f, body := getDonation(t, newMux(h), "")
	var rated4, rated3 *donationShot
	for i := range f.Shots {
		switch f.Shots[i].Annotation.Rating {
		case 4:
			rated4 = &f.Shots[i]
		case 3:
			rated3 = &f.Shots[i]
		}
	}
	if rated4 == nil || rated3 == nil {
		t.Fatalf("missing shots: %+v", f.Shots)
	}
	if rated4.Annotation.TasteTag == nil || *rated4.Annotation.TasteTag != "sour" {
		t.Errorf("rating 4 tasteTag = %v, want sour", rated4.Annotation.TasteTag)
	}
	if rated3.Annotation.TasteTag != nil {
		t.Errorf("rating 3 tasteTag = %q, want nil", *rated3.Annotation.TasteTag)
	}
	if strings.Contains(body, "astringent") {
		t.Errorf("body leaks an unknown taste tag: %s", body)
	}
}
