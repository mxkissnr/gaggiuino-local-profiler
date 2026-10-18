package backup

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/achievements"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

func TestGetBackup_EmptyInstall(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodGet, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	bundle := decodeBody(t, rec.Body.Bytes())
	if bundle["glp_backup"] != true {
		t.Errorf("glp_backup = %v", bundle["glp_backup"])
	}
	shotsArr, ok := bundle["shots"].([]any)
	if !ok || len(shotsArr) != 0 {
		t.Errorf("shots = %+v; want empty array", bundle["shots"])
	}
	if _, ok := bundle["images"]; !ok {
		t.Errorf("GET /api/backup (all sections) should always include `images`")
	}
	if _, ok := bundle["sections"]; ok {
		t.Errorf("a full/legacy export must not carry a `sections` field")
	}
	cd := rec.Header().Get("Content-Disposition")
	if cd == "" {
		t.Errorf("expected Content-Disposition header")
	}
}

// TestGetBackup_RateLimited proves the dedicated backup:<ip> feature limit
// (#1056, backupRateLimitPerMin) on GET /api/backup — the same pattern as
// internal/debug's TestExportDB_RateLimited. Every httptest.NewRequest
// shares one RemoteAddr, so they share one bucket: the first
// backupRateLimitPerMin requests stream the export, the next one 429s.
func TestGetBackup_RateLimited(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	for i := 0; i < backupRateLimitPerMin; i++ {
		if rec := doJSON(t, mux, http.MethodGet, "/api/backup", nil); rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want 200 (limiter not yet tripped)", i, rec.Code)
		}
	}
	if rec := doJSON(t, mux, http.MethodGet, "/api/backup", nil); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request %d: status = %d, want 429", backupRateLimitPerMin, rec.Code)
	}
}

// TestPostBackup_RateLimited (#1626): the zip export gets the same per-IP
// ceiling as GET /api/backup, under its own key — a tripped POST bucket
// leaves the GET budget untouched.
func TestPostBackup_RateLimited(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	for i := 0; i < backupRateLimitPerMin; i++ {
		if rec := doJSON(t, mux, http.MethodPost, "/api/backup", nil); rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want 200 (limiter not yet tripped); body=%s", i, rec.Code, rec.Body.String())
		}
	}
	if rec := doJSON(t, mux, http.MethodPost, "/api/backup", nil); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request %d: status = %d, want 429", backupRateLimitPerMin, rec.Code)
	}
	if rec := doJSON(t, mux, http.MethodGet, "/api/backup", nil); rec.Code != http.StatusOK {
		t.Fatalf("GET after a tripped POST bucket: status = %d, want 200", rec.Code)
	}
}

// TestGetBackupJSON_SkipsUnreferencedImages (#1602): the legacy GET /api/backup
// JSON export bundles only images a row still refers to, like the zip export —
// its inline images map carries the referenced bean photo but not an app-named
// orphan.
func TestGetBackupJSON_SkipsUnreferencedImages(t *testing.T) {
	imgDir := useImageDir(t)
	for _, name := range []string{"1.jpg", "77.jpg"} {
		if err := os.WriteFile(filepath.Join(imgDir, name), []byte{0x01, 0x02, 0x03, 0x04}, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h, deps, _ := newTestHandlers(t)
	if err := deps.LibRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": int64(1), "name": "B", "image": "jpg"}},
	}); err != nil {
		t.Fatal(err)
	}

	rec := doJSON(t, newMux(h), http.MethodGet, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	images, ok := decodeBody(t, rec.Body.Bytes())["images"].(map[string]any)
	if !ok {
		t.Fatalf("images is not a JSON object")
	}
	if _, ok := images["1.jpg"]; !ok {
		t.Errorf("referenced image 1.jpg missing from JSON backup; images=%v", images)
	}
	if _, ok := images["77.jpg"]; ok {
		t.Errorf("unreferenced image 77.jpg bundled into JSON backup; images=%v", images)
	}
}

func TestPostBackup_ZipContainsBackupJSON(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/zip" {
		t.Errorf("Content-Type = %q", ct)
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("reading zip: %v", err)
	}
	var found bool
	for _, f := range zr.File {
		if f.Name == "backup.json" {
			found = true
			rc, _ := f.Open()
			data, _ := io.ReadAll(rc)
			rc.Close()
			var bundle map[string]any
			if err := json.Unmarshal(data, &bundle); err != nil {
				t.Fatalf("backup.json is not valid JSON: %v", err)
			}
			if _, ok := bundle["images"]; ok {
				t.Errorf("zip's backup.json must NOT embed images (they travel as real zip entries)")
			}
		}
	}
	if !found {
		t.Fatalf("zip has no backup.json entry")
	}
}

func TestPostBackup_ScopedSections(t *testing.T) {
	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)
	seedOrder(t, deps)

	rec := doJSON(t, mux, http.MethodPost, "/api/backup", mustMarshal(t, map[string]any{
		"sections": []string{"orders"},
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("reading zip: %v", err)
	}
	bundle := readBackupJSON(t, zr)
	if _, ok := bundle["shots"]; ok {
		t.Errorf("scoped to orders only, must not carry `shots`: %+v", bundle)
	}
	ordersArr, ok := bundle["orders"].([]any)
	if !ok || len(ordersArr) != 1 {
		t.Fatalf("expected 1 order in scoped export, got %+v", bundle["orders"])
	}
	sections, _ := bundle["sections"].([]any)
	if len(sections) != 1 || sections[0] != "orders" {
		t.Errorf("sections = %+v", bundle["sections"])
	}
}

// TestPostBackup_SetsEstimateHeader pins both estimate constants and the
// *.thumb.* exclusion: two shots + two real images (48 + 100 bytes) + one
// thumbnail that must NOT be counted → 4096 envelope + 2*4096 per-shot +
// (48 + 100) image bytes. The two images are referenced by beans 1 and 2
// (#1525: only referenced images are counted).
func TestPostBackup_SetsEstimateHeader(t *testing.T) {
	imgDir := useImageDir(t)
	if err := os.WriteFile(filepath.Join(imgDir, "1.png"), fakePNG(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(imgDir, "2.png"), bytes.Repeat([]byte{0x00}, 100), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(imgDir, "3.thumb.png"), bytes.Repeat([]byte{0x00}, 999), 0o644); err != nil {
		t.Fatal(err)
	}

	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)
	if err := deps.LibRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{
			{"id": int64(1), "name": "One", "image": "png"},
			{"id": int64(2), "name": "Two", "image": "png"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	seedShot(t, deps, 1)
	seedShot(t, deps, 2)

	rec := doJSON(t, mux, http.MethodPost, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	raw := rec.Header().Get("X-GLP-Backup-Estimate")
	got, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		t.Fatalf("X-GLP-Backup-Estimate = %q; not a decimal integer: %v", raw, err)
	}
	want := int64(backupEnvelopeEstimateBytes) + 2*perShotEstimateBytes + int64(len(fakePNG())) + 100
	if got != want {
		t.Errorf("X-GLP-Backup-Estimate = %d; want %d (envelope + 2 shots + 48+100 image bytes, thumb excluded)", got, want)
	}
}

// TestPostBackup_EstimateExcludesImagesWhenShotsOutOfScope: a scope that
// doesn't include "shots" drops both the per-shot term and the image term
// entirely — only the flat envelope estimate remains.
func TestPostBackup_EstimateExcludesImagesWhenShotsOutOfScope(t *testing.T) {
	imgDir := useImageDir(t)
	if err := os.WriteFile(filepath.Join(imgDir, "1.png"), fakePNG(), 0o644); err != nil {
		t.Fatal(err)
	}

	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)
	seedShot(t, deps, 1)

	rec := doJSON(t, mux, http.MethodPost, "/api/backup", mustMarshal(t, map[string]any{
		"sections": []string{"maintenance"},
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-GLP-Backup-Estimate"); got != strconv.Itoa(backupEnvelopeEstimateBytes) {
		t.Errorf("X-GLP-Backup-Estimate = %q; want %d (envelope only)", got, backupEnvelopeEstimateBytes)
	}
}

// TestBackupExport_CallbackFiresOnlyOnSuccess pins #1286 R2: the backup badge
// is driven by Handlers.SetOnExported, which must fire exactly once per fully
// written export — both GET /api/backup's JSON and POST /api/backup's zip —
// and never when the export fails mid-response.
func TestBackupExport_CallbackFiresOnlyOnSuccess(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	var calls int
	h.SetOnExported(func() { calls++ })
	mux := newMux(h)

	if rec := doJSON(t, mux, http.MethodGet, "/api/backup", nil); rec.Code != http.StatusOK {
		t.Fatalf("GET /api/backup status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if calls != 1 {
		t.Fatalf("onExported calls after a successful GET export = %d, want 1", calls)
	}

	if rec := doJSON(t, mux, http.MethodPost, "/api/backup", nil); rec.Code != http.StatusOK {
		t.Fatalf("POST /api/backup status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if calls != 2 {
		t.Fatalf("onExported calls after a successful POST export = %d, want 2", calls)
	}

	// The response writer fails the moment the handler streams its body, so
	// the export never completes and the callback must not fire.
	fail := httptest.NewRequest(http.MethodGet, "/api/backup", nil)
	mux.ServeHTTP(&failingWriter{header: http.Header{}}, fail)
	if calls != 2 {
		t.Fatalf("onExported fired on a failed export (calls = %d, want 2)", calls)
	}
}

// failingWriter is an http.ResponseWriter whose Write always errors, standing
// in for a dropped connection so a streaming handler sees a mid-response
// failure.
type failingWriter struct{ header http.Header }

func (w *failingWriter) Header() http.Header {
	return w.header
}

func (w *failingWriter) WriteHeader(statusCode int) {}

func (w *failingWriter) Write(p []byte) (int, error) {
	return 0, errors.New("writer closed")
}

func readBackupJSON(t *testing.T, zr *zip.Reader) map[string]any {
	t.Helper()
	for _, f := range zr.File {
		if f.Name == "backup.json" {
			rc, _ := f.Open()
			data, _ := io.ReadAll(rc)
			rc.Close()
			var m map[string]any
			if err := json.Unmarshal(data, &m); err != nil {
				t.Fatalf("backup.json: %v", err)
			}
			return m
		}
	}
	t.Fatal("no backup.json in zip")
	return nil
}

// seedOrder places one order directly through the orders repository (not
// via HTTP — that domain's own handlers_test.go already covers the
// placement path) so the backup domain has something real to export.
func seedOrder(t *testing.T, deps Dependencies) orders.Order {
	t.Helper()
	order := orders.Order{
		"id": "ord_1_test", "createdAt": int64(1000), "customer": "Max", "item": "Espresso",
		"status": "done", "machineId": int64(1), "completedAt": int64(2000),
		"note": "", "variant": nil, "notifyService": nil, "declineReason": nil,
		"haUserId": nil, "machine": nil, "eta": nil, "beanId": nil, "shotId": nil,
	}
	if err := deps.OrdersRepo.Insert(order); err != nil {
		t.Fatalf("seeding order: %v", err)
	}
	return order
}

// seedShot places one shot directly through the shots repository.
func seedShot(t *testing.T, deps Dependencies, id int64) {
	t.Helper()
	if err := deps.ShotsRepo.Upsert(shots.Shot{
		"id": id, "timestamp": int64(1700000000), "duration": int64(30000),
		"profileName": "Test Profile", "machineId": int64(1),
		"annotation": map[string]any{"coffee": "Test Bean", "dose": float64(18)},
	}); err != nil {
		t.Fatalf("seeding shot: %v", err)
	}
}

func TestRestore_DryRunPreview_NoWrites(t *testing.T) {
	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)
	seedShot(t, deps, 1)
	seedOrder(t, deps)

	rec := doJSON(t, mux, http.MethodGet, "/api/backup", nil)
	bundle := rec.Body.Bytes()

	var parsed map[string]any
	if err := json.Unmarshal(bundle, &parsed); err != nil {
		t.Fatalf("parsing export: %v", err)
	}
	parsed["dryRun"] = true

	rec = doJSON(t, mux, http.MethodPost, "/api/restore", mustMarshal(t, parsed))
	if rec.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec.Body.Bytes())
	if resp["dryRun"] != true {
		t.Errorf("dryRun = %v", resp["dryRun"])
	}
	preview, ok := resp["preview"].(map[string]any)
	if !ok {
		t.Fatalf("no preview in response: %+v", resp)
	}
	if shotsCount, _ := preview["shots"].(float64); shotsCount != 1 {
		t.Errorf("preview.shots = %v", preview["shots"])
	}
	if ordersCount, _ := preview["orders"].(float64); ordersCount != 1 {
		t.Errorf("preview.orders = %v", preview["orders"])
	}

	// Dry run must not have written anything to THIS server's own DB —
	// re-export and confirm still exactly 1 shot / 1 order (not 2).
	rec2 := doJSON(t, mux, http.MethodGet, "/api/backup", nil)
	after := decodeBody(t, rec2.Body.Bytes())
	if arr, _ := after["shots"].([]any); len(arr) != 1 {
		t.Errorf("shots after dry run = %d; want 1 (unchanged)", len(arr))
	}
}

// TestRestore_DryRunPreview_ZipReportsShotsPresent (#967): the streamed zip
// parser consumes the shots array via its callback and never stores it in
// b, so sectionsPresent used to omit "shots" for every zip bundle — the UI
// then showed "not in this file" and skipped shots + library on restore.
func TestRestore_DryRunPreview_ZipReportsShotsPresent(t *testing.T) {
	useImageDir(t)
	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)
	seedShot(t, deps, 1)
	seedShot(t, deps, 2)
	if err := deps.LibRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": int64(1), "name": "Zip Bean", "stock_g": float64(250)}},
	}); err != nil {
		t.Fatal(err)
	}

	rec := doJSON(t, mux, http.MethodPost, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d", rec.Code)
	}
	zipBytes := append([]byte(nil), rec.Body.Bytes()...)

	rr := doZip(t, mux, "/api/restore", zipBytes, map[string]string{"X-GLP-Dry-Run": "true"})
	if rr.Code != http.StatusOK {
		t.Fatalf("dry-run restore status = %d; body=%s", rr.Code, rr.Body.String())
	}
	resp := decodeBody(t, rr.Body.Bytes())
	preview, ok := resp["preview"].(map[string]any)
	if !ok {
		t.Fatalf("no preview: %+v", resp)
	}

	present := preview["sectionsPresent"].([]any)
	found := false
	for _, s := range present {
		if s == "shots" {
			found = true
		}
	}
	if !found {
		t.Errorf("sectionsPresent %v does not contain \"shots\"", present)
	}
	if n, _ := preview["shots"].(float64); n != 2 {
		t.Errorf("preview.shots = %v; want 2", preview["shots"])
	}
	if preview["library"] != true {
		t.Errorf("preview.library = %v; want true", preview["library"])
	}
}

func TestRestore_RoundTrip_ToFreshInstall(t *testing.T) {
	h1, deps1, _ := newTestHandlers(t)
	mux1 := newMux(h1)
	seedShot(t, deps1, 42)
	seedOrder(t, deps1)
	if _, err := deps1.MaintenanceRepo.AddMaintenanceLogEntry("descaling", "test note", "gaggiuino.local", 5, 1, time.Now()); err != nil {
		t.Fatalf("seeding maintenance log: %v", err)
	}
	if err := deps1.LibRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": int64(1), "name": "Test Bean", "stock_g": float64(250)}},
	}); err != nil {
		t.Fatalf("seeding library: %v", err)
	}

	rec := doJSON(t, mux1, http.MethodGet, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	exported := rec.Body.Bytes()

	// Restore into a completely separate, fresh DB/Handlers.
	h2, deps2, _ := newTestHandlersInDir(t)
	mux2 := newMux(h2)

	rec = doJSON(t, mux2, http.MethodPost, "/api/restore", exported)
	if rec.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rec.Code, rec.Body.String())
	}
	result := decodeBody(t, rec.Body.Bytes())
	if result["ok"] != true {
		t.Fatalf("restore result = %+v", result)
	}
	if shotsCount, _ := result["shots"].(float64); shotsCount != 1 {
		t.Errorf("shots restored = %v", result["shots"])
	}

	restoredShot, err := deps2.ShotsRepo.FindByID(42)
	if err != nil || restoredShot == nil {
		t.Fatalf("restored shot 42 not found: err=%v shot=%v", err, restoredShot)
	}
	if restoredShot["profileName"] != "Test Profile" {
		t.Errorf("restored shot profileName = %v", restoredShot["profileName"])
	}

	restoredOrders, err := deps2.OrdersRepo.FindAll()
	if err != nil || len(restoredOrders) != 1 {
		t.Fatalf("restored orders = %+v (err=%v)", restoredOrders, err)
	}

	restoredLib, err := deps2.LibRepo.GetLibrary()
	if err != nil || len(restoredLib.Beans) != 1 || restoredLib.Beans[0]["name"] != "Test Bean" {
		t.Fatalf("restored library beans = %+v (err=%v)", restoredLib.Beans, err)
	}

	restoredLog, err := deps2.MaintenanceRepo.GetMaintenanceLog(0)
	if err != nil || len(restoredLog) != 1 || restoredLog[0].Notes != "test note" {
		t.Fatalf("restored maintenance log = %+v (err=%v)", restoredLog, err)
	}
}

// newTestHandlersInDir is newTestHandlers but without depending on the
// first test's t.TempDir() — a second, independent DB standing in for a
// different install a backup gets restored onto.
func newTestHandlersInDir(t *testing.T) (*Handlers, Dependencies, *sql.DB) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp2.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	libRepo := library.NewRepository(sqlDB)
	deps := Dependencies{
		DB:               sqlDB,
		ShotsRepo:        shots.NewRepository(sqlDB),
		LibRepo:          libRepo,
		OrdersRepo:       orders.NewRepository(sqlDB),
		MaintenanceRepo:  maintenance.NewRepository(sqlDB, libRepo),
		Registry:         machines.NewRegistry(sqlDB),
		AchievementsRepo: achievements.NewRepository(sqlDB),
		Token:            "second-install-token",
		TokenFile:        filepath.Join(t.TempDir(), "api_token.txt"),
	}
	return NewHandlers(deps), deps, sqlDB
}

func TestRestore_InvalidBundle400(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/restore", mustMarshal(t, map[string]any{"not": "a backup"}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want 400; body=%s", rec.Code, rec.Body.String())
	}
}

func TestBackupCrypto_EncryptDecryptRoundTrip(t *testing.T) {
	enc, err := EncryptSecrets(map[string]any{"apiToken": "secret-abc-123"}, "correct horse battery staple")
	if err != nil {
		t.Fatalf("EncryptSecrets: %v", err)
	}
	decrypted := DecryptSecrets(enc, "correct horse battery staple")
	if decrypted == nil || decrypted["apiToken"] != "secret-abc-123" {
		t.Fatalf("decrypted = %+v", decrypted)
	}
	if wrong := DecryptSecrets(enc, "wrong passphrase"); wrong != nil {
		t.Errorf("wrong passphrase should fail to decrypt, got %+v", wrong)
	}
}

func TestRestore_SecretsRoundTrip(t *testing.T) {
	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)
	_ = deps

	rec := doJSON(t, mux, http.MethodPost, "/api/backup", mustMarshal(t, map[string]any{"passphrase": "hunter2"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d", rec.Code)
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	bundle := readBackupJSON(t, zr)
	if _, ok := bundle["secrets"]; !ok {
		t.Fatalf("expected `secrets` block in a passphrase-scoped export: %+v", bundle)
	}
	bundle["dryRun"] = true
	bundle["passphrase"] = "hunter2"

	rec = doJSON(t, mux, http.MethodPost, "/api/restore", mustMarshal(t, bundle))
	if rec.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec.Body.Bytes())
	preview, _ := resp["preview"].(map[string]any)
	if preview["secretsPresent"] != true || preview["secretsRestored"] != true {
		t.Errorf("preview secrets = %+v", preview)
	}

	// Wrong passphrase must not restore secrets but must not fail the
	// whole restore either.
	bundle["passphrase"] = "wrong"
	rec = doJSON(t, mux, http.MethodPost, "/api/restore", mustMarshal(t, bundle))
	resp = decodeBody(t, rec.Body.Bytes())
	preview, _ = resp["preview"].(map[string]any)
	if preview["secretsPresent"] != true || preview["secretsRestored"] != false {
		t.Errorf("preview with wrong passphrase = %+v", preview)
	}
}

// withSmallUnzipLimits temporarily shrinks restoreUnzipEntryLimit/
// restoreUnzipTotalLimit so a test can exercise the "over the limit" path
// by writing a few KB instead of hundreds of MB — real production sizes
// would make the zip-bomb tests themselves slow and memory-heavy (worse
// still under -race). Restored via t.Cleanup so it never leaks into other
// tests in this package.
func withSmallUnzipLimits(t *testing.T, entryLimit, totalLimit int64) {
	t.Helper()
	prevEntry, prevTotal := restoreUnzipEntryLimit, restoreUnzipTotalLimit
	restoreUnzipEntryLimit, restoreUnzipTotalLimit = entryLimit, totalLimit
	t.Cleanup(func() { restoreUnzipEntryLimit, restoreUnzipTotalLimit = prevEntry, prevTotal })
}

// TestRestore_RejectsZipBombBackupJSON (#901 code review, #959 streaming):
// a backup.json entry that's tiny compressed but decompresses past
// restoreUnzipEntryLimit must be rejected as it streams through the JSON
// decoder — never buffered whole first. The payload is a valid JSON prefix
// followed by a long run of insignificant whitespace (maximally
// compressible), so the compressed zip stays tiny while the decompressed
// stream crosses the cap mid-parse.
func TestRestore_RejectsZipBombBackupJSON(t *testing.T) {
	withSmallUnzipLimits(t, 64*1024, 256*1024)
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	fw, err := zw.CreateHeader(&zip.FileHeader{Name: "backup.json", Method: zip.Deflate})
	if err != nil {
		t.Fatalf("CreateHeader: %v", err)
	}
	fw.Write([]byte(`{"glp_backup":true,`))
	if _, err := io.CopyN(fw, spaceReader{}, restoreUnzipEntryLimit+4096); err != nil {
		t.Fatalf("writing oversized zip entry: %v", err)
	}
	fw.Write([]byte(`"shots":[]}`))
	if err := zw.Close(); err != nil {
		t.Fatalf("closing zip: %v", err)
	}

	r := httptest.NewRequest(http.MethodPost, "/api/restore", bytes.NewReader(buf.Bytes()))
	r.Header.Set("Content-Type", "application/zip")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want 400 for a zip-bomb backup.json; body=%s", rec.Code, rec.Body.String())
	}
}

// TestCappedReader_ErrorsPastLimit is the unit-level guard behind both the
// per-entry and cumulative zip-bomb caps: newCappedReader reports an error
// (not EOF) once more than `limit` bytes have passed through it.
func TestCappedReader_ErrorsPastLimit(t *testing.T) {
	cr := newCappedReader(spaceReader{}, 1024)
	n, err := io.Copy(io.Discard, cr)
	if err == nil {
		t.Fatalf("cappedReader read %d bytes without erroring past its 1024-byte limit", n)
	}
	if n > 1024+64*1024 {
		t.Errorf("cappedReader over-read: %d bytes", n)
	}
}

// spaceReader yields an endless stream of ASCII spaces without allocating a
// full in-memory buffer — used to build a highly-compressible (small
// compressed, large decompressed) zip entry cheaply in tests.
type spaceReader struct{}

func (spaceReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = ' '
	}
	return len(p), nil
}

// withZipBodyLimit temporarily shrinks restoreZipBodyLimit so a test can
// exercise the compressed-body cap with a few-KB zip instead of 2 GiB.
// Restored via t.Cleanup so it never leaks into other tests.
func withZipBodyLimit(t *testing.T, limit int64) {
	t.Helper()
	prev := restoreZipBodyLimit
	restoreZipBodyLimit = limit
	t.Cleanup(func() { restoreZipBodyLimit = prev })
}

// TestRestore_ZipBodyLimitEnforced (#1602): restoreZipBodyLimit is the exact
// compressed-body cap the route enforces — a body one byte over it is
// rejected, a body exactly at it is accepted. The limit is shrunk to the size
// of a real exported zip so the test stays a few KB instead of 2 GiB.
func TestRestore_ZipBodyLimitEnforced(t *testing.T) {
	useImageDir(t)
	h1, deps1, _ := newTestHandlers(t)
	seedShot(t, deps1, 42)
	recExp := doJSON(t, newMux(h1), http.MethodPost, "/api/backup", nil)
	if recExp.Code != http.StatusOK {
		t.Fatalf("export status = %d", recExp.Code)
	}
	zipBytes := append([]byte(nil), recExp.Body.Bytes()...)
	zipLen := int64(len(zipBytes))

	withZipBodyLimit(t, zipLen)
	h2, _, _ := newTestHandlersInDir(t)
	if rr := doZip(t, newMux(h2), "/api/restore", zipBytes, nil); rr.Code != http.StatusOK {
		t.Fatalf("at-limit restore status = %d; want 200; body=%s", rr.Code, rr.Body.String())
	}

	withZipBodyLimit(t, zipLen-1)
	h3, _, _ := newTestHandlersInDir(t)
	if rr := doZip(t, newMux(h3), "/api/restore", zipBytes, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("over-limit restore status = %d; want 400; body=%s", rr.Code, rr.Body.String())
	}
}

// TestRestoreLimits_ProductionValues (#1602): the shipped caps must stay high
// enough that a normal photo library restores (>= 2 GiB compressed), and the
// decompression budget must exceed the compressed cap.
func TestRestoreLimits_ProductionValues(t *testing.T) {
	if restoreZipBodyLimit < 2<<30 {
		t.Errorf("restoreZipBodyLimit = %d; want >= 2 GiB", restoreZipBodyLimit)
	}
	if restoreUnzipTotalLimit < restoreZipBodyLimit {
		t.Errorf("restoreUnzipTotalLimit = %d < restoreZipBodyLimit = %d", restoreUnzipTotalLimit, restoreZipBodyLimit)
	}
}

// TestApplyKVSettings_NormalizesMenuAndSettings pins the restore path through
// the same checks the orders API applies (#1603): a damaged menu item
// (variants as a string, or no name at all) can no longer reach the stored
// menu, and only valid settings fields survive.
func TestApplyKVSettings_NormalizesMenuAndSettings(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	// m2 has no name and "not-a-map" is not an object: both must be skipped.
	kv := map[string]any{}
	kv["menu"] = []any{
		map[string]any{"id": "m1", "name": "Latte", "variants": "x", "bogus": 1},
		map[string]any{"id": "m2", "emoji": "☕"},
		"not-a-map",
	}
	kv["orders_settings"] = map[string]any{
		"enabled":             true,
		"broadcastRecipients": []any{"notify.phone", "bogus"},
		"notify_low_stock":    "yes",
	}
	if err := h.applyKVSettings(kv); err != nil {
		t.Fatalf("applyKVSettings: %v", err)
	}

	menu, err := h.deps.OrdersRepo.GetMenu()
	if err != nil {
		t.Fatalf("GetMenu: %v", err)
	}
	if len(menu) != 1 {
		t.Fatalf("menu length = %d; want 1 (invalid items skipped)", len(menu))
	}
	if variants, ok := menu[0]["variants"].([]any); !ok || len(variants) != 0 {
		t.Errorf("variants = %#v; want an empty array", menu[0]["variants"])
	}
	if _, present := menu[0]["bogus"]; present {
		t.Errorf("unknown menu key survived restore: %#v", menu[0])
	}

	s, err := h.deps.OrdersRepo.GetSettings()
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	recipients, _ := s["broadcastRecipients"].([]any)
	if len(recipients) != 1 || recipients[0] != "notify.phone" {
		t.Errorf("broadcastRecipients = %#v; want just notify.phone", recipients)
	}
	if _, present := s["notify_low_stock"]; present {
		t.Errorf("non-bool toggle survived restore: %#v", s)
	}
}

// TestKnownBundleKeys_CoversEveryExportedKey (#1601) is the guard that a
// future exporter key can never be silently dropped by restore's unknown-key
// skip: every top-level key the export writes must be in knownBundleKeys. It
// checks both the full legacy JSON export (which extra-carries `images`) and
// a scoped zip export (which extra-carries `sections`).
func TestKnownBundleKeys_CoversEveryExportedKey(t *testing.T) {
	useImageDir(t)
	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)
	seedShot(t, deps, 1)
	seedOrder(t, deps)

	check := func(label string, b map[string]any) {
		t.Helper()
		if len(b) == 0 {
			t.Fatalf("%s: exported bundle has no top-level keys", label)
		}
		for k := range b {
			if !knownBundleKeys[k] {
				t.Errorf("%s: exported key %q is not in knownBundleKeys — restore would silently drop it", label, k)
			}
		}
	}

	rec := doJSON(t, mux, http.MethodGet, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("full export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	var full map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &full); err != nil {
		t.Fatalf("decoding full export: %v", err)
	}
	check("full legacy JSON export", full)
	if _, ok := full["images"]; !ok {
		t.Errorf("full legacy JSON export should carry `images`")
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/backup", mustMarshal(t, map[string]any{"sections": []string{"shots"}}))
	if rec.Code != http.StatusOK {
		t.Fatalf("scoped export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("zip.NewReader: %v", err)
	}
	scoped := readBackupJSON(t, zr)
	check("scoped zip export", scoped)
	if _, ok := scoped["sections"]; !ok {
		t.Errorf("scoped zip export should carry `sections`")
	}
}

// TestRestoreUpload_RateLimitedBeforeBodyRead (#1601): the coarse
// restore-upload:<ip> token is taken before the body is spooled, so the 31st
// upload from one IP within the window is answered 429 without the request
// body ever being read.
func TestRestoreUpload_RateLimitedBeforeBodyRead(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	// 30 uploads exhaust the coarse bucket. The bodies are deliberately
	// unparseable (a 400) so they never reach the finer post-parse limit.
	for i := 0; i < 30; i++ {
		rec := doJSON(t, mux, http.MethodPost, "/api/restore", []byte("not-json"))
		if rec.Code == http.StatusTooManyRequests {
			t.Fatalf("upload %d answered 429 before the coarse limit was exhausted", i+1)
		}
	}

	body := &failIfReadBody{t: t}
	r := httptest.NewRequest(http.MethodPost, "/api/restore", body)
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("31st upload status = %d, want 429; body=%s", rec.Code, rec.Body.String())
	}
	if body.read {
		t.Errorf("the handler read the request body before rejecting the over-limit upload")
	}
}

// failIfReadBody fails the test if its Read is ever called — proving a
// rejected request never had its body touched.
type failIfReadBody struct {
	t    *testing.T
	read bool
}

func (b *failIfReadBody) Read([]byte) (int, error) {
	b.read = true
	b.t.Errorf("request body read on a request that should have been rejected before reading")
	return 0, io.EOF
}

// TestRestore_DropsUnknownShotImageExtension pins that a restored shot's
// photo extension is filtered when the row is stored: pass 2 re-parses the
// raw entry, so validateEntityImages' cleared copy never reaches the DB.
// The second half proves a legacy caller holding the old value still cannot
// delete a file outside the image directory.
func TestRestore_DropsUnknownShotImageExtension(t *testing.T) {
	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)
	seedShot(t, deps, 1)

	rec := doJSON(t, mux, http.MethodGet, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	var bundle map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &bundle); err != nil {
		t.Fatalf("parsing export: %v", err)
	}
	shotEntries, _ := bundle["shots"].([]any)
	if len(shotEntries) != 1 {
		t.Fatalf("exported shots = %d, want 1", len(shotEntries))
	}
	shotEntry, _ := shotEntries[0].(map[string]any)
	if shotEntry == nil {
		t.Fatalf("exported shot is not an object: %#v", shotEntries[0])
	}
	shotEntry["image"] = "x/../../victim"

	rec = doJSON(t, mux, http.MethodPost, "/api/restore", mustMarshal(t, bundle))
	if rec.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rec.Code, rec.Body.String())
	}
	restored, err := deps.ShotsRepo.FindByID(1)
	if err != nil || restored == nil {
		t.Fatalf("restored shot 1 not found: err=%v shot=%v", err, restored)
	}
	if ext, ok := restored["image"]; ok {
		t.Fatalf("restored shot 1 kept image = %v, want no image key", ext)
	}

	dir := useImageDir(t)
	victim := filepath.Join(filepath.Dir(dir), "victim")
	if err := os.WriteFile(victim, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	img.Delete(dir, 1, "x/../../victim", "shot-")

	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("victim outside image dir was removed: %v", err)
	}
}

func TestRestore_RejectsUnsafeOrderAndNotifyServiceValues(t *testing.T) {
	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)

	bundle := map[string]any{
		"glp_backup": true,
		"shots":      []any{},
		"sections":   []any{"orders", "settings"},
		"orders":     []any{
			map[string]any{"id": "ord_1_a", "status": "pending", "item": "Espresso", "customer": "Max", "notifyService": "script.x"},
			map[string]any{"id": "../x", "status": "pending", "item": "Espresso", "customer": "Max"},
			map[string]any{"id": "ord_2_b", "status": "pending", "item": "Latte", "customer": "Eva", "notifyService": "notify.mobile_app_x"},
		},
		"kv": map[string]any{
			"notify_mapping": map[string]any{
				"ha-user-1": "script.x",
				"ha-user-2": "notify.mobile_app_x",
			},
		},
	}
	rec := doJSON(t, mux, http.MethodPost, "/api/restore", mustMarshal(t, bundle))
	if rec.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rec.Code, rec.Body.String())
	}

	rows, err := deps.OrdersRepo.FindAll()
	if err != nil {
		t.Fatalf("FindAll: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("restored orders = %+v, want the two valid rows", rows)
	}
	byID := map[string]orders.Order{}
	for _, row := range rows {
		id, _ := row["id"].(string)
		byID[id] = row
	}
	if _, ok := byID["../x"]; ok {
		t.Error("order with id ../x was restored")
	}
	first, ok := byID["ord_1_a"]
	if !ok {
		t.Fatal("order ord_1_a was not restored")
	}
	if got := first["notifyService"]; got != nil {
		t.Errorf("ord_1_a notifyService = %v, want nil", got)
	}
	second, ok := byID["ord_2_b"]
	if !ok {
		t.Fatal("order ord_2_b was not restored")
	}
	if got := second["notifyService"]; got != "notify.mobile_app_x" {
		t.Errorf("ord_2_b notifyService = %v, want notify.mobile_app_x", got)
	}

	mapping, err := deps.OrdersRepo.GetNotifyMapping()
	if err != nil {
		t.Fatalf("GetNotifyMapping: %v", err)
	}
	if _, ok := mapping["ha-user-1"]; ok {
		t.Error("notify_mapping entry with value script.x was kept")
	}
	if got := mapping["ha-user-2"]; got != "notify.mobile_app_x" {
		t.Errorf("ha-user-2 mapping = %q, want notify.mobile_app_x", got)
	}
}
