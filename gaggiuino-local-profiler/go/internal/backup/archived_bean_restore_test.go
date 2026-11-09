package backup

import (
	"testing"
)

// TestRestore_ArchivedBeanStaysArchived restores a bundle whose only bean is
// archived and already carries an resolved-offer marker (#1958). A restore
// must not reactivate the bean — only a genuinely new bag with stock does —
// and must keep the marker as it was.
func TestRestore_ArchivedBeanStaysArchived(t *testing.T) {
	useImageDir(t)
	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)

	bean := map[string]any{
		"id": int64(7), "name": "Bundle Bean",
		"enabled": false, "emptyOfferBagId": int64(100),
		"bags": []any{
			map[string]any{"id": int64(100), "stock_g": float64(250), "openedAt": int64(1000), "sortOrder": int64(0)},
			map[string]any{"id": int64(200), "stock_g": float64(250), "openedAt": int64(2000), "sortOrder": int64(1)},
		},
	}
	bundle := map[string]any{
		"glp_backup":     true,
		"shots":          []any{},
		"coffee_library": map[string]any{"beans": []any{bean}},
	}
	restoreBundle(t, mux, handBuiltBackupZip(t, bundle, map[string][]byte{}))

	lib, err := deps.LibRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Beans) != 1 {
		t.Fatalf("restored %d beans, want 1", len(lib.Beans))
	}
	restored := lib.Beans[0]
	if enabled, ok := restored["enabled"].(bool); !ok || enabled {
		t.Fatalf("enabled = %v after the restore, want false", restored["enabled"])
	}
	if got, ok := jsInt(restored["emptyOfferBagId"]); !ok || got != 100 {
		t.Fatalf("emptyOfferBagId = %v (present %v) after the restore, want 100", restored["emptyOfferBagId"], ok)
	}
	if bags, _ := restored["bags"].([]any); len(bags) != 2 {
		t.Fatalf("restored %d bags, want both of them", len(bags))
	}
}

// jsInt reads a numeric field the way the library blob stores it after a
// JSON round trip.
func jsInt(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case int64:
		return n, true
	case int:
		return int64(n), true
	}
	return 0, false
}
