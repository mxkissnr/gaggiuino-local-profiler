package mcp

import (
	"database/sql"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/grindscale"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// seedGrinders writes the three grinders these tests need: a stepless dial, a
// stepped dial and a grinder without a scale.
func seedGrinders(t *testing.T, libRepo *library.Repository) {
	t.Helper()
	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	lib.Grinders = []library.Entity{
		{"id": int64(1), "name": "Lagom", "scale": (&grindscale.Scale{Type: grindscale.TypeStepless, Min: 0, Max: 9, Step: 0.1}).Map()},
		{"id": int64(2), "name": "K6", "scale": (&grindscale.Scale{Type: grindscale.TypeStepped, Min: 0, Max: 60, Step: 1}).Map()},
		{"id": int64(3), "name": "Plain"},
	}
	if err := libRepo.SaveLibrary(lib); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
}

func storedGrindSetting(t *testing.T, sqlDB *sql.DB, id int64) (string, bool) {
	t.Helper()
	ann, err := shots.NewRepository(sqlDB).GetAnnotation(id)
	if err != nil {
		t.Fatalf("GetAnnotation(%d): %v", id, err)
	}
	v, ok := ann["grindSetting"].(string)
	return v, ok
}

func TestAnnotateShot_FitsTheGrindersScale(t *testing.T) {
	ts, sqlDB, libRepo, _, _ := newWriteServer(t, true)
	seedGrinders(t, libRepo)
	insertShot(t, sqlDB, 51, 1000, nil, map[string]any{"coffee": "Alpha", "grinder": "Lagom", "grindSetting": "8.0"})
	session := connect(t, ts.URL+Path)

	res := call(t, session, "annotate_shot", map[string]any{"id": 51, "grind_setting": "8,3"})
	if res.IsError {
		t.Fatalf("annotate_shot failed: %s", errorText(t, res))
	}
	if setting, _ := structured(t, res)["grind_setting"].(string); setting != "8.3" {
		t.Fatalf("output grind_setting = %v, want the canonical 8.3", structured(t, res)["grind_setting"])
	}
	if setting, _ := storedGrindSetting(t, sqlDB, 51); setting != "8.3" {
		t.Fatalf("stored grindSetting = %q, want 8.3", setting)
	}

	res = call(t, session, "annotate_shot", map[string]any{"id": 51, "grind_setting": "9.5"})
	if !res.IsError {
		t.Fatalf("expected an error for a setting above the grinder's maximum")
	}
	if msg := errorText(t, res); !strings.Contains(msg, "9") {
		t.Errorf("error %q should name the valid range", msg)
	}
	if setting, _ := storedGrindSetting(t, sqlDB, 51); setting != "8.3" {
		t.Fatalf("stored grindSetting = %q after a rejected write, want 8.3", setting)
	}
}

func TestAnnotateShot_SteppedRejectsHalfSteps(t *testing.T) {
	ts, sqlDB, libRepo, _, _ := newWriteServer(t, true)
	seedGrinders(t, libRepo)
	insertShot(t, sqlDB, 52, 1000, nil, map[string]any{"coffee": "Alpha", "grinder": "K6", "grindSetting": "30"})
	session := connect(t, ts.URL+Path)

	if res := call(t, session, "annotate_shot", map[string]any{"id": 52, "grind_setting": "33.5"}); !res.IsError {
		t.Fatalf("expected an error for a half step on a stepped grinder")
	}
	if setting, _ := storedGrindSetting(t, sqlDB, 52); setting != "30" {
		t.Fatalf("stored grindSetting = %q after a rejected write, want 30", setting)
	}

	if res := call(t, session, "annotate_shot", map[string]any{"id": 52, "grind_setting": "33"}); res.IsError {
		t.Fatalf("annotate_shot failed on a valid whole step: %s", errorText(t, res))
	}
	if setting, _ := storedGrindSetting(t, sqlDB, 52); setting != "33" {
		t.Fatalf("stored grindSetting = %q, want 33", setting)
	}
}

func TestAnnotateShot_FreeTextGrinderStoresVerbatim(t *testing.T) {
	ts, sqlDB, libRepo, _, _ := newWriteServer(t, true)
	seedGrinders(t, libRepo)
	insertShot(t, sqlDB, 53, 1000, nil, map[string]any{"coffee": "Alpha", "grinder": "Plain", "grindSetting": "1.2.3"})
	session := connect(t, ts.URL+Path)

	if res := call(t, session, "annotate_shot", map[string]any{"id": 53, "grind_setting": "1.2.3"}); res.IsError {
		t.Fatalf("annotate_shot rejected a free-text setting: %s", errorText(t, res))
	}
	if setting, _ := storedGrindSetting(t, sqlDB, 53); setting != "1.2.3" {
		t.Fatalf("stored grindSetting = %q, want 1.2.3 verbatim", setting)
	}

	if res := call(t, session, "annotate_shot", map[string]any{"id": 53, "grind_setting": "8,3"}); res.IsError {
		t.Fatalf("annotate_shot failed: %s", errorText(t, res))
	}
	if setting, _ := storedGrindSetting(t, sqlDB, 53); setting != "8,3" {
		t.Fatalf("stored grindSetting = %q, want 8,3 verbatim for a grinder without a scale", setting)
	}
}

func TestAnnotateShot_EmptySettingClearsOnAScaledGrinder(t *testing.T) {
	ts, sqlDB, libRepo, _, _ := newWriteServer(t, true)
	seedGrinders(t, libRepo)
	insertShot(t, sqlDB, 54, 1000, nil, map[string]any{"coffee": "Alpha", "grinder": "Lagom", "grindSetting": "8.3"})
	session := connect(t, ts.URL+Path)

	if res := call(t, session, "annotate_shot", map[string]any{"id": 54, "grind_setting": ""}); res.IsError {
		t.Fatalf("annotate_shot failed: %s", errorText(t, res))
	}
	if setting, ok := storedGrindSetting(t, sqlDB, 54); ok {
		t.Fatalf("stored grindSetting = %q, want the key cleared", setting)
	}
}

func TestSetKnownGrind_FitsTheGrindersScale(t *testing.T) {
	ts, _, libRepo, _, _ := newWriteServer(t, true)
	seedGrinders(t, libRepo)
	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	lib.Beans = []library.Entity{{"id": int64(1), "name": "Alpha", "enabled": true}}
	if err := libRepo.SaveLibrary(lib); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	session := connect(t, ts.URL+Path)

	res := call(t, session, "set_known_grind", map[string]any{"bean_id": 1, "grinder": "Lagom", "grind_setting": "8,3"})
	if res.IsError {
		t.Fatalf("set_known_grind failed: %s", errorText(t, res))
	}
	settings := objects(structured(t, res), "known_grind_settings")
	first, _ := settings[0].(map[string]any)
	if setting, _ := first["grind_setting"].(string); setting != "8.3" {
		t.Fatalf("known grind_setting = %v, want 8.3", first["grind_setting"])
	}

	if res := call(t, session, "set_known_grind", map[string]any{"bean_id": 1, "grinder": "Lagom", "grind_setting": "12"}); !res.IsError {
		t.Fatalf("expected an error for a setting above the grinder's maximum")
	}

	if res := call(t, session, "set_known_grind", map[string]any{"bean_id": 1, "grinder": "Plain", "grind_setting": "8,3"}); res.IsError {
		t.Fatalf("set_known_grind rejected a free-text setting: %s", errorText(t, res))
	}
	settings = objects(structured(t, res), "known_grind_settings")
	var stored string
	for _, o := range settings {
		m, _ := o.(map[string]any)
		if g, _ := m["grinder"].(string); g == "Plain" {
			stored, _ = m["grind_setting"].(string)
		}
	}
	if stored != "8,3" {
		t.Fatalf("known grind_setting for Plain = %q, want 8,3 verbatim", stored)
	}
}
