package library

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
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

// cropKindCases are the two kinds the original/re-crop tests run against:
// a bean (empty prefix, enriched response) and a grinder (prefixed files,
// bare-entity response), so both response paths and both filename shapes are
// covered.
func cropKindCases() []entityKindCase {
	out := make([]entityKindCase, 0, 2)
	for _, c := range entityKindCases {
		if c.kind.hasImage && (c.createPath == "/api/library/bean" || c.createPath == "/api/library/grinder") {
			out = append(out, c)
		}
	}
	return out
}

// makePNG builds a w×h RGBA PNG with a non-opaque pixel, so img.Save's
// ModeUpload keeps it as PNG instead of converting it to JPEG — the only way
// a stored main image ever has a non-JPEG extension after an upload.
func makePNG(t testing.TB, w, h int) []byte {
	t.Helper()
	im := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			im.Set(x, y, color.RGBA{uint8(x), uint8(y), 0, 128})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, im); err != nil {
		t.Fatalf("encode test png: %v", err)
	}
	return buf.Bytes()
}

// postImageRaw posts body to path as contentType. An empty contentType sends
// no Content-Type header — the shape a body-less re-crop request has.
func postImageRaw(t *testing.T, mux *http.ServeMux, path, contentType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == nil {
		req = httptest.NewRequest(http.MethodPost, path, nil)
	} else {
		req = httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// storedEntity reads back one entity of c's kind, failing the test when it is
// gone.
func storedEntity(t *testing.T, h *Handlers, c entityKindCase, id int64) Entity {
	t.Helper()
	lib, err := h.repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	items := *c.kind.list(&lib)
	idx := findEntityIndex(items, id)
	if idx == -1 {
		t.Fatalf("entity %d missing from %s", id, c.createPath)
	}
	return items[idx]
}

func requireImageCrop(t *testing.T, entity Entity, want img.Crop) {
	t.Helper()
	got, ok := entityCrop(entity)
	if !ok {
		t.Fatalf("entity has no valid imageCrop: %v", entity)
	}
	const tol = 1e-9
	if diff := math.Abs(got.X-want.X) + math.Abs(got.Y-want.Y) + math.Abs(got.W-want.W) + math.Abs(got.H-want.H); diff > tol {
		t.Fatalf("imageCrop = %+v, want %+v", got, want)
	}
}

func requireFile(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected stored file %s: %v", path, err)
	}
}

func requireNoFile(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected %s to be absent, stat err = %v", path, err)
	}
}

// testImagePath is the on-disk path of one stored variant ("" = main,
// "thumb" and "orig" the two siblings the crop pipeline adds).
func testImagePath(h *Handlers, c entityKindCase, id int64, variant, ext string) string {
	switch variant {
	case "thumb":
		return img.ThumbPath(h.imageDir, id, ext, c.imagePrefix)
	case "orig":
		return img.OriginalPath(h.imageDir, id, c.imagePrefix)
	}
	return img.Path(h.imageDir, id, ext, c.imagePrefix)
}

// TestPostImage_NewPhotoDropsOriginalAndCrop pins the "a new photo replaces
// everything that described the old one" rule: the stored original and the
// crop rectangle go away with the picture they belonged to.
func TestPostImage_NewPhotoDropsOriginalAndCrop(t *testing.T) {
	for _, c := range cropKindCases() {
		t.Run(c.createPath, func(t *testing.T) {
			h, _, _ := newTestHandlers(t)
			mux := newMux(h)
			id := createEntityVia(t, mux, c)
			base := c.createPath + "/" + itoa(id) + "/image"

			uploadImageVia(t, mux, c, id)
			if rec := postImageRaw(t, mux, base+"?original=1&crop=0,0,0.5,0.5", "image/jpeg", makeJPEG(t, 200, 100)); rec.Code != http.StatusOK {
				t.Fatalf("store original status = %d; body=%s", rec.Code, rec.Body.String())
			}
			requireFile(t, testImagePath(h, c, id, "orig", "jpg"))
			requireImageCrop(t, storedEntity(t, h, c, id), img.Crop{X: 0, Y: 0, W: 0.5, H: 0.5})

			uploadImageVia(t, mux, c, id)

			if _, ok := storedEntity(t, h, c, id)["imageCrop"]; ok {
				t.Fatalf("imageCrop survived a new photo: %v", storedEntity(t, h, c, id))
			}
			requireNoFile(t, testImagePath(h, c, id, "orig", "jpg"))
		})
	}
}

// TestPostImage_StoreOriginal covers `?original=1&crop=`: the upload becomes
// the uncropped original, the crop is recorded, and the main image is left
// alone. Also pins the three rejections that guard it.
func TestPostImage_StoreOriginal(t *testing.T) {
	for _, c := range cropKindCases() {
		t.Run(c.createPath, func(t *testing.T) {
			h, _, _ := newTestHandlers(t)
			mux := newMux(h)
			id := createEntityVia(t, mux, c)
			base := c.createPath + "/" + itoa(id) + "/image"

			uploadImageVia(t, mux, c, id)
			mainPath := testImagePath(h, c, id, "", "jpg")
			mainBefore, err := os.ReadFile(mainPath)
			if err != nil {
				t.Fatalf("reading stored main image: %v", err)
			}

			want := img.Crop{X: 0.1, Y: 0.2, W: 0.5, H: 0.6}
			rec := postImageRaw(t, mux, base+"?original=1&crop=0.1,0.2,0.5,0.6", "image/jpeg", makeJPEG(t, 200, 100))
			if rec.Code != http.StatusOK {
				t.Fatalf("store original status = %d; body=%s", rec.Code, rec.Body.String())
			}
			requireImageCrop(t, storedEntity(t, h, c, id), want)
			mainAfter, err := os.ReadFile(mainPath)
			if err != nil {
				t.Fatalf("reading stored main image: %v", err)
			}
			if !bytes.Equal(mainBefore, mainAfter) {
				t.Fatalf("storing an original rewrote the main image")
			}
			orig, err := os.ReadFile(testImagePath(h, c, id, "orig", "jpg"))
			if err != nil {
				t.Fatalf("reading stored original: %v", err)
			}
			if cfg, _, err := image.DecodeConfig(bytes.NewReader(orig)); err != nil || cfg.Width != 200 || cfg.Height != 100 {
				t.Fatalf("stored original = %dx%d (err %v), want 200x100", cfg.Width, cfg.Height, err)
			}

			if rec := postImageRaw(t, mux, base+"?original=1&crop=0.1,0.2,0.5,0.6", "image/png", makePNG(t, 40, 30)); rec.Code != http.StatusBadRequest {
				t.Fatalf("PNG original status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if rec := postImageRaw(t, mux, base+"?original=1&crop=0,0,2,2", "image/jpeg", makeJPEG(t, 40, 30)); rec.Code != http.StatusBadRequest {
				t.Fatalf("out-of-range crop status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if rec := postImageRaw(t, mux, base+"?original=1", "image/jpeg", makeJPEG(t, 40, 30)); rec.Code != http.StatusBadRequest {
				t.Fatalf("missing crop status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}

			noImageID := createEntityVia(t, mux, c)
			rec = postImageRaw(t, mux, c.createPath+"/"+itoa(noImageID)+"/image?original=1&crop=0,0,0.5,0.5", "image/jpeg", makeJPEG(t, 40, 30))
			if rec.Code != http.StatusConflict {
				t.Fatalf("original without a photo status = %d, want 409; body=%s", rec.Code, rec.Body.String())
			}
			requireNoFile(t, testImagePath(h, c, noImageID, "orig", "jpg"))
		})
	}
}

// TestPostImage_Recrop covers `?crop=` alone: the main image is rebuilt from
// the stored original at the requested size, the original survives, and a
// main-image extension change drops the old main but never the original.
func TestPostImage_Recrop(t *testing.T) {
	for _, c := range cropKindCases() {
		t.Run(c.createPath, func(t *testing.T) {
			h, _, _ := newTestHandlers(t)
			mux := newMux(h)
			id := createEntityVia(t, mux, c)
			base := c.createPath + "/" + itoa(id) + "/image"

			// A PNG main makes the later re-crop's jpg a real extension change.
			if rec := postImageRaw(t, mux, base, "image/png", makePNG(t, 64, 64)); rec.Code != http.StatusOK {
				t.Fatalf("png upload status = %d; body=%s", rec.Code, rec.Body.String())
			}
			if rec := postImageRaw(t, mux, base+"?original=1&crop=0,0,1,1", "image/jpeg", makeJPEG(t, 200, 100)); rec.Code != http.StatusOK {
				t.Fatalf("store original status = %d; body=%s", rec.Code, rec.Body.String())
			}

			// No body at all: a re-crop reads the original, not the request.
			rec := postImageRaw(t, mux, base+"?crop=0,0,0.5,0.5", "", nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("re-crop status = %d; body=%s", rec.Code, rec.Body.String())
			}
			main, err := os.ReadFile(testImagePath(h, c, id, "", "jpg"))
			if err != nil {
				t.Fatalf("reading re-cropped main image: %v", err)
			}
			cfg, _, err := image.DecodeConfig(bytes.NewReader(main))
			if err != nil {
				t.Fatalf("decoding re-cropped main image: %v", err)
			}
			if cfg.Width != 100 || cfg.Height != 50 {
				t.Fatalf("re-cropped main = %dx%d, want 100x50", cfg.Width, cfg.Height)
			}
			requireImageCrop(t, storedEntity(t, h, c, id), img.Crop{X: 0, Y: 0, W: 0.5, H: 0.5})
			requireFile(t, testImagePath(h, c, id, "orig", "jpg"))
			requireNoFile(t, testImagePath(h, c, id, "", "png"))

			noOriginalID := createEntityVia(t, mux, c)
			uploadImageVia(t, mux, c, noOriginalID)
			rec = postImageRaw(t, mux, c.createPath+"/"+itoa(noOriginalID)+"/image?crop=0,0,0.5,0.5", "", nil)
			if rec.Code != http.StatusConflict {
				t.Fatalf("re-crop without original status = %d, want 409; body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestGetImage_Original covers the read side of the invariant: the original is
// served only for an entity that both records a crop and still has the file.
func TestGetImage_Original(t *testing.T) {
	for _, c := range cropKindCases() {
		t.Run(c.createPath, func(t *testing.T) {
			h, _, _ := newTestHandlers(t)
			mux := newMux(h)
			id := createEntityVia(t, mux, c)
			base := c.createPath + "/" + itoa(id) + "/image"

			uploadImageVia(t, mux, c, id)
			if rec := postImageRaw(t, mux, base+"?original=1&crop=0,0,0.5,0.5", "image/jpeg", makeJPEG(t, 200, 100)); rec.Code != http.StatusOK {
				t.Fatalf("store original status = %d; body=%s", rec.Code, rec.Body.String())
			}

			rec := doJSON(t, mux, http.MethodGet, base+"?original=1", nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("GET original status = %d; body=%s", rec.Code, rec.Body.String())
			}
			if got := rec.Header().Get("Content-Type"); got != "image/jpeg" {
				t.Fatalf("GET original Content-Type = %q, want image/jpeg", got)
			}
			if cfg, _, err := image.DecodeConfig(bytes.NewReader(rec.Body.Bytes())); err != nil || cfg.Width != 200 || cfg.Height != 100 {
				t.Fatalf("served original = %dx%d (err %v), want 200x100", cfg.Width, cfg.Height, err)
			}

			// The crop is what ties the file to the entity: without it the
			// original is not served even though it is on disk.
			plainID := createEntityVia(t, mux, c)
			uploadImageVia(t, mux, c, plainID)
			if rec := doJSON(t, mux, http.MethodGet, c.createPath+"/"+itoa(plainID)+"/image?original=1", nil); rec.Code != http.StatusNotFound {
				t.Fatalf("GET original without imageCrop status = %d, want 404", rec.Code)
			}

			os.Remove(testImagePath(h, c, id, "orig", "jpg"))
			if rec := doJSON(t, mux, http.MethodGet, base+"?original=1", nil); rec.Code != http.StatusNotFound {
				t.Fatalf("GET original with a missing file status = %d, want 404", rec.Code)
			}
		})
	}
}

// TestDelete_RemovesMainThumbAndOriginal pins that deleting an entity takes
// its thumbnail and its uncropped original with it — the crop invariant would
// otherwise outlive the entity as orphaned bytes.
func TestDelete_RemovesMainThumbAndOriginal(t *testing.T) {
	for _, c := range cropKindCases() {
		t.Run(c.createPath, func(t *testing.T) {
			h, _, _ := newTestHandlers(t)
			mux := newMux(h)
			id := createEntityVia(t, mux, c)

			uploadImageVia(t, mux, c, id)
			if rec := postImageRaw(t, mux, c.createPath+"/"+itoa(id)+"/image?original=1&crop=0,0,0.5,0.5", "image/jpeg", makeJPEG(t, 200, 100)); rec.Code != http.StatusOK {
				t.Fatalf("store original status = %d; body=%s", rec.Code, rec.Body.String())
			}
			paths := []string{
				testImagePath(h, c, id, "", "jpg"),
				testImagePath(h, c, id, "thumb", "jpg"),
				testImagePath(h, c, id, "orig", "jpg"),
			}
			for _, p := range paths {
				requireFile(t, p)
			}

			if rec := doJSON(t, mux, c.deleteMethod, c.createPath+"/"+itoa(id)+c.deleteSuffix, nil); rec.Code != http.StatusOK {
				t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
			}
			for _, p := range paths {
				requireNoFile(t, p)
			}
		})
	}
}

