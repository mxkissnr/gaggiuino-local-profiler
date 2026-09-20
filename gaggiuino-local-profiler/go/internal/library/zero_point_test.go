package library

import (
	"net/http"
	"testing"
	"time"
)

func TestZeroPointAtTime_PicksTheEntryActiveAtTheGivenMoment(t *testing.T) {
	grinder := Entity{"zeroPointHistory": []any{
		Entity{"zeroPoint": 42.0, "since": int64(1000)},
		Entity{"zeroPoint": 44.5, "since": int64(2000)},
	}}

	if v, ok := zeroPointAtTime(grinder, 500); ok {
		t.Fatalf("expected ok=false for a timestamp before the earliest entry, got %v", v)
	}
	if v, ok := zeroPointAtTime(grinder, 1000); !ok || v != 42.0 {
		t.Fatalf("at exactly the first entry's since: got (%v, %v), want (42, true)", v, ok)
	}
	if v, ok := zeroPointAtTime(grinder, 1500); !ok || v != 42.0 {
		t.Fatalf("between the two entries: got (%v, %v), want (42, true)", v, ok)
	}
	if v, ok := zeroPointAtTime(grinder, 5000); !ok || v != 44.5 {
		t.Fatalf("after the last entry: got (%v, %v), want (44.5, true)", v, ok)
	}
}

func TestCurrentGrinderZeroPoint_NoHistoryMeansFeatureInactive(t *testing.T) {
	if _, ok := currentGrinderZeroPoint(Entity{}); ok {
		t.Fatalf("expected ok=false for a grinder with no zeroPointHistory")
	}
	grinder := Entity{"zeroPointHistory": []any{
		Entity{"zeroPoint": 10.0, "since": int64(1)},
		Entity{"zeroPoint": 12.0, "since": int64(2)},
	}}
	if v, ok := currentGrinderZeroPoint(grinder); !ok || v != 12.0 {
		t.Fatalf("got (%v, %v), want (12, true) — the last entry wins", v, ok)
	}
}

// TestRelativeGrindSetting_CorrectsForDriftAfterCleaning is the feature's
// whole point: a shot ground at absolute 20 when the zero point was 42 must
// read as 22 (its relative offset preserved) once the grinder's zero point
// has since moved to 44 — the user never has to re-dial the recipe.
func TestRelativeGrindSetting_CorrectsForDriftAfterCleaning(t *testing.T) {
	grinder := Entity{"zeroPointHistory": []any{
		Entity{"zeroPoint": 42.0, "since": int64(1000)}, // active when the shot was pulled
		Entity{"zeroPoint": 44.0, "since": int64(2000)}, // reset after cleaning, now current
	}}
	got, ok := RelativeGrindSetting(grinder, 20.0, 1500)
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if got != 22.0 {
		t.Fatalf("got %v, want 22 (20 - 42 + 44)", got)
	}
}

func TestRelativeGrindSetting_UncorrectedWhenGrinderNeverTracksZeroPoint(t *testing.T) {
	got, ok := RelativeGrindSetting(Entity{}, 20.0, 1500)
	if ok {
		t.Fatalf("expected ok=false for a grinder with no zeroPointHistory")
	}
	if got != 20.0 {
		t.Fatalf("value must be returned unchanged, got %v", got)
	}
}

func TestRelativeGrindSetting_UncorrectedForAShotOlderThanAnyTrackedZeroPoint(t *testing.T) {
	grinder := Entity{"zeroPointHistory": []any{
		Entity{"zeroPoint": 42.0, "since": int64(1000)},
	}}
	got, ok := RelativeGrindSetting(grinder, 20.0, 500)
	if ok {
		t.Fatalf("expected ok=false for a shot predating the earliest recorded zero point")
	}
	if got != 20.0 {
		t.Fatalf("value must be returned unchanged, got %v", got)
	}
}

func TestSetGrinderZeroPoint_HandlerAppendsHistoryAndIsIdempotentForTheSameValue(t *testing.T) {
	h, repo, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{"name": "Niche Zero"}))
	grinder := decodeBody(t, rec.Body.Bytes())
	id := int64(grinder["id"].(float64))

	rec = doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id)+"/zero-point", mustMarshal(t, map[string]any{"zeroPoint": 42.0}))
	if rec.Code != http.StatusOK {
		t.Fatalf("first set status = %d; body=%s", rec.Code, rec.Body.String())
	}
	updated := decodeBody(t, rec.Body.Bytes())
	history, _ := updated["zeroPointHistory"].([]any)
	if len(history) != 1 {
		t.Fatalf("expected 1 history entry after the first set, got %d: %+v", len(history), history)
	}

	// Re-sending the same value must not grow the history.
	rec = doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id)+"/zero-point", mustMarshal(t, map[string]any{"zeroPoint": 42.0}))
	updated = decodeBody(t, rec.Body.Bytes())
	history, _ = updated["zeroPointHistory"].([]any)
	if len(history) != 1 {
		t.Fatalf("expected the repeated identical value to be a no-op, got %d entries: %+v", len(history), history)
	}

	// A genuinely different value (the post-cleaning reset) must append.
	rec = doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id)+"/zero-point", mustMarshal(t, map[string]any{"zeroPoint": 44.5}))
	updated = decodeBody(t, rec.Body.Bytes())
	history, _ = updated["zeroPointHistory"].([]any)
	if len(history) != 2 {
		t.Fatalf("expected 2 history entries after a real change, got %d: %+v", len(history), history)
	}

	// Persisted, not just returned in the response.
	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	idx := findGrinderIndex(lib, id)
	if idx == -1 {
		t.Fatalf("grinder not found after save")
	}
	persistedHistory, _ := lib.Grinders[idx]["zeroPointHistory"].([]any)
	if len(persistedHistory) != 2 {
		t.Fatalf("expected 2 persisted history entries, got %d", len(persistedHistory))
	}
}

func TestSetGrinderZeroPoint_InvalidValueRejected(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{"name": "Niche Zero"}))
	grinder := decodeBody(t, rec.Body.Bytes())
	id := int64(grinder["id"].(float64))

	rec = doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id)+"/zero-point", mustMarshal(t, map[string]any{"zeroPoint": "not a number"}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

func TestSetGrinderZeroPoint_UnknownGrinder404s(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPut, "/api/library/grinder/999999/zero-point", mustMarshal(t, map[string]any{"zeroPoint": 42.0}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
}

// TestSetGrinderZeroPoint_PastSince verifies that a retroactive insert (since
// explicitly provided) is sorted into the correct chronological position and
// that zeroPointAtTime still returns the right value for shots between entries.
func TestSetGrinderZeroPoint_PastSince(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{"name": "Ode 2"}))
	grinder := decodeBody(t, rec.Body.Bytes())
	id := int64(grinder["id"].(float64))

	// Insert "current" zero point (since=0 → now).
	const nowZP = 44.5
	doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id)+"/zero-point", mustMarshal(t, map[string]any{"zeroPoint": nowZP}))

	// Retroactively insert an earlier entry (since < now).
	const pastSince = int64(1_000_000)
	const pastZP = 42.0
	rec = doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id)+"/zero-point",
		mustMarshal(t, map[string]any{"zeroPoint": pastZP, "since": pastSince}))
	if rec.Code != http.StatusOK {
		t.Fatalf("retroactive set status = %d; body=%s", rec.Code, rec.Body.String())
	}
	updated := decodeBody(t, rec.Body.Bytes())
	history, _ := updated["zeroPointHistory"].([]any)
	if len(history) != 2 {
		t.Fatalf("expected 2 history entries, got %d: %+v", len(history), history)
	}

	// First entry must be the retroactive one (smallest since).
	e0, _ := history[0].(map[string]any)
	s0, _ := jsParseFloat(e0["since"])
	if int64(s0) != pastSince {
		t.Fatalf("first entry since = %v, want %d", s0, pastSince)
	}
	zp0, _ := jsParseFloat(e0["zeroPoint"])
	if zp0 != pastZP {
		t.Fatalf("first entry zeroPoint = %v, want %v", zp0, pastZP)
	}

	// Retroactive idempotency: re-sending the same (since,value) is a no-op.
	rec = doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id)+"/zero-point",
		mustMarshal(t, map[string]any{"zeroPoint": pastZP, "since": pastSince}))
	updated = decodeBody(t, rec.Body.Bytes())
	history, _ = updated["zeroPointHistory"].([]any)
	if len(history) != 2 {
		t.Fatalf("idempotent re-send must not grow history, got %d entries", len(history))
	}
}

func TestSetGrinderZeroPoint_SinceValidation(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{"name": "Ode 2"}))
	grinder := decodeBody(t, rec.Body.Bytes())
	id := int64(grinder["id"].(float64))

	cases := []struct {
		name  string
		since any
	}{
		{"negative", -1},
		{"future", time.Now().UnixMilli() + 60_000},
		{"unparseable", "not-a-number"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id)+"/zero-point",
				mustMarshal(t, map[string]any{"zeroPoint": 42.0, "since": c.since}))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestSetGrinderZeroPoint_DuplicateSinceReplaces verifies that a retroactive
// insert whose since collides with an existing entry replaces that entry's
// value instead of appending a second entry at the same since.
func TestSetGrinderZeroPoint_DuplicateSinceReplaces(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{"name": "Ode 2"}))
	grinder := decodeBody(t, rec.Body.Bytes())
	id := int64(grinder["id"].(float64))

	const since = int64(1_000_000)
	doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id)+"/zero-point",
		mustMarshal(t, map[string]any{"zeroPoint": 42.0, "since": since}))

	rec = doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id)+"/zero-point",
		mustMarshal(t, map[string]any{"zeroPoint": 43.5, "since": since}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	updated := decodeBody(t, rec.Body.Bytes())
	history, _ := updated["zeroPointHistory"].([]any)
	if len(history) != 1 {
		t.Fatalf("expected 1 entry (replace, not append), got %d: %+v", len(history), history)
	}
	entry, _ := history[0].(map[string]any)
	zp, _ := jsParseFloat(entry["zeroPoint"])
	if zp != 43.5 {
		t.Fatalf("entry zeroPoint = %v, want 43.5 (last write wins)", zp)
	}
}

// TestDeleteZeroPointEntry verifies removal of a single zero-point history
// entry via DELETE /api/library/grinder/:id/zero-point/:since.
func TestDeleteZeroPointEntry(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{"name": "Ode 2"}))
	grinder := decodeBody(t, rec.Body.Bytes())
	id := int64(grinder["id"].(float64))

	// Insert two entries.
	const since1 = int64(1_000_000)
	const since2 = int64(2_000_000)
	doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id)+"/zero-point",
		mustMarshal(t, map[string]any{"zeroPoint": 42.0, "since": since1}))
	doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id)+"/zero-point",
		mustMarshal(t, map[string]any{"zeroPoint": 44.5, "since": since2}))

	// Delete the first entry.
	rec = doJSON(t, mux, http.MethodDelete, "/api/library/grinder/"+itoa(id)+"/zero-point/"+itoa(since1), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
	}
	updated := decodeBody(t, rec.Body.Bytes())
	history, _ := updated["zeroPointHistory"].([]any)
	if len(history) != 1 {
		t.Fatalf("expected 1 entry after delete, got %d: %+v", len(history), history)
	}
	remaining, _ := history[0].(map[string]any)
	rs, _ := jsParseFloat(remaining["since"])
	if int64(rs) != since2 {
		t.Fatalf("remaining entry since = %v, want %d", rs, since2)
	}

	// Delete of unknown since is a no-op (idempotent), not a 404.
	rec = doJSON(t, mux, http.MethodDelete, "/api/library/grinder/"+itoa(id)+"/zero-point/999999", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete unknown since status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	// Delete on unknown grinder returns 404.
	rec = doJSON(t, mux, http.MethodDelete, "/api/library/grinder/999999/zero-point/"+itoa(since2), nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete on unknown grinder status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
}
