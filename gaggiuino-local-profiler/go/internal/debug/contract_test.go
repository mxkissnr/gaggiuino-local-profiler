package debug

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// This file pins routes/debug.js's wire contract — the "pin the essential
// shape" check orders/shots/library's contract_test.go established. The
// export/import round-trip behaviour lives in debug_test.go; this file
// pins the response contract each route owes its one caller (the dev-build
// Debug settings page) and the SQLite-magic boundary the import guard
// checks byte-for-byte.

func devMux(t *testing.T) *http.ServeMux {
	t.Helper()
	t.Setenv("GLP_DEV_BUILD", "dev")
	t.Setenv("NODE_ENV", "development")
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "glp.db")
	return newMux(NewHandlers(openTestDB(t, dbPath), dbPath, nil))
}

// TestContract_ExportDB_DownloadHeaders: a dev build's GET
// /api/debug/export-db streams the raw file as an attachment download.
func TestContract_ExportDB_DownloadHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	devMux(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/debug/export-db", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("Content-Type = %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !bytes.HasPrefix([]byte(cd), []byte(`attachment; filename="glp-db-export-`)) {
		t.Errorf("Content-Disposition = %q", cd)
	}
	if rec.Header().Get("Content-Length") == "" {
		t.Error("missing Content-Length")
	}
	if !bytes.HasPrefix(rec.Body.Bytes(), sqliteMagic) {
		t.Error("body is not a SQLite file")
	}
}

// TestContract_ImportDB_ResponseShape: a successful import answers 200
// { ok: true, restartRequired: true, backupPath: <bare filename> }.
func TestContract_ImportDB_ResponseShape(t *testing.T) {
	mux := devMux(t)

	// export first so we have a valid SQLite body to re-import
	exp := httptest.NewRecorder()
	mux.ServeHTTP(exp, httptest.NewRequest(http.MethodGet, "/api/debug/export-db", nil))
	body := exp.Body.Bytes()

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/debug/import-db", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["ok"] != true || resp["restartRequired"] != true {
		t.Errorf("response = %v", resp)
	}
	bp, _ := resp["backupPath"].(string)
	if bp == "" || filepath.Base(bp) != bp {
		t.Errorf("backupPath = %q, want a bare filename", bp)
	}
}

// TestContract_ImportDB_SQLiteMagicBoundary: the guard checks the full
// 16-byte "SQLite format 3\0" header — a body one byte short, or 16 bytes
// that aren't the magic, is 400 "Not a SQLite database file"; an empty
// body is 400 "No database file uploaded".
func TestContract_ImportDB_SQLiteMagicBoundary(t *testing.T) {
	cases := []struct {
		name string
		body []byte
		want string
	}{
		{"empty", nil, "No database file uploaded"},
		{"one byte short of the magic", sqliteMagic[:len(sqliteMagic)-1], "Not a SQLite database file"},
		{"magic length, wrong bytes", bytes.Repeat([]byte("x"), len(sqliteMagic)), "Not a SQLite database file"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mux := devMux(t)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/debug/import-db", bytes.NewReader(tc.body)))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			var resp map[string]string
			json.Unmarshal(rec.Body.Bytes(), &resp)
			if resp["error"] != tc.want {
				t.Errorf("error = %q, want %q", resp["error"], tc.want)
			}
		})
	}
}

// TestContract_DebugMachine_AlwaysJSON200: routes/system.js's H2
// /api/debug/machine answers 200 with a JSON body on both the success and
// the failure branch — { ok: bool, baseUrl, ... }.
func TestContract_DebugMachine_AlwaysJSON200(t *testing.T) {
	rec := httptest.NewRecorder()
	devMux(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/debug/machine", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (always)", rec.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if _, ok := resp["ok"].(bool); !ok {
		t.Errorf("response missing ok bool: %v", resp)
	}
}
