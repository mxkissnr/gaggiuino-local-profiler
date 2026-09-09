package achievements

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// This file pins routes/achievements.js's GET /api/achievements wire
// contract — the "pin the essential shape, not the whole grammar" check
// orders/shots/library's contract_test.go established. The per-badge
// value-level parity against the captured Node fixture lives in
// service_test.go's TestContract_EmptyState; this file pins the invariants
// that hold for every response regardless of DB state.

// TestContract_AchievementsResponseShape: { cards: [7 keys], badges: [54] },
// every badge carries id/card/secret/unlocked, every badge's card is one of
// the seven CARD_KEYS, and exactly 6 badges are secret (48 open + 6 secret,
// the "stamp card" the frontend renders).
func TestContract_AchievementsResponseShape(t *testing.T) {
	env := newTestEnv(t)
	body := env.get(t, "en")

	gotCards := toStringSlice(body["cards"])
	if len(gotCards) != len(cardKeys) {
		t.Fatalf("cards = %v, want the %d CARD_KEYS %v", gotCards, len(cardKeys), cardKeys)
	}
	cardSet := map[string]bool{}
	for i, key := range gotCards {
		if key != cardKeys[i] {
			t.Errorf("cards[%d] = %q, want %q", i, key, cardKeys[i])
		}
		cardSet[key] = true
	}

	badges, _ := body["badges"].([]any)
	if len(badges) != 54 {
		t.Fatalf("badge count = %d, want 54 (48 open + 6 secret)", len(badges))
	}

	seen := map[string]bool{}
	secrets := 0
	for i, raw := range badges {
		b, _ := raw.(map[string]any)
		id, _ := b["id"].(string)
		if id == "" {
			t.Errorf("badge[%d] has no id: %#v", i, b)
			continue
		}
		if seen[id] {
			t.Errorf("duplicate badge id %q", id)
		}
		seen[id] = true

		card, _ := b["card"].(string)
		if !cardSet[card] {
			t.Errorf("badge %q card = %q, not one of %v", id, card, cardKeys)
		}
		if _, ok := b["unlocked"].(bool); !ok {
			t.Errorf("badge %q unlocked = %#v, want a bool", id, b["unlocked"])
		}
		isSecret, ok := b["secret"].(bool)
		if !ok {
			t.Errorf("badge %q secret = %#v, want a bool", id, b["secret"])
		}
		if isSecret {
			secrets++
			// A locked secret must not leak its copy (secrets.go's guard).
			if b["unlocked"] == false {
				for _, leaked := range []string{"stamp", "name", "description"} {
					if _, present := b[leaked]; present {
						t.Errorf("locked secret badge %q leaks %q", id, leaked)
					}
				}
			}
		} else {
			// Open badges always carry their real stamp.
			if _, present := b["stamp"]; !present {
				t.Errorf("open badge %q is missing its stamp", id)
			}
		}
	}
	if secrets != 6 {
		t.Errorf("secret badge count = %d, want 6", secrets)
	}
}

// TestContract_AchievementsLangFallback: an unsupported/absent ?lang= must
// not 500 or empty the response — routes/achievements.js falls back to 'en'.
func TestContract_AchievementsLangFallback(t *testing.T) {
	env := newTestEnv(t)
	for _, lang := range []string{"", "en", "de", "it", "fr", "es", "nl", "klingon"} {
		mux := http.NewServeMux()
		env.handler.RegisterRoutes(mux)
		rec := httptest.NewRecorder()
		path := "/api/achievements"
		if lang != "" {
			path += "?lang=" + lang
		}
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("lang=%q: status = %d, want 200", lang, rec.Code)
		}
	}
}
