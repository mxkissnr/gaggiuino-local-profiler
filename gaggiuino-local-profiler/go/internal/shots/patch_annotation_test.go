package shots

import (
	"net/http"
	"testing"
)

// TestPatchAnnotation_StaleInvalidFieldDoesNotBlockOtherEdits is the #1625
// regression: an annotation stored before the current rules existed (here an
// out-of-range rating) must not make an edit of a different field fail.
func TestPatchAnnotation_StaleInvalidFieldDoesNotBlockOtherEdits(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, map[string]any{"rating": float64(9)})

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/1/annotate", []byte(`{"notes":"x"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	merged := toMap(body["annotation"])
	if merged["notes"] != "x" {
		t.Fatalf("annotation.notes = %#v, want \"x\"", merged["notes"])
	}
	if merged["rating"] != float64(9) {
		t.Fatalf("annotation.rating = %#v, want the untouched stored 9", merged["rating"])
	}
}

// TestPatchAnnotation_InvalidPatchedFieldStillRejected: scoping validation to
// the keys the patch sets must not weaken it — patching the invalid field
// itself with another invalid value still 400s and leaves the stored value.
func TestPatchAnnotation_InvalidPatchedFieldStillRejected(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, map[string]any{"rating": float64(4)})

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/1/annotate", []byte(`{"rating":9}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["error"] != "Validation failed" {
		t.Fatalf("error = %#v, want \"Validation failed\"", body["error"])
	}
}

// TestPatchAnnotation_NullAndEmptyStringRemoveKeys: a patch key sent as JSON
// null or "" removes the stored key instead of storing the null/empty value.
// Driven through the service directly because the HTTP layer rejects an
// explicit null for a non-nullable field before the merge runs.
func TestPatchAnnotation_NullAndEmptyStringRemoveKeys(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
	}{
		{"null", nil},
		{"empty string", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, repo, sqlDB := newTestHandlers(t)
			insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, map[string]any{"notes": "tasty"})
			svc := NewService(repo)

			ann, err := svc.PatchAnnotation(1, map[string]any{"notes": tc.value})
			if err != nil {
				t.Fatalf("PatchAnnotation: %v", err)
			}
			if v, ok := ann["notes"]; ok {
				t.Fatalf("returned notes = %#v, want the key removed", v)
			}
			stored, err := repo.GetAnnotation(1)
			if err != nil {
				t.Fatalf("GetAnnotation: %v", err)
			}
			if v, ok := stored["notes"]; ok {
				t.Fatalf("stored notes = %#v, want the key removed", v)
			}
		})
	}
}
