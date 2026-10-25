package auth

import (
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// newKioskStore returns a loaded store backed by a fresh, absent file.
func newKioskStore(t *testing.T) (*KioskKeyStore, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), KioskKeyFileName)
	s, err := LoadKioskKeyStore(path)
	if err != nil {
		t.Fatalf("LoadKioskKeyStore: %v", err)
	}
	return s, path
}

func TestKioskKeyStore_LoadDoesNotCreateFile(t *testing.T) {
	s, path := newKioskStore(t)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("loading an absent key file must not create one; stat err = %v", err)
	}
	if s.Valid("anything") {
		t.Error("an ungenerated store must not validate any candidate")
	}
}

func TestKioskKeyStore_GetGeneratesAndPersists(t *testing.T) {
	s, path := newKioskStore(t)
	key, err := s.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(key) != 64 {
		t.Fatalf("key length = %d; want 64 hex chars", len(key))
	}
	if raw, err := hex.DecodeString(key); err != nil || len(raw) != 32 {
		t.Fatalf("key %q is not 32 random bytes hex-encoded: %v", key, err)
	}
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	if string(onDisk) != key {
		t.Errorf("file holds %q; want %q", onDisk, key)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("kiosk key file mode = %o; want 600", perm)
	}

	// Get is idempotent while the key is loaded.
	again, err := s.Get()
	if err != nil {
		t.Fatalf("second Get: %v", err)
	}
	if again != key {
		t.Errorf("second Get returned a different key")
	}
}

func TestKioskKeyStore_PersistsAcrossReloads(t *testing.T) {
	s, path := newKioskStore(t)
	key, err := s.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	reloaded, err := LoadKioskKeyStore(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !reloaded.Valid(key) {
		t.Error("a reloaded store must accept the persisted key")
	}
}

func TestKioskKeyStore_RotateInvalidatesOldKey(t *testing.T) {
	s, path := newKioskStore(t)
	old, err := s.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	fresh, err := s.Rotate()
	if err != nil {
		t.Fatalf("Rotate: %v", err)
	}
	if fresh == old {
		t.Fatal("Rotate returned the same key")
	}
	if s.Valid(old) {
		t.Error("the old key must stop validating immediately after Rotate")
	}
	if !s.Valid(fresh) {
		t.Error("the new key must validate")
	}
	reloaded, err := LoadKioskKeyStore(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloaded.Valid(old) {
		t.Error("the old key must not survive a reload")
	}
	if !reloaded.Valid(fresh) {
		t.Error("the rotated key must be on disk")
	}
}

func TestKioskKeyStore_EmptyFileIsTreatedAsAbsent(t *testing.T) {
	path := filepath.Join(t.TempDir(), KioskKeyFileName)
	if err := os.WriteFile(path, []byte("  \n"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s, err := LoadKioskKeyStore(path)
	if err != nil {
		t.Fatalf("LoadKioskKeyStore: %v", err)
	}
	if s.Valid("") || s.Valid("anything") {
		t.Error("a whitespace-only key file must not authenticate anything")
	}
	key, err := s.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(key) != 64 {
		t.Errorf("Get on a blank file returned %q; want a freshly generated key", key)
	}
}

func TestKioskKeyStore_TrimmedWhitespace(t *testing.T) {
	path := filepath.Join(t.TempDir(), KioskKeyFileName)
	want := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if err := os.WriteFile(path, []byte(want+"\n"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s, err := LoadKioskKeyStore(path)
	if err != nil {
		t.Fatalf("LoadKioskKeyStore: %v", err)
	}
	if !s.Valid(want) {
		t.Error("a key file with a trailing newline must still validate its trimmed key")
	}
}

func TestKioskKeyStore_NilStoreAcceptsNothing(t *testing.T) {
	var s *KioskKeyStore
	if s.Valid("anything") {
		t.Error("a nil store must accept nothing")
	}
	if _, err := s.Get(); err == nil {
		t.Error("Get on a nil store must fail")
	}
	if _, err := s.Rotate(); err == nil {
		t.Error("Rotate on a nil store must fail")
	}
}

func TestKioskKeyFileFor(t *testing.T) {
	got := KioskKeyFileFor("/data/api_token.txt")
	if want := filepath.Join("/data", KioskKeyFileName); got != want {
		t.Errorf("KioskKeyFileFor = %q; want %q", got, want)
	}
}

// ── RequireToken: kiosk allow-list ───────────────────────────────────────

func newKioskAuthedHandler(kiosk *KioskKeyStore) http.Handler {
	return RequireToken(testToken, nil, kiosk)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

func serveKiosk(t *testing.T, h http.Handler, method, path, key string) int {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	req.RemoteAddr = "192.168.1.50:1234" // LAN: no Ingress bypass
	if key != "" {
		req.Header.Set("X-GLP-Token", key)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestRequireToken_KioskKeyAcceptedOnAllowList(t *testing.T) {
	store, _ := newKioskStore(t)
	key, err := store.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	h := newKioskAuthedHandler(store)

	allowed := []struct{ method, path string }{
		{http.MethodGet, "/api/menu"},
		{http.MethodGet, "/api/orders/settings"},
		{http.MethodGet, "/api/orders/queue-eta"},
		{http.MethodGet, "/api/orders"},
		{http.MethodPost, "/api/orders"},
	}
	for _, c := range allowed {
		if code := serveKiosk(t, h, c.method, c.path, key); code != http.StatusOK {
			t.Errorf("%s %s with the kiosk key: got %d; want 200", c.method, c.path, code)
		}
	}
}

func TestRequireToken_KioskKeyRejectedOffAllowList(t *testing.T) {
	store, _ := newKioskStore(t)
	key, err := store.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	h := newKioskAuthedHandler(store)

	denied := []struct{ method, path string }{
		{http.MethodDelete, "/api/orders/1"},
		{http.MethodPost, "/api/orders/1/accept"},
		{http.MethodPost, "/api/orders/settings"},
		{http.MethodGet, "/api/orders/kiosk-key"},
		{http.MethodPost, "/api/orders/kiosk-key/rotate"},
		{http.MethodGet, "/api/shots"},
		{http.MethodGet, "/api/backup"},
		{http.MethodGet, "/api/events"},
		{http.MethodPost, "/api/orders/menu"},
		{http.MethodGet, "/api/orders/stats"},
	}
	for _, c := range denied {
		if code := serveKiosk(t, h, c.method, c.path, key); code != http.StatusUnauthorized {
			t.Errorf("%s %s with the kiosk key: got %d; want 401", c.method, c.path, code)
		}
	}
}

func TestRequireToken_KioskKeyRejectedInEventsQuery(t *testing.T) {
	store, _ := newKioskStore(t)
	key, err := store.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	h := newKioskAuthedHandler(store)

	req := httptest.NewRequest(http.MethodGet, "/api/events?ticket="+key, nil)
	req.RemoteAddr = "192.168.1.50:1234"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("kiosk key as ?ticket= on /api/events: got %d; want 401", rec.Code)
	}

	// Nor is it accepted as a query credential on an allow-listed path: the
	// allow-list reads the header only.
	req = httptest.NewRequest(http.MethodGet, "/api/orders?token="+key, nil)
	req.RemoteAddr = "192.168.1.50:1234"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("kiosk key in the query string: got %d; want 401", rec.Code)
	}
}

func TestRequireToken_FullTokenStillWorksWithKioskStore(t *testing.T) {
	store, _ := newKioskStore(t)
	h := newKioskAuthedHandler(store)
	for _, path := range []string{"/api/shots", "/api/orders", "/api/backup", "/api/orders/kiosk-key"} {
		if code := serveKiosk(t, h, http.MethodGet, path, testToken); code != http.StatusOK {
			t.Errorf("GET %s with the full token: got %d; want 200", path, code)
		}
	}
	if code := serveKiosk(t, h, http.MethodPost, "/api/orders/kiosk-key/rotate", testToken); code != http.StatusOK {
		t.Errorf("POST the rotate route with the full token: got %d; want 200", code)
	}
}

func TestRequireToken_NilKioskStoreAcceptsNoKioskKey(t *testing.T) {
	store, _ := newKioskStore(t)
	key, err := store.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	h := newKioskAuthedHandler(nil)
	if code := serveKiosk(t, h, http.MethodGet, "/api/orders", key); code != http.StatusUnauthorized {
		t.Fatalf("kiosk key with no store wired: got %d; want 401", code)
	}
}

func TestRequireToken_RotatedKioskKeyStopsWorking(t *testing.T) {
	store, _ := newKioskStore(t)
	oldKey, err := store.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	h := newKioskAuthedHandler(store)
	if code := serveKiosk(t, h, http.MethodGet, "/api/orders", oldKey); code != http.StatusOK {
		t.Fatalf("old key before rotation: got %d; want 200", code)
	}
	newKey, err := store.Rotate()
	if err != nil {
		t.Fatalf("Rotate: %v", err)
	}
	if code := serveKiosk(t, h, http.MethodGet, "/api/orders", oldKey); code != http.StatusUnauthorized {
		t.Error("the old kiosk key must be rejected after rotation")
	}
	if code := serveKiosk(t, h, http.MethodGet, "/api/orders", newKey); code != http.StatusOK {
		t.Error("the new kiosk key must be accepted after rotation")
	}
}
