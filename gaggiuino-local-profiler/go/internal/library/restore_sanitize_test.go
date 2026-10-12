package library

import (
	"reflect"
	"strings"
	"testing"
)

// TestSanitizeBeanFields_BagRules covers #1603: a restored bag's edited
// fields go through the same rules as the edit route (roastDate length,
// stock_g/price_eur numeric, batchNumber length) while structural keys are
// kept and a non-object bag entry is dropped.
func TestSanitizeBeanFields_BagRules(t *testing.T) {
	bean := Entity{
		"name": "Bag Bean",
		"bags": []any{
			Entity{
				"id":          int64(7),
				"openedAt":    int64(6),
				"emptiedAt":   int64(5),
				"stock_g":     "lots",
				"batchNumber": strings.Repeat("x", 60),
				"roastDate":   "2026-01-01-extra",
			},
			"not-an-object",
			Entity{"id": int64(8), "stock_g": float64(250), "price_eur": float64(-3)},
		},
	}

	out := SanitizeBeanFields(bean)
	bags, ok := out["bags"].([]any)
	if !ok {
		t.Fatalf("bags missing or wrong type: %#v", out["bags"])
	}
	if len(bags) != 2 {
		t.Fatalf("bags = %d, want 2 (the non-object entry must be dropped)", len(bags))
	}

	b0, ok := bags[0].(Entity)
	if !ok {
		t.Fatalf("bags[0] = %#v, want Entity", bags[0])
	}
	if b0["stock_g"] != nil {
		t.Errorf("stock_g = %v, want nil for a non-numeric value", b0["stock_g"])
	}
	if s, _ := b0["batchNumber"].(string); len(s) != 50 {
		t.Errorf("batchNumber = %q (len %d), want 50 chars", s, len(s))
	}
	if s, _ := b0["roastDate"].(string); len(s) != 10 {
		t.Errorf("roastDate = %q, want 10 chars", s)
	}
	if b0["id"] != int64(7) || b0["openedAt"] != int64(6) || b0["emptiedAt"] != int64(5) {
		t.Errorf("bag structural keys not kept: %#v", b0)
	}

	b1, ok := bags[1].(Entity)
	if !ok {
		t.Fatalf("bags[1] = %#v, want Entity", bags[1])
	}
	if b1["stock_g"] != float64(250) {
		t.Errorf("stock_g = %v, want 250", b1["stock_g"])
	}
	if b1["price_eur"] != nil {
		t.Errorf("price_eur = %v, want nil for a negative value", b1["price_eur"])
	}
}

func TestSanitizeMilkEmoji(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want string
	}{
		{"flag kept", "🇩🇪", "🇩🇪"},
		{"nine emoji fall back", strings.Repeat("🥛", 9), "🥛"},
		{"markup falls back", "<b>", "🥛"},
		{"empty falls back", "", "🥛"},
		{"trimmed", "  🥛  ", "🥛"},
		{"non-string falls back", 42, "🥛"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeMilkEmoji(tc.in); got != tc.want {
				t.Errorf("sanitizeMilkEmoji(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestBeanFields_CreateRestoreParity proves the create and restore paths
// agree on every field beanFields owns (#1603), so the two can no longer
// drift the way the hand-written lists did.
func TestBeanFields_CreateRestoreParity(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	body := Entity{
		"name": "Parity Bean", "roaster": "Roaster", "roastDate": "2026-01-01",
		"notes": "notes", "origin": "ET", "origins": []any{Entity{"code": "ET"}},
		"variety": "Heirloom", "species": "arabica", "category": "filter",
		"process": "washed", "flavors": []any{"berry"}, "roastType": "medium",
		"region": "Yirgacheffe", "altitude_m": 1900, "importer": "Imp",
		"harvest": "2025", "price_eur": 12.5, "producer": "Prod",
		"certification": "organic", "brewTempC": 93, "brewRatio": "1:16",
		"brewTimeS": 150, "brewNotes": "tasty", "enabled": true,
	}

	created, _, err := CreateBean(repo, t.TempDir(), body)
	if err != nil {
		t.Fatalf("CreateBean: %v", err)
	}
	restored := SanitizeBeanFields(body)

	for k := range beanFields(body) {
		if !reflect.DeepEqual(created[k], restored[k]) {
			t.Errorf("key %q: create=%#v restore=%#v", k, created[k], restored[k])
		}
	}
}
