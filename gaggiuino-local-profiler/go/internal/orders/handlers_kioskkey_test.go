package orders

import (
	"net/http"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
)

// newKioskHandlers wires a real KioskKeyStore, backed by a fresh file in the
// test's temp dir, into the orders Handlers.
func newKioskHandlers(t *testing.T) (*Handlers, *auth.KioskKeyStore, string) {
	t.Helper()
	h, _, _ := newTestHandlers(t)
	path := filepath.Join(t.TempDir(), auth.KioskKeyFileName)
	store, err := auth.LoadKioskKeyStore(path)
	if err != nil {
		t.Fatalf("LoadKioskKeyStore: %v", err)
	}
	h.SetKioskKeyStore(store)
	return h, store, path
}

func TestKioskKey_GetCreatesThenReturnsSameKey(t *testing.T) {
	h, store, _ := newKioskHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/orders/kiosk-key", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q; want no-store", cc)
	}
	key, _ := decodeBody(t, rec.Body.Bytes())["kioskKey"].(string)
	if len(key) != 64 {
		t.Fatalf("kioskKey = %q; want a 64-char hex key", key)
	}
	if !store.Valid(key) {
		t.Error("the returned key must be the store's current key")
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/orders/kiosk-key", nil)
	again, _ := decodeBody(t, rec.Body.Bytes())["kioskKey"].(string)
	if again != key {
		t.Errorf("second GET returned %q; want the same key %q", again, key)
	}
}

func TestKioskKey_GetPersistsAcrossStoreReload(t *testing.T) {
	h, _, path := newKioskHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/orders/kiosk-key", nil)
	key, _ := decodeBody(t, rec.Body.Bytes())["kioskKey"].(string)

	reloaded, err := auth.LoadKioskKeyStore(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !reloaded.Valid(key) {
		t.Error("the kiosk key must survive a store reload")
	}
}

func TestKioskKey_RotateReturnsNewKeyAndInvalidatesOld(t *testing.T) {
	h, store, _ := newKioskHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/orders/kiosk-key", nil)
	oldKey, _ := decodeBody(t, rec.Body.Bytes())["kioskKey"].(string)

	rec = doJSON(t, mux, http.MethodPost, "/api/orders/kiosk-key/rotate", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate status = %d; body=%s", rec.Code, rec.Body.String())
	}
	newKey, _ := decodeBody(t, rec.Body.Bytes())["kioskKey"].(string)
	if len(newKey) != 64 {
		t.Fatalf("rotated kioskKey = %q; want a 64-char hex key", newKey)
	}
	if newKey == oldKey {
		t.Fatal("rotate returned the same key")
	}
	if store.Valid(oldKey) {
		t.Error("the old key must stop working immediately after rotate")
	}
	if !store.Valid(newKey) {
		t.Error("the new key must be the store's current key")
	}

	// A fresh GET now serves the rotated key, not the old one.
	rec = doJSON(t, mux, http.MethodGet, "/api/orders/kiosk-key", nil)
	if got, _ := decodeBody(t, rec.Body.Bytes())["kioskKey"].(string); got != newKey {
		t.Errorf("GET after rotate returned %q; want %q", got, newKey)
	}
}

// TestKioskKey_RoutesWithoutStoreAnswer503 guards the nil-store path: the
// routes must fail closed with a clear status instead of panicking.
func TestKioskKey_RoutesWithoutStoreAnswer503(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/orders/kiosk-key"},
		{http.MethodPost, "/api/orders/kiosk-key/rotate"},
	} {
		rec := doJSON(t, mux, c.method, c.path, nil)
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("%s %s without a store: got %d; want 503", c.method, c.path, rec.Code)
		}
	}
}

// TestKioskKey_RoutesRespectOrdersGate keeps the new routes behind the same
// isOrdersEnabled 404 as the rest of the subtree.
func TestKioskKey_RoutesRespectOrdersGate(t *testing.T) {
	h, _, _ := newKioskHandlers(t)
	pointOptionsAt(t, `{"enable_orders":false}`)
	mux := newMux(h)
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/orders/kiosk-key"},
		{http.MethodPost, "/api/orders/kiosk-key/rotate"},
	} {
		rec := doJSON(t, mux, c.method, c.path, nil)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s with orders disabled: got %d; want 404", c.method, c.path, rec.Code)
		}
	}
}

// TestSettings_GetCarriesNoSecret answers the plan's step 5: the kiosk key is
// allowed to read /api/orders/settings, so that response must not hand back any
// credential.
func TestSettings_GetCarriesNoSecret(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodGet, "/api/orders/settings", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	for field := range decodeBody(t, rec.Body.Bytes()) {
		switch field {
		case "apiToken", "token", "kioskKey", "password", "secret":
			t.Errorf("GET /api/orders/settings exposes %q; it is readable with the orders-only kiosk key", field)
		}
	}
}
