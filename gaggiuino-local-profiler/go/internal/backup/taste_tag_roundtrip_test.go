package backup

import (
	"net/http"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// restoreAnnotation exports one shot carrying ann and restores it into a fresh
// install, returning the annotation the restore left behind.
func restoreAnnotation(t *testing.T, ann map[string]any) map[string]any {
	t.Helper()
	useImageDir(t)
	h1, deps1, _ := newTestHandlers(t)
	if err := deps1.ShotsRepo.Upsert(shots.Shot{
		"id": int64(52), "timestamp": int64(1700000000), "duration": int64(30000),
		"profileName": "Taste Profile", "machineId": int64(1),
		"annotation": ann,
	}); err != nil {
		t.Fatalf("seeding shot: %v", err)
	}

	rec := doJSON(t, newMux(h1), http.MethodPost, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	zipBytes := append([]byte(nil), rec.Body.Bytes()...)

	h2, deps2, _ := newTestHandlersInDir(t)
	rr := doZip(t, newMux(h2), "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}

	restored, err := deps2.ShotsRepo.FindByID(52)
	if err != nil || restored == nil {
		t.Fatalf("restored shot 52 missing: err=%v", err)
	}
	out, _ := restored["annotation"].(map[string]any)
	if out == nil {
		out = map[string]any{}
	}
	return out
}

// TestStreamRoundTrip_TasteTagUnchanged: a taste tag survives export and
// restore.
func TestStreamRoundTrip_TasteTagUnchanged(t *testing.T) {
	ann := restoreAnnotation(t, map[string]any{"coffee": "Bean A", "tasteTag": "sour"})
	if got := ann["tasteTag"]; got != "sour" {
		t.Errorf("restored tasteTag = %v, want sour", got)
	}
}

// TestStreamRoundTrip_UnknownTasteTagKeepsAnnotation: restore silently drops
// every annotation failing shots.ValidateAnnotation, so a tag from a newer
// version must not cost the whole annotation.
func TestStreamRoundTrip_UnknownTasteTagKeepsAnnotation(t *testing.T) {
	ann := restoreAnnotation(t, map[string]any{
		"coffee": "Bean A", "notes": "keep", "tasteTag": "astringent",
	})
	if got := ann["notes"]; got != "keep" {
		t.Errorf("restored notes = %v, want keep: the unknown tag dropped the annotation", got)
	}
}

// TestStreamRoundTrip_NoTasteTagStaysAbsent: a shot that never had a tag comes
// back without the key.
func TestStreamRoundTrip_NoTasteTagStaysAbsent(t *testing.T) {
	ann := restoreAnnotation(t, map[string]any{"coffee": "Bean A"})
	if _, ok := ann["tasteTag"]; ok {
		t.Errorf("restored annotation gained a tasteTag: %#v", ann)
	}
}
