package backup

import (
	"net/http"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// mixAnnotation is the annotation a bean-mix shot (#1837) carries: two parts,
// 10 g of bean 12 and 8 g of bean 7, with the top-level coffee/beanId naming the
// primary bean and the top-level dose the whole 18 g.
func mixAnnotation() map[string]any {
	return map[string]any{
		"coffee": "Bean A",
		"beanId": float64(12),
		"dose":   float64(18),
		"beanMix": []any{
			map[string]any{"beanId": float64(12), "coffee": "Bean A", "grams": float64(10)},
			map[string]any{"beanId": float64(7), "coffee": "Bean B", "grams": float64(8)},
		},
	}
}

// TestStreamRoundTrip_BeanMixUnchanged proves a mixed shot's beanMix survives
// export and restore byte-for-byte: restore re-validates every annotation and
// silently drops the ones that fail, so a beanMix the validator rejects would
// come back missing rather than failing the restore.
func TestStreamRoundTrip_BeanMixUnchanged(t *testing.T) {
	useImageDir(t)
	h1, deps1, _ := newTestHandlers(t)
	if err := deps1.ShotsRepo.Upsert(shots.Shot{
		"id": int64(51), "timestamp": int64(1700000000), "duration": int64(30000),
		"profileName": "Mix Profile", "machineId": int64(1),
		"annotation": mixAnnotation(),
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

	restored, err := deps2.ShotsRepo.FindByID(51)
	if err != nil || restored == nil {
		t.Fatalf("restored shot 51 missing: err=%v", err)
	}
	ann, _ := restored["annotation"].(map[string]any)
	parts, ok := ann["beanMix"].([]any)
	if !ok || len(parts) != 2 {
		t.Fatalf("restored beanMix = %+v, want the two original parts", ann["beanMix"])
	}
	for i, want := range []struct {
		beanID float64
		coffee string
		grams  float64
	}{{12, "Bean A", 10}, {7, "Bean B", 8}} {
		part, _ := parts[i].(map[string]any)
		if part["coffee"] != want.coffee {
			t.Errorf("part %d coffee = %v, want %q", i, part["coffee"], want.coffee)
		}
		if g, _ := part["grams"].(float64); g != want.grams {
			t.Errorf("part %d grams = %v, want %v", i, part["grams"], want.grams)
		}
		if id, _ := part["beanId"].(float64); id != want.beanID {
			t.Errorf("part %d beanId = %v, want %v", i, part["beanId"], want.beanID)
		}
	}
	// The top-level fields keep naming the primary bean.
	if ann["coffee"] != "Bean A" || ann["beanId"] != float64(12) {
		t.Errorf("restored primary bean = %v/%v, want Bean A/12", ann["coffee"], ann["beanId"])
	}
}
