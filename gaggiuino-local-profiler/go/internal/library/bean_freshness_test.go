package library

import "testing"

// #1977: roast-level-aware bean freshness. These tests pin the two new bean
// fields at every write path — create, update and restore — plus the
// sanitizers themselves, so a level or window the UI can send is either stored
// exactly or dropped as a whole.

func TestSanitizeRoastLevel(t *testing.T) {
	valid := []string{"light", "medium-light", "medium", "medium-dark", "dark"}
	for _, level := range valid {
		if got := sanitizeRoastLevel(level); got != level {
			t.Errorf("sanitizeRoastLevel(%q) = %q, want %q", level, got, level)
		}
	}
	for _, bad := range []any{"", "extra-dark", "Light", " light", 3, nil, true} {
		if got := sanitizeRoastLevel(bad); got != "" {
			t.Errorf("sanitizeRoastLevel(%#v) = %q, want empty", bad, got)
		}
	}
}

func TestSanitizeBestForUse(t *testing.T) {
	tests := []struct {
		name        string
		from, until any
		wantFrom    any
		wantUntil   any
	}{
		{"valid numbers", float64(5), float64(10), int64(5), int64(10)},
		{"valid numeric strings", "5", "10", int64(5), int64(10)},
		{"single day window", float64(7), float64(8), int64(7), int64(8)},
		{"fraction rejected", float64(5.5), float64(10), nil, nil},
		{"missing until rejected", float64(5), nil, nil, nil},
		{"missing from rejected", nil, float64(10), nil, nil},
		{"zero rejected", float64(0), float64(10), nil, nil},
		{"past one year rejected", float64(5), float64(366), nil, nil},
		{"inverted rejected", float64(10), float64(5), nil, nil},
		{"equal rejected", float64(5), float64(5), nil, nil},
		{"non-numeric string rejected", "five", "ten", nil, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			from, until := sanitizeBestForUse(tt.from, tt.until)
			if from != tt.wantFrom || until != tt.wantUntil {
				t.Errorf("sanitizeBestForUse(%#v, %#v) = (%#v, %#v), want (%#v, %#v)",
					tt.from, tt.until, from, until, tt.wantFrom, tt.wantUntil)
			}
		})
	}
}

func TestCreateBean_RoastLevelAndBestForUse(t *testing.T) {
	h, repo, _ := newTestHandlers(t)

	bean, err := CreateBean(repo, h.imageDir, Entity{
		"name":          "Level Bean",
		"roastLevel":    "light",
		"bestFromDays":  float64(8),
		"bestUntilDays": float64(16),
	})
	if err != nil {
		t.Fatalf("CreateBean: %v", err)
	}
	if got, _ := bean["roastLevel"].(string); got != "light" {
		t.Errorf("roastLevel = %q, want light", got)
	}
	if got, _ := bean["bestFromDays"].(int64); got != 8 {
		t.Errorf("bestFromDays = %#v, want int64(8)", bean["bestFromDays"])
	}
	if got, _ := bean["bestUntilDays"].(int64); got != 16 {
		t.Errorf("bestUntilDays = %#v, want int64(16)", bean["bestUntilDays"])
	}

	// An unknown level must fall back to "unspecified", never be stored raw.
	other, err := CreateBean(repo, h.imageDir, Entity{
		"name":         "Bad Level Bean",
		"roastLevel":   "burnt",
		"bestFromDays": float64(20), // lone bound → dropped as a whole
	})
	if err != nil {
		t.Fatalf("CreateBean: %v", err)
	}
	if got, _ := other["roastLevel"].(string); got != "" {
		t.Errorf("roastLevel = %q, want empty for an unknown value", got)
	}
	if other["bestFromDays"] != nil || other["bestUntilDays"] != nil {
		t.Errorf("lone bound must be dropped: from=%#v until=%#v", other["bestFromDays"], other["bestUntilDays"])
	}
}

func TestUpdateBean_RoastLevelAndBestForUse(t *testing.T) {
	h, repo, _ := newTestHandlers(t)

	bean, err := CreateBean(repo, h.imageDir, Entity{"name": "Update Bean"})
	if err != nil {
		t.Fatalf("CreateBean: %v", err)
	}
	id, ok := bean["id"].(int64)
	if !ok {
		t.Fatalf("bean id not int64: %#v", bean["id"])
	}

	// Set both fields.
	updated, found, err := UpdateBean(repo, id, Entity{
		"roastLevel":    "dark",
		"bestFromDays":  float64(3),
		"bestUntilDays": float64(6),
	}, nil)
	if err != nil || !found {
		t.Fatalf("UpdateBean = (%v, %v)", found, err)
	}
	if got, _ := updated["roastLevel"].(string); got != "dark" {
		t.Errorf("roastLevel = %q, want dark", got)
	}
	if got, _ := updated["bestFromDays"].(int64); got != 3 {
		t.Errorf("bestFromDays = %#v, want int64(3)", updated["bestFromDays"])
	}

	// Sending only one bound rewrites the pair; with no valid pair it clears.
	updated, found, err = UpdateBean(repo, id, Entity{"bestFromDays": float64(50)}, nil)
	if err != nil || !found {
		t.Fatalf("UpdateBean = (%v, %v)", found, err)
	}
	if updated["bestFromDays"] != nil || updated["bestUntilDays"] != nil {
		t.Errorf("partial update must clear the pair: from=%#v until=%#v", updated["bestFromDays"], updated["bestUntilDays"])
	}

	// An unknown level clears it rather than keeping the old value.
	updated, found, err = UpdateBean(repo, id, Entity{"roastLevel": "burnt"}, nil)
	if err != nil || !found {
		t.Fatalf("UpdateBean = (%v, %v)", found, err)
	}
	if got, _ := updated["roastLevel"].(string); got != "" {
		t.Errorf("roastLevel = %q, want empty after an unknown value", got)
	}

	// An update that does not mention the fields leaves them untouched.
	updated, found, err = UpdateBean(repo, id, Entity{"notes": "untouched"}, nil)
	if err != nil || !found {
		t.Fatalf("UpdateBean = (%v, %v)", found, err)
	}
	if got, _ := updated["roastLevel"].(string); got != "" {
		// It was cleared above, so this only proves the key did not come back.
		t.Errorf("roastLevel = %q, want still empty", got)
	}
}

func TestSanitizeBeanFields_RoastLevelAndBestForUse(t *testing.T) {
	out := SanitizeBeanFields(Entity{
		"name":          "Restored Bean",
		"roastLevel":    "medium-dark",
		"bestFromDays":  float64(4),
		"bestUntilDays": float64(12),
	})
	if got, _ := out["roastLevel"].(string); got != "medium-dark" {
		t.Errorf("roastLevel = %q, want medium-dark", got)
	}
	if got, _ := out["bestFromDays"].(int64); got != 4 {
		t.Errorf("bestFromDays = %#v, want int64(4)", out["bestFromDays"])
	}

	dropped := SanitizeBeanFields(Entity{
		"name":          "Restored Bean",
		"roastLevel":    "not-a-level",
		"bestFromDays":  float64(12),
		"bestUntilDays": float64(4),
	})
	if got, _ := dropped["roastLevel"].(string); got != "" {
		t.Errorf("roastLevel = %q, want empty for an unknown value", got)
	}
	if dropped["bestFromDays"] != nil || dropped["bestUntilDays"] != nil {
		t.Errorf("inverted restored window must be dropped: from=%#v until=%#v", dropped["bestFromDays"], dropped["bestUntilDays"])
	}
}
