package backup

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
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
	if err := deps.OrdersRepo.SaveAll([]orders.Order{order}); err != nil {
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

func TestRestore_RoundTrip_ToFreshInstall(t *testing.T) {
	h1, deps1, _ := newTestHandlers(t)
	mux1 := newMux(h1)
	seedShot(t, deps1, 42)
	seedOrder(t, deps1)
	if _, err := deps1.MaintenanceRepo.AddMaintenanceLogEntry("descaling", "test note", "gaggiuino.local", 5, 1); err != nil {
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
		DB:              sqlDB,
		ShotsRepo:       shots.NewRepository(sqlDB),
		LibRepo:         libRepo,
		OrdersRepo:      orders.NewRepository(sqlDB),
		MaintenanceRepo: maintenance.NewRepository(sqlDB, libRepo),
		Registry:        machines.NewRegistry(sqlDB),
		Token:           "second-install-token",
		TokenFile:       filepath.Join(t.TempDir(), "api_token.txt"),
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
