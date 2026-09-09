package library

import "testing"

// TestLowerOrEmpty_UnicodeCaseFolding guards #901's fix: a plain A-Z byte
// fold left accented grinder names (Éureka, Mühle) comparing unequal to
// their own lowercase form. strings.ToLower is Unicode-case-folding-aware,
// matching JS's String.prototype.toLowerCase() for these inputs.
func TestLowerOrEmpty_UnicodeCaseFolding(t *testing.T) {
	cases := []struct{ a, b string }{
		{"Éureka", "éureka"},
		{"MÜHLE", "mühle"},
		{"Über Grinder", "über grinder"},
	}
	for _, c := range cases {
		la, lb := lowerOrEmpty(c.a), lowerOrEmpty(c.b)
		if la != lb {
			t.Errorf("lowerOrEmpty(%q)=%q != lowerOrEmpty(%q)=%q", c.a, la, c.b, lb)
		}
	}
}

// TestUpsertKnownGrindSetting_UnicodeGrinderNameDedups exercises
// lowerOrEmpty's real caller: two grinder names differing only by accent
// case must be treated as the same grinder and dedup to a single entry,
// with the newest write winning.
func TestUpsertKnownGrindSetting_UnicodeGrinderNameDedups(t *testing.T) {
	lib := &Library{Beans: []Entity{{"id": int64(1), "name": "Test Bean"}}}

	if _, ok := UpsertKnownGrindSetting(lib, 1, "Éureka Mignon", "12"); !ok {
		t.Fatalf("expected bean id 1 to match")
	}
	bean, ok := UpsertKnownGrindSetting(lib, 1, "éureka mignon", "14")
	if !ok {
		t.Fatalf("expected bean id 1 to match")
	}
	settings, _ := bean["knownGrindSettings"].([]any)
	if len(settings) != 1 {
		t.Fatalf("expected accent-case-insensitive dedup to leave 1 entry, got %d: %+v", len(settings), settings)
	}
	entry, _ := settings[0].(Entity)
	if entry["grindSetting"] != "14" {
		t.Fatalf("expected newest grind setting to win, got %+v", entry)
	}
}
