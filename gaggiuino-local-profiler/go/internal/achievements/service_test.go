package achievements

import (
	"testing"
	"time"
	"unicode/utf8"
)

// TestContract_EmptyState pins the Go GET /api/achievements response for a
// fresh DB against the captured Node fixture (testdata/empty_en.json,
// generated from lib/services/AchievementService.js — see the file header
// there). Every badge's id/card/secret/unlocked/stamp/progress must match;
// unlockedAt is null for all of them on an empty DB.
func TestContract_EmptyState(t *testing.T) {
	env := newTestEnv(t)
	got := env.get(t, "en")
	want := loadFixture(t, "empty_en.json")

	// cards array — exact.
	gotCards := toStringSlice(got["cards"])
	wantCards := toStringSlice(want["cards"])
	if len(gotCards) != len(wantCards) {
		t.Fatalf("cards = %v, want %v", gotCards, wantCards)
	}
	for i := range gotCards {
		if gotCards[i] != wantCards[i] {
			t.Fatalf("cards[%d] = %q, want %q", i, gotCards[i], wantCards[i])
		}
	}

	gotBadges, _ := got["badges"].([]any)
	wantBadges, _ := want["badges"].([]any)
	if len(gotBadges) != len(wantBadges) {
		t.Fatalf("badge count = %d, want %d", len(gotBadges), len(wantBadges))
	}
	for i := range wantBadges {
		g, _ := gotBadges[i].(map[string]any)
		w, _ := wantBadges[i].(map[string]any)
		for _, key := range []string{"id", "card", "secret", "unlocked", "stamp"} {
			if !jsonEqual(g[key], w[key]) {
				t.Errorf("badge[%d] %q = %#v, want %#v", i, key, g[key], w[key])
			}
		}
		if w["unlockedAt"] != nil {
			t.Errorf("fixture badge[%d] unlockedAt should be null on empty DB", i)
		}
		if g["unlockedAt"] != nil {
			t.Errorf("badge[%d] unlockedAt = %#v, want null", i, g["unlockedAt"])
		}
		wp, wHasProg := w["progress"]
		gp, gHasProg := g["progress"]
		if wHasProg != gHasProg {
			t.Errorf("badge[%d] progress presence = %v, want %v", i, gHasProg, wHasProg)
		}
		if wHasProg && gHasProg {
			gm, _ := gp.(map[string]any)
			wm, _ := wp.(map[string]any)
			if jsonNumber(gm["current"]) != jsonNumber(wm["current"]) || jsonNumber(gm["target"]) != jsonNumber(wm["target"]) {
				t.Errorf("badge[%d] progress = %#v, want %#v", i, gp, wp)
			}
		}
	}
}

// TestFirstShotUnlocks drives a real state change (CLAUDE.md's regression
// policy): no shots -> first_shot locked; add a shot -> first_shot unlocked,
// shots_10 progress advances to 1.
func TestFirstShotUnlocks(t *testing.T) {
	env := newTestEnv(t)

	before := badgeByID(env.get(t, "en"))
	if before["first_shot"]["unlocked"] != false {
		t.Fatalf("first_shot should start locked")
	}

	env.insertShot(t, 5, time.Now().Unix(), map[string]any{"datapoints": map[string]any{}}, nil)

	after := badgeByID(env.get(t, "en"))
	if after["first_shot"]["unlocked"] != true {
		t.Fatalf("first_shot should unlock after a shot is saved")
	}
	if after["first_shot"]["unlockedAt"] == nil {
		t.Errorf("unlocked badge must carry a numeric unlockedAt")
	}
	prog, _ := after["shots_10"]["progress"].(map[string]any)
	if prog == nil || jsonNumber(prog["current"]) != 1 {
		t.Errorf("shots_10 progress = %#v, want current 1", after["shots_10"]["progress"])
	}
}

// TestSecretBadgeHiddenUntilUnlocked: a locked secret badge carries no
// stamp/name/description; unlocking it (a palindrome native id >= 100)
// reveals all three in the requested language.
func TestSecretBadgeHiddenUntilUnlocked(t *testing.T) {
	env := newTestEnv(t)

	locked := badgeByID(env.get(t, "de"))["secret_palindrome_id"]
	if locked["unlocked"] != false {
		t.Fatalf("secret should start locked")
	}
	for _, key := range []string{"stamp", "name", "description"} {
		if _, present := locked[key]; present {
			t.Errorf("locked secret leaks %q: %#v", key, locked[key])
		}
	}

	// id 121 is a palindrome >= 100 -> secret_palindrome_id.
	env.insertShot(t, 121, time.Now().Unix(), map[string]any{"datapoints": map[string]any{}}, nil)

	unlocked := badgeByID(env.get(t, "de"))["secret_palindrome_id"]
	if unlocked["unlocked"] != true {
		t.Fatalf("secret_palindrome_id should unlock on a palindrome shot id")
	}
	name, _ := unlocked["name"].(string)
	if name == "" || !utf8.ValidString(name) {
		t.Errorf("unlocked secret name = %q, want decoded German text", name)
	}
	if unlocked["stamp"] != "target" {
		t.Errorf("unlocked secret stamp = %v, want target", unlocked["stamp"])
	}
}

// TestSecretsTableDecodes verifies every base64 string in secretsTable
// decodes to non-empty valid UTF-8 for all six languages (guards the
// one-off transcription from lib/achievements/secrets.js).
func TestSecretsTableDecodes(t *testing.T) {
	for id := range secretsTable {
		for _, lang := range []string{"de", "en", "it", "fr", "es", "nl"} {
			sc, ok := getSecretCopy(id, lang)
			if !ok {
				t.Fatalf("getSecretCopy(%q,%q) not ok", id, lang)
			}
			if sc.Name == "" || !utf8.ValidString(sc.Name) {
				t.Errorf("%s/%s name invalid: %q", id, lang, sc.Name)
			}
			if sc.Description == "" || !utf8.ValidString(sc.Description) {
				t.Errorf("%s/%s description invalid: %q", id, lang, sc.Description)
			}
		}
	}
}

// TestGetState_SkipsFullEvaluateWhenNothingChanged pins the #956
// fingerprint gate: GET /api/achievements must not re-run the full
// evaluateAll(nil) context scan when no shot/annotation/order/bean/
// maintenance state moved since the last pass, and must run it again the
// moment one does. The probe: unlock a badge via a read, delete its row
// behind the service's back, then read again — an unchanged fingerprint
// means no re-evaluation, so the row stays gone; a new shot moves the
// fingerprint and the badge comes back.
func TestGetState_SkipsFullEvaluateWhenNothingChanged(t *testing.T) {
	env := newTestEnv(t)

	env.insertShot(t, 5, time.Now().Unix(), map[string]any{"datapoints": map[string]any{}}, nil)
	if badgeByID(env.get(t, "en"))["first_shot"]["unlocked"] != true {
		t.Fatalf("first_shot should unlock after the first read")
	}

	// Erase the persisted unlock. If GetState re-evaluated unconditionally
	// (pre-#956 behaviour) the next read would immediately re-unlock it.
	if _, err := env.db.Exec(`DELETE FROM achievements WHERE id = 'first_shot'`); err != nil {
		t.Fatalf("deleting achievement row: %v", err)
	}

	if got := badgeByID(env.get(t, "en"))["first_shot"]["unlocked"]; got != false {
		t.Fatalf("first_shot re-unlocked with no data change — fingerprint gate not skipping evaluateAll (got unlocked=%v)", got)
	}

	// A new shot moves the fingerprint -> evaluateAll runs again.
	env.insertShot(t, 6, time.Now().Unix(), map[string]any{"datapoints": map[string]any{}}, nil)
	if badgeByID(env.get(t, "en"))["first_shot"]["unlocked"] != true {
		t.Fatalf("first_shot should re-unlock after a new shot changes the fingerprint")
	}
}

// TestChangeFingerprint_MovesOnEachRelevantWrite guards the aggregate set
// ChangeFingerprint digests — every table buildContext reads must shift it.
func TestChangeFingerprint_MovesOnEachRelevantWrite(t *testing.T) {
	env := newTestEnv(t)
	repo := NewRepository(env.db)

	last, err := repo.ChangeFingerprint()
	if err != nil {
		t.Fatalf("ChangeFingerprint: %v", err)
	}
	moved := func(what string) {
		t.Helper()
		fp, err := repo.ChangeFingerprint()
		if err != nil {
			t.Fatalf("ChangeFingerprint after %s: %v", what, err)
		}
		if fp == last {
			t.Fatalf("fingerprint did not move after %s (%q)", what, fp)
		}
		last = fp
	}

	env.insertShot(t, 5, time.Now().Unix(), map[string]any{"datapoints": map[string]any{}}, nil)
	moved("shot insert")

	if _, err := env.db.Exec(`INSERT INTO annotations (shot_id, data) VALUES (5, '{"dose":18}')`); err != nil {
		t.Fatalf("annotation insert: %v", err)
	}
	moved("annotation insert")

	if _, err := env.db.Exec(`UPDATE annotations SET data = '{"dose":18,"note":"edited"}' WHERE shot_id = 5`); err != nil {
		t.Fatalf("annotation edit: %v", err)
	}
	moved("annotation edit")

	if _, err := env.db.Exec(`INSERT INTO trash (shot_id, deleted_at) VALUES (5, 1)`); err != nil {
		t.Fatalf("trash insert: %v", err)
	}
	moved("trash insert")

	if _, err := env.db.Exec(`INSERT INTO library (key, data) VALUES ('beans', '[{"id":1}]')`); err != nil {
		t.Fatalf("library write: %v", err)
	}
	moved("library write")

	if _, err := env.db.Exec(`INSERT INTO kv (key, value) VALUES ('menu', '[]')`); err != nil {
		t.Fatalf("kv write: %v", err)
	}
	moved("kv write")

	if _, err := env.db.Exec(`INSERT INTO orders (id, data, machine_id) VALUES ('o1', '{}', 1)`); err != nil {
		t.Fatalf("order write: %v", err)
	}
	moved("order write")
}

func toStringSlice(v any) []string {
	arr, _ := v.([]any)
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		s, _ := x.(string)
		out = append(out, s)
	}
	return out
}

func jsonEqual(a, b any) bool {
	if an, aok := numAsFloat(a); aok {
		if bn, bok := numAsFloat(b); bok {
			return an == bn
		}
		return false
	}
	return a == b
}

func numAsFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

func jsonNumber(v any) float64 {
	f, _ := numAsFloat(v)
	return f
}
