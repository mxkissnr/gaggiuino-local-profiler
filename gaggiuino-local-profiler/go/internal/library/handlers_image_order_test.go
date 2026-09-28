package library

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// TestPostImage_UnknownEntityChecksExistenceFirst pins dev's ordering for the
// POST .../image handlers: an upload to a non-existent id 404s BEFORE the body
// is read/validated or any file is written. Covers both the unsupported-format
// case (must stay 404, not the unsupported-image 400) and the valid-image case
// (no orphan file may be left behind for an entity that does not exist).
func TestPostImage_UnknownEntityChecksExistenceFirst(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	post := func(contentType string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/library/bean/999999/image", bytes.NewReader(body))
		req.Header.Set("Content-Type", contentType)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	if rec := post("text/plain", []byte("not an image")); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown bean + unsupported image: status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}

	if rec := post("image/jpeg", makeJPEG(t, 64, 48)); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown bean + valid image: status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	entries, err := os.ReadDir(h.imageDir)
	if err != nil {
		t.Fatalf("ReadDir(%s): %v", h.imageDir, err)
	}
	if len(entries) != 0 {
		t.Fatalf("image dir not empty after a 404 upload: %v", entries)
	}
}
