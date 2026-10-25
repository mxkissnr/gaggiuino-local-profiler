package auth

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// KioskKeyFileName is the kiosk key file's name. It sits next to the API token
// file (see KioskKeyFileFor) so one data-directory backup carries both.
const KioskKeyFileName = "kiosk_key"

// KioskKeyFileFor returns the kiosk key path that belongs next to tokenPath.
func KioskKeyFileFor(tokenPath string) string {
	return filepath.Join(filepath.Dir(tokenPath), KioskKeyFileName)
}

// KioskKeyStore holds the guest kiosk's orders-only key — a second credential,
// separate from the full API token, that RequireToken accepts only on the
// routes a kiosk tablet needs (see kioskRoutes).
//
// The key is generated lazily: a store loaded from a missing file stays empty
// and writes nothing until Get or Rotate is called, so an install that never
// uses a kiosk never gains a second secret on disk.
type KioskKeyStore struct {
	mu   sync.RWMutex
	path string
	key  string // empty until Get/Rotate creates one
}

// LoadKioskKeyStore reads the key at path, or returns an empty store when the
// file does not exist yet. A file that exists but is empty is treated like a
// missing one, matching LoadOrCreateToken's handling of a blank token file.
func LoadKioskKeyStore(path string) (*KioskKeyStore, error) {
	s := &KioskKeyStore{path: path}
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		s.key = strings.TrimSpace(string(data))
	case os.IsNotExist(err):
	default:
		return nil, err
	}
	return s, nil
}

// Get returns the kiosk key, generating and persisting one on the first call.
func (s *KioskKeyStore) Get() (string, error) {
	if s == nil {
		return "", errors.New("auth: no kiosk key store configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.key != "" {
		return s.key, nil
	}
	key, err := writeNewToken(s.path)
	if err != nil {
		return "", err
	}
	s.key = key
	return key, nil
}

// Rotate replaces the kiosk key with a freshly generated one and returns it.
// The previous key stops authenticating as soon as this returns, because Valid
// compares against the in-memory key only.
func (s *KioskKeyStore) Rotate() (string, error) {
	if s == nil {
		return "", errors.New("auth: no kiosk key store configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key, err := writeNewToken(s.path)
	if err != nil {
		return "", err
	}
	s.key = key
	return key, nil
}

// Valid reports whether candidate is the current kiosk key. A nil store, an
// ungenerated key and an empty candidate all return false.
func (s *KioskKeyStore) Valid(candidate string) bool {
	if s == nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return IsTokenValid(s.key, candidate)
}

// kioskRoutes is the kiosk key's entire surface: the method-and-path pairs a
// guest kiosk tablet needs to browse the menu, read orders and place one. It is
// an exact (method, path) match list on purpose — no prefix or wildcard rules,
// so a route added under /api/orders later is not reachable with the kiosk key
// until someone adds it here deliberately. Every other route keeps requiring
// the full API token.
//
// GET /api/events is absent (it would expose the whole live stream), as is
// every settings/menu write, every order status change and anything outside
// the orders domain.
var kioskRoutes = map[string]bool{
	"GET /api/menu":             true,
	"GET /api/orders/settings":  true,
	"GET /api/orders/queue-eta": true,
	"GET /api/orders":           true,
	"POST /api/orders":          true,
}

// kioskRouteAllowed reports whether this exact method+path is on the kiosk
// allow-list. The path is compared exactly: a query string cannot widen it,
// and neither can a trailing slash or a /api/orders/{id} suffix.
func kioskRouteAllowed(r *http.Request) bool {
	return kioskRoutes[r.Method+" "+r.URL.Path]
}
