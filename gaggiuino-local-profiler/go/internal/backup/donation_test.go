package backup

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// Shot ids and timestamps the leak test searches the file for.
const (
	donationGaggiuinoShotID = int64(987654321)
	donationGaggiMateShotID = int64(987654322)
	donationShotTimestamp   = int64(1700000123)
)

// seedDonationFixture seeds two rated shots (4 and 3 stars), an unrated
// shot and a shot rated 0. Slice 2 of #2220 widens it with every free-text
// field filled.
func seedDonationFixture(t *testing.T, deps Dependencies) {
	t.Helper()
	if err := deps.Registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	seed := func(id int64, ann map[string]any) {
		if err := deps.ShotsRepo.Upsert(shots.Shot{
			"id": id, "timestamp": donationShotTimestamp, "duration": int64(300),
			"profileName": "SECRET-PROFILE", "machineId": int64(1),
		}); err != nil {
			t.Fatalf("Upsert %d: %v", id, err)
		}
		if ann != nil {
			if err := deps.ShotsRepo.SaveAnnotation(id, ann); err != nil {
				t.Fatalf("SaveAnnotation %d: %v", id, err)
			}
		}
	}
	seed(donationGaggiuinoShotID, map[string]any{"rating": float64(4), "notes": "SECRET-NOTES"})
	seed(donationGaggiMateShotID, map[string]any{"rating": float64(3)})
	seed(987654323, nil)
	seed(987654324, map[string]any{"rating": float64(0)})
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
