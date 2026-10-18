package shots

import (
	"strings"
	"testing"
	"time"
)

// TestCardDate_UsesLocalDayAndLanguage pins #1620's date fix: the card date
// is the app's local day (like the shot list), not the UTC day, and the
// month name follows the card's language.
func TestCardDate_UsesLocalDayAndLanguage(t *testing.T) {
	old := time.Local
	t.Cleanup(func() { time.Local = old })
	time.Local = time.FixedZone("UTC+2", 2*60*60)

	// 2026-08-15 22:30 UTC is 2026-08-16 00:30 local: just after local
	// midnight, so a UTC formatter would still say the 15th.
	ts := time.Date(2026, 8, 15, 22, 30, 0, 0, time.UTC).Unix()

	for lang, want := range map[string]string{
		"de": "16. Aug. 2026",
		"en": "Aug 16, 2026",
		"fr": "16 août 2026",
		"it": "16 ago 2026",
	} {
		if got := cardDate(lang, ts); got != want {
			t.Errorf("cardDate(%q) = %q, want %q", lang, got, want)
		}
	}
}

// TestCardText_LanguageFallback pins the catalog's fallback: a regional tag
// resolves to its language, an unknown language resolves to English.
func TestCardText_LanguageFallback(t *testing.T) {
	if got := cardText("de-DE", "dose"); got != "Dosis" {
		t.Errorf("de-DE dose = %q, want Dosis", got)
	}
	if got := cardText("pt-BR", "dose"); got != "Dose" {
		t.Errorf("pt-BR dose = %q, want the English fallback", got)
	}
	if got := cardText("", "unknown"); got != "Unknown" {
		t.Errorf("empty lang unknown = %q, want English fallback", got)
	}
}

// TestCardSVG_LocalizedTextAndNativeShotID proves the rendered card text in
// German and English and that the header shows the machine's own shot
// number, not the global multi-machine id.
func TestCardSVG_LocalizedTextAndNativeShotID(t *testing.T) {
	shot := Shot(cardShotData())
	shot["id"] = int64(10_000_007) // machine 2's global id
	shot["nativeId"] = int64(7)    // that machine's own shot number
	score := 92

	de := newCardModel(shot, &score, "square", "", "dark", "de", cardDeps{}).svg()
	en := newCardModel(shot, &score, "square", "", "dark", "en", cardDeps{}).svg()

	for _, want := range []string{
		"Shot #7", "Herausragender Shot", "Dosis", "Extraktion",
		"Ziel Druck", "Druck Ø", "Dauer",
	} {
		if !strings.Contains(de, want) {
			t.Errorf("German card is missing %q", want)
		}
	}
	for _, want := range []string{
		"Shot #7", "Outstanding shot", "Dose", "Extraction",
		"Target pressure", "Pressure Ø", "Duration",
	} {
		if !strings.Contains(en, want) {
			t.Errorf("English card is missing %q", want)
		}
	}
	if strings.Contains(de, "10000007") || strings.Contains(en, "10000007") {
		t.Error("card header shows the global id instead of the machine-native id")
	}
	if strings.Contains(en, "Dosis") || strings.Contains(de, "Outstanding shot") {
		t.Error("card text did not follow the requested language")
	}
}

func TestNativeShotID_FallsBackToGlobalID(t *testing.T) {
	if got := nativeShotID(Shot{"id": int64(42)}); got != 42 {
		t.Errorf("nativeShotID without nativeId = %d, want the global id 42", got)
	}
	if got := nativeShotID(Shot{"id": int64(10_000_042), "nativeId": int64(42)}); got != 42 {
		t.Errorf("nativeShotID = %d, want 42", got)
	}
	if got := nativeShotID(Shot{"id": int64(42), "nativeId": int64(0)}); got != 42 {
		t.Errorf("nativeShotID with zero nativeId = %d, want the global id 42", got)
	}
}

// TestComparativeAdvice_Localized pins the comparison sentence in German and
// English, plus the English fallback for a language the catalog doesn't ship.
func TestComparativeAdvice_Localized(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "5.0", 18, "Espresso")
	m := newComparativeMatch(shot)
	siblings := []comparableSibling{{grind: 3, score: 100}}

	de := m.advice(siblings, "de")
	en := m.advice(siblings, "en")
	fallback := m.advice(siblings, "pt")
	if de == nil || en == nil || fallback == nil {
		t.Fatal("expected non-nil advice")
	}
	if !strings.Contains(de.Text, "feiner mahlen") {
		t.Errorf("German advice = %q, want a German sentence", de.Text)
	}
	if !strings.Contains(en.Text, "grind finer") {
		t.Errorf("English advice = %q, want an English sentence", en.Text)
	}
	if fallback.Text != en.Text {
		t.Errorf("unknown-language advice = %q, want the English fallback %q", fallback.Text, en.Text)
	}
}
