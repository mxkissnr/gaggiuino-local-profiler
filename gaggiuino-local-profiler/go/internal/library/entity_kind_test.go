package library

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// entityKindCase is one row of the shared table the consolidated image/delete
// handlers are exercised through: the create request, the delete request and
// (for the four image-bearing kinds) the image filename prefix.
type entityKindCase struct {
	kind         entityKind
	createPath   string
	payload      map[string]any
	deleteMethod string
	deleteSuffix string
	imagePrefix  string
	hasImage     bool
}

var entityKindCases = []entityKindCase{
	{beanKind, "/api/library/bean", map[string]any{"name": "Bean"}, http.MethodPost, "/delete", "", true},
	{grinderKind, "/api/library/grinder", map[string]any{"name": "Grinder"}, http.MethodPost, "/delete", "grinder-", true},
	{basketKind, "/api/library/basket", map[string]any{"name": "Basket", "wallType": "precision-machined"}, http.MethodDelete, "", "basket-", true},
	{puckScreenKind, "/api/library/puckscreen", map[string]any{"name": "Puck", "thickness": "thin"}, http.MethodDelete, "", "puckscreen-", true},
	{milkKind, "/api/library/milk", map[string]any{"name": "Oat", "stockMl": 1000}, http.MethodDelete, "", "", false},
	{recipeKind, "/api/library/recipe", map[string]any{"name": "Recipe", "brewMethod": "v60"}, http.MethodPost, "/delete", "", false},
}

// createEntityVia posts c's create request and returns the new entity's id.
func createEntityVia(t *testing.T, mux *http.ServeMux, c entityKindCase) int64 {
	t.Helper()
	rec := doJSON(t, mux, http.MethodPost, c.createPath, mustMarshal(t, c.payload))
	if rec.Code != http.StatusOK {
		t.Fatalf("create %s status = %d; body=%s", c.createPath, rec.Code, rec.Body.String())
	}
	return int64(decodeBody(t, rec.Body.Bytes())["id"].(float64))
}

// uploadImageVia posts a valid JPEG to the case's `.../image` route.
func uploadImageVia(t *testing.T, mux *http.ServeMux, c entityKindCase, id int64) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, c.createPath+"/"+itoa(id)+"/image", bytes.NewReader(makeJPEG(t, 64, 48)))
	req.Header.Set("Content-Type", "image/jpeg")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("upload status = %d; body=%s", rec.Code, rec.Body.String())
	}
}

// TestEntityKind_ImageRoundTrip exercises the consolidated POST/GET image
// handlers for the four image-bearing kinds — baskets and puck screens had no
// image coverage at all before they shared the generic helper.
func TestEntityKind_ImageRoundTrip(t *testing.T) {
	for _, c := range entityKindCases {
		if !c.hasImage {
			continue
		}
		t.Run(c.createPath, func(t *testing.T) {
			h, _, _ := newTestHandlers(t)
			mux := newMux(h)
			id := createEntityVia(t, mux, c)
			base := c.createPath + "/" + itoa(id) + "/image"

			uploadImageVia(t, mux, c, id)
			if _, err := os.Stat(filepath.Join(h.imageDir, c.imagePrefix+itoa(id)+".jpg")); err != nil {
				t.Fatalf("stored image missing: %v", err)
			}
			if got := doJSON(t, mux, http.MethodGet, base, nil); got.Code != http.StatusOK {
				t.Fatalf("GET image status = %d, want 200", got.Code)
			}
		})
	}
}

// TestEntityKind_Delete exercises the consolidated delete handler for all six
// kinds, including that an image-bearing kind's photo file is removed.
func TestEntityKind_Delete(t *testing.T) {
	for _, c := range entityKindCases {
		t.Run(c.createPath, func(t *testing.T) {
			h, _, _ := newTestHandlers(t)
			mux := newMux(h)
			id := createEntityVia(t, mux, c)

			imgPath := ""
			if c.hasImage {
				uploadImageVia(t, mux, c, id)
				imgPath = filepath.Join(h.imageDir, c.imagePrefix+itoa(id)+".jpg")
			}

			rec := doJSON(t, mux, c.deleteMethod, c.createPath+"/"+itoa(id)+c.deleteSuffix, nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
			}
			if imgPath != "" {
				if _, err := os.Stat(imgPath); !os.IsNotExist(err) {
					t.Fatalf("image file still present after delete (stat err = %v)", err)
				}
			}
		})
	}
}
