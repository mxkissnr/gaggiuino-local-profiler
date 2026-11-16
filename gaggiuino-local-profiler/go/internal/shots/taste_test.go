package shots

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// TestTasteTagOf: only the four shipped tags come back; anything else — an
// absent key, an empty string, a number, an unknown tag from a newer version —
// reads as no tag at all.
func TestTasteTagOf(t *testing.T) {
	for _, tag := range []string{tasteSour, tasteBitter, tasteBalanced, tasteThin} {
		if got := tasteTagOf(map[string]any{"tasteTag": tag}); got != tag {
			t.Errorf("tasteTagOf(%q) = %q, want %q", tag, got, tag)
		}
	}
	for _, ann := range []map[string]any{
		nil,
		{},
		{"tasteTag": ""},
		{"tasteTag": 5},
		{"tasteTag": 5.0},
		{"tasteTag": "astringent"},
		{"tasteTag": nil},
	} {
		if got := tasteTagOf(ann); got != "" {
			t.Errorf("tasteTagOf(%#v) = %q, want no tag", ann, got)
		}
	}
}

// TestAnnotate_TasteTagSetChangeClear drives the tag through the real
// annotate endpoint: set, replace, clear with null, set again, clear with "".
func TestAnnotate_TasteTagSetChangeClear(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "Espresso", nil, nil)
	mux := newMux(h)

	storedTag := func() string {
		t.Helper()
		ann, err := repo.GetAnnotation(1)
		if err != nil {
			t.Fatalf("GetAnnotation: %v", err)
		}
		return annotationStr(ann, "tasteTag")
	}
	annotate := func(body string) {
		t.Helper()
		rec := doJSON(t, mux, http.MethodPost, "/api/shots/1/annotate", []byte(body))
		if rec.Code != http.StatusOK {
			t.Fatalf("annotate %s: status = %d; body=%s", body, rec.Code, rec.Body.String())
		}
	}

	annotate(`{"tasteTag":"sour"}`)
	if got := storedTag(); got != tasteSour {
		t.Fatalf("after setting sour: tag = %q, want sour", got)
	}
	annotate(`{"tasteTag":"bitter"}`)
	if got := storedTag(); got != tasteBitter {
		t.Fatalf("after replacing with bitter: tag = %q, want bitter", got)
	}
	annotate(`{"tasteTag":null}`)
	if got := storedTag(); got != "" {
		t.Fatalf("after null: tag = %q, want none", got)
	}
	annotate(`{"tasteTag":"thin"}`)
	if got := storedTag(); got != tasteThin {
		t.Fatalf("after setting thin: tag = %q, want thin", got)
	}
	annotate(`{"tasteTag":""}`)
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if _, ok := ann["tasteTag"]; ok {
		t.Fatalf("after \"\": the key is still stored: %#v", ann)
	}
}

// TestAnnotate_TasteTagRejected: an unknown string and a number are both a
// 400, and the stored tag stays what it was.
func TestAnnotate_TasteTagRejected(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "Espresso", nil, map[string]any{"tasteTag": tasteSour})
	mux := newMux(h)

	for _, body := range []string{`{"tasteTag":"astringent"}`, `{"tasteTag":5}`} {
		rec := doJSON(t, mux, http.MethodPost, "/api/shots/1/annotate", []byte(body))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("annotate %s: status = %d, want 400; body=%s", body, rec.Code, rec.Body.String())
		}
		resp := decodeBody(t, rec.Body.Bytes())
		issues, _ := resp["issues"].([]any)
		if len(issues) != 1 {
			t.Fatalf("annotate %s: issues = %#v, want one", body, resp["issues"])
		}
		issue, _ := issues[0].(map[string]any)
		if issue["path"] != "tasteTag" {
			t.Errorf("annotate %s: issue path = %v, want tasteTag", body, issue["path"])
		}

		ann, err := repo.GetAnnotation(1)
		if err != nil {
			t.Fatalf("GetAnnotation: %v", err)
		}
		if got := annotationStr(ann, "tasteTag"); got != tasteSour {
			t.Fatalf("after a rejected %s: tag = %q, want the stored sour", body, got)
		}
	}
}

// TestAnnotate_OtherFieldKeepsTasteTag: a patch that never mentions the tag
// leaves it alone.
func TestAnnotate_OtherFieldKeepsTasteTag(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "Espresso", nil, map[string]any{"tasteTag": tasteBalanced})
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/1/annotate", []byte(`{"notes":"tasty"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if got := annotationStr(ann, "tasteTag"); got != tasteBalanced {
		t.Errorf("tag = %q, want the kept balanced", got)
	}
	if got := annotationStr(ann, "notes"); got != "tasty" {
		t.Errorf("notes = %q, want tasty", got)
	}
}

// TestValidateAnnotation_UnknownTasteTagPasses: the restore path drops every
// annotation that fails ValidateAnnotation, so an unknown tag must not be
// checked there.
func TestValidateAnnotation_UnknownTasteTagPasses(t *testing.T) {
	if issues := ValidateAnnotation(map[string]any{"tasteTag": "astringent"}); len(issues) != 0 {
		t.Errorf("ValidateAnnotation(unknown tasteTag) = %v, want no issues", issues)
	}
}

// TestTasteTagNeverChangesScore: the tag is advice-only; scoring must return
// exactly what the untagged shot returns.
func TestTasteTagNeverChangesScore(t *testing.T) {
	want := CalcShotScoreDetail(fullScoreShot(300), nil)
	for _, tag := range TasteTags() {
		tagged := fullScoreShot(300)
		ann, _ := tagged["annotation"].(map[string]any)
		ann["tasteTag"] = tag
		if got := CalcShotScoreDetail(tagged, nil); !reflect.DeepEqual(got, want) {
			t.Errorf("score with tag %q = %+v, want %+v", tag, got, want)
		}
	}
}

// TestAdvice_NoTagIdenticalToToday pins the four untagged outcomes to today's
// literal wording, so a taste-tagged build keeps the old advice for every shot
// without a tag.
func TestAdvice_NoTagIdenticalToToday(t *testing.T) {
	const coffee, grinder, profile = "Kenya AA", "Niche Zero", "Espresso"
	shotAt := func(grind string) *comparativeMatch {
		t.Helper()
		m := newComparativeMatch(comparableShot(1, coffee, grinder, grind, 18, profile))
		if m == nil {
			t.Fatal("newComparativeMatch returned nil")
		}
		return m
	}
	best10 := []comparableSibling{{grind: 10, score: 100}}

	cases := []struct {
		name string
		m    *comparativeMatch
		sibs []comparableSibling
		want ComparativeGrindAdvice
	}{
		{
			name: "finer",
			m:    shotAt("12"),
			sibs: best10,
			want: ComparativeGrindAdvice{
				Type: "finer", Icon: "📊",
				Text:             "1 comparable shots: grind 10 → score 100 — grind finer",
				SampleCount:      1,
				BestGrindSetting: 10,
				BestScore:        100,
			},
		},
		{
			name: "coarser",
			m:    shotAt("8"),
			sibs: best10,
			want: ComparativeGrindAdvice{
				Type: "coarser", Icon: "📊",
				Text:             "1 comparable shots: grind 10 → score 100 — grind coarser",
				SampleCount:      1,
				BestGrindSetting: 10,
				BestScore:        100,
			},
		},
		{
			name: "on target",
			m:    shotAt("10.2"),
			sibs: best10,
			want: ComparativeGrindAdvice{
				Type: "ok", Icon: "📊",
				Text:             "1 comparable shots confirm your grind setting (avg score 100)",
				SampleCount:      1,
				BestGrindSetting: 10,
				BestScore:        100,
			},
		},
		{
			name: "no current grind",
			m:    shotAt(""),
			sibs: best10,
			want: ComparativeGrindAdvice{
				Type: "ok", Icon: "📊",
				Text:             "1 comparable shots confirm your grind setting (avg score 100)",
				SampleCount:      1,
				BestGrindSetting: 10,
				BestScore:        100,
			},
		},
	}

	for _, c := range cases {
		got := c.m.advice(c.sibs, "en")
		if got == nil {
			t.Fatalf("%s: expected advice", c.name)
		}
		if !reflect.DeepEqual(*got, c.want) {
			t.Errorf("%s: advice = %+v, want %+v", c.name, *got, c.want)
		}
	}
}

// TestAdvice_TasteTable walks every cell of the taste/grind-direction table:
// a current grind of 10 against a best setting of 10 is "no direction", 12 is
// "finer" and 8 is "coarser".
func TestAdvice_TasteTable(t *testing.T) {
	const coffee, grinder, profile = "Kenya AA", "Niche Zero", "Espresso"
	sibs := []comparableSibling{{grind: 10, score: 100}}

	cases := []struct {
		tag      string
		grind    string
		wantType string
		wantKey  string
	}{
		// No tag: unchanged in every direction.
		{"", "10", "ok", "compare_ok"},
		{"", "12", "finer", "compare_finer"},
		{"", "8", "coarser", "compare_coarser"},
		// Unknown tag reads as no tag.
		{"astringent", "12", "finer", "compare_finer"},

		// Sour points finer; agreeing keeps today's advice, disagreeing is a
		// conflict that holds the grind.
		{tasteSour, "10", "finer", "compare_taste_finer"},
		{tasteSour, "12", "finer", "compare_finer"},
		{tasteSour, "8", "ok", "compare_taste_conflict"},

		// Bitter points coarser, the mirror image.
		{tasteBitter, "10", "coarser", "compare_taste_coarser"},
		{tasteBitter, "12", "ok", "compare_taste_conflict"},
		{tasteBitter, "8", "coarser", "compare_coarser"},

		// Balanced holds whenever the numbers would move the grind.
		{tasteBalanced, "10", "ok", "compare_ok"},
		{tasteBalanced, "12", "ok", "compare_taste_hold"},
		{tasteBalanced, "8", "ok", "compare_taste_hold"},

		// Thin changes nothing.
		{tasteThin, "10", "ok", "compare_ok"},
		{tasteThin, "12", "finer", "compare_finer"},
		{tasteThin, "8", "coarser", "compare_coarser"},
	}

	for _, c := range cases {
		shot := comparableShot(1, coffee, grinder, c.grind, 18, profile)
		if c.tag != "" {
			ann, _ := shot["annotation"].(map[string]any)
			ann["tasteTag"] = c.tag
		}
		m := newComparativeMatch(shot)
		if m == nil {
			t.Fatalf("tag %q grind %q: newComparativeMatch returned nil", c.tag, c.grind)
		}
		got := m.advice(sibs, "en")
		if got == nil {
			t.Fatalf("tag %q grind %q: expected advice", c.tag, c.grind)
		}
		if got.Type != c.wantType {
			t.Errorf("tag %q grind %q: Type = %q, want %q", c.tag, c.grind, got.Type, c.wantType)
		}
		wantText := cardTextf("en", c.wantKey, 1, 10.0, 100)
		if c.wantKey == "compare_ok" {
			wantText = cardTextf("en", c.wantKey, 1, 100)
		}
		if got.Text != wantText {
			t.Errorf("tag %q grind %q: Text = %q, want %q", c.tag, c.grind, got.Text, wantText)
		}
	}
}

// TestAdvice_NoCurrentGrindIgnoresTag: with no parseable grind setting of its
// own there is nothing for the tag to move, so today's "ok" stands.
func TestAdvice_NoCurrentGrindIgnoresTag(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "", 18, "Espresso")
	ann, _ := shot["annotation"].(map[string]any)
	ann["tasteTag"] = tasteSour
	m := newComparativeMatch(shot)
	if m == nil {
		t.Fatal("newComparativeMatch returned nil")
	}
	got := m.advice([]comparableSibling{{grind: 10, score: 100}}, "en")
	if got == nil {
		t.Fatal("expected advice")
	}
	if got.Type != "ok" || got.Text != cardTextf("en", "compare_ok", 1, 100) {
		t.Errorf("advice = %+v, want the untagged ok", *got)
	}
}

// TestAdvice_SourBitterSiblingsDoNotRank: a disliked cup's high score must not
// decide the best setting.
func TestAdvice_SourBitterSiblingsDoNotRank(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "11", 18, "Espresso")
	m := newComparativeMatch(shot)
	if m == nil {
		t.Fatal("newComparativeMatch returned nil")
	}
	tagged := []comparableSibling{
		{grind: 10, score: 95, tasteTag: tasteSour},
		{grind: 12, score: 80},
	}
	got := m.advice(tagged, "en")
	if got == nil {
		t.Fatal("expected advice")
	}
	if got.BestGrindSetting != 12 || got.SampleCount != 1 {
		t.Errorf("tagged advice best/count = %v/%d, want 12/1", got.BestGrindSetting, got.SampleCount)
	}

	untagged := []comparableSibling{{grind: 10, score: 95}, {grind: 12, score: 80}}
	before := m.advice(untagged, "en")
	if before == nil {
		t.Fatal("expected advice without tags")
	}
	if before.BestGrindSetting != 10 || before.SampleCount != 2 {
		t.Errorf("untagged advice best/count = %v/%d, want 10/2", before.BestGrindSetting, before.SampleCount)
	}
}

// TestAdvice_BalancedAndThinSiblingsStillRank: only sour and bitter siblings
// leave the ranking.
func TestAdvice_BalancedAndThinSiblingsStillRank(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "11", 18, "Espresso")
	m := newComparativeMatch(shot)
	if m == nil {
		t.Fatal("newComparativeMatch returned nil")
	}
	got := m.advice([]comparableSibling{
		{grind: 10, score: 95, tasteTag: tasteBalanced},
		{grind: 12, score: 80, tasteTag: tasteThin},
	}, "en")
	if got == nil {
		t.Fatal("expected advice")
	}
	if got.BestGrindSetting != 10 || got.SampleCount != 2 {
		t.Errorf("advice best/count = %v/%d, want 10/2", got.BestGrindSetting, got.SampleCount)
	}
}

// TestAdvice_AllSiblingsDislikedRankAsToday: when dropping the disliked ones
// would leave nothing to rank, all of them rank as before.
func TestAdvice_AllSiblingsDislikedRankAsToday(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "11", 18, "Espresso")
	m := newComparativeMatch(shot)
	if m == nil {
		t.Fatal("newComparativeMatch returned nil")
	}
	untagged := m.advice([]comparableSibling{{grind: 10, score: 95}, {grind: 12, score: 80}}, "en")
	tagged := m.advice([]comparableSibling{
		{grind: 10, score: 95, tasteTag: tasteSour},
		{grind: 12, score: 80, tasteTag: tasteBitter},
	}, "en")
	if untagged == nil || tagged == nil {
		t.Fatal("expected advice on both runs")
	}
	if !reflect.DeepEqual(*tagged, *untagged) {
		t.Errorf("all-disliked advice = %+v, want the untagged %+v", *tagged, *untagged)
	}
}

// TestAdvice_TagsKeepGrinderFilter: a tag never widens the comparable set — a
// sibling on another grinder stays out, tagged or not.
func TestAdvice_TagsKeepGrinderFilter(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "11", 18, "Espresso")
	plain := comparableShot(2, "Kenya AA", "Niche Zero", "10", 18, "Espresso")
	taggedOther := comparableShot(3, "Kenya AA", "Other Grinder", "12", 18, "Espresso")
	ann, _ := taggedOther["annotation"].(map[string]any)
	ann["tasteTag"] = tasteBalanced

	withOther := ComputeComparativeGrindAdvice(shot, []Shot{plain, taggedOther})
	withoutOther := ComputeComparativeGrindAdvice(shot, []Shot{plain})
	if withOther == nil || withoutOther == nil {
		t.Fatal("expected advice")
	}
	if !reflect.DeepEqual(*withOther, *withoutOther) {
		t.Errorf("advice with a tagged other-grinder sibling = %+v, want %+v", *withOther, *withoutOther)
	}

	sour := comparableShot(4, "Kenya AA", "Niche Zero", "11", 18, "Espresso")
	sourAnn, _ := sour["annotation"].(map[string]any)
	sourAnn["tasteTag"] = tasteSour
	if advice := ComputeComparativeGrindAdvice(sour, []Shot{taggedOther}); advice != nil {
		t.Errorf("advice = %+v, want nil: the only sibling is on another grinder", advice)
	}
}

// TestGetComparativeGrindAdvice_ReadsSiblingTags pins that the service path —
// the one the page actually uses — reads the siblings' tags out of the stored
// annotations, not just the current shot's.
func TestGetComparativeGrindAdvice_ReadsSiblingTags(t *testing.T) {
	_, repo, _ := newTestHandlers(t)

	seed := func(id int64, grind string, timestamp int64) Shot {
		t.Helper()
		s := comparableShot(id, "Kenya AA", "Niche Zero", grind, 18, "Espresso")
		s["timestamp"] = timestamp
		s["duration"] = int64(300)
		if err := repo.Upsert(s); err != nil {
			t.Fatalf("Upsert(%d): %v", id, err)
		}
		return s
	}
	seed(1, "11", 1700000000)
	seed(2, "10", 1700000001)
	seed(3, "12", 1700000002)

	svc := NewService(repo)
	cur, err := svc.GetByID(1)
	if err != nil || cur == nil {
		t.Fatalf("GetByID(1): err=%v", err)
	}

	before, err := svc.GetComparativeGrindAdvice(cur, "en")
	if err != nil || before == nil {
		t.Fatalf("first advice: err=%v advice=%+v", err, before)
	}
	// Equal scores at 10 and 12: the documented tiebreak picks the lower one.
	if before.BestGrindSetting != 10 || before.SampleCount != 2 {
		t.Fatalf("first advice best/count = %v/%d, want 10/2", before.BestGrindSetting, before.SampleCount)
	}

	if _, err := svc.PatchAnnotation(2, map[string]any{"tasteTag": tasteSour}); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}

	after, err := svc.GetComparativeGrindAdvice(cur, "en")
	if err != nil || after == nil {
		t.Fatalf("second advice: err=%v advice=%+v", err, after)
	}
	if after.BestGrindSetting != 12 || after.SampleCount != 1 {
		t.Errorf("after tagging the 10 sibling sour: best/count = %v/%d, want 12/1", after.BestGrindSetting, after.SampleCount)
	}
}

// TestCompareTasteTextAllLanguages: every shipped language carries all four
// new sentences, with no leftover format verb.
func TestCompareTasteTextAllLanguages(t *testing.T) {
	keys := []string{
		"compare_taste_finer", "compare_taste_coarser",
		"compare_taste_hold", "compare_taste_conflict",
	}
	for _, lang := range []string{"de", "en", "es", "fr", "it", "nl"} {
		for _, key := range keys {
			text := cardTextf(lang, key, 3, 10.5, 88)
			if text == "" {
				t.Errorf("%s/%s: empty text", lang, key)
			}
			if strings.Contains(text, "%!") {
				t.Errorf("%s/%s: bad format verbs in %q", lang, key, text)
			}
			if !strings.Contains(text, "3") || !strings.Contains(text, "10.5") || !strings.Contains(text, "88") {
				t.Errorf("%s/%s: %q does not carry the sample count, best setting and score", lang, key, text)
			}
		}
	}
}
