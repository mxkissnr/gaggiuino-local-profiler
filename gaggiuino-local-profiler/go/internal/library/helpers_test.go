package library

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// makeJPEG builds a w×h smooth-gradient JPEG in memory — a real, decodable
// image the #961 pipeline can downscale and thumbnail (a hand-rolled magic-
// byte stub no longer survives img.Save's decode step).
func makeJPEG(t testing.TB, w, h int) []byte {
	t.Helper()
	im := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			im.Set(x, y, color.RGBA{uint8(x * 255 / w), uint8(y * 255 / h), uint8((x + y) * 255 / (w + h)), 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, im, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encode test jpeg: %v", err)
	}
	return buf.Bytes()
}

// newTestHandlers opens a throwaway on-disk SQLite DB via internal/db.Open
// (same fixture pattern as shots/helpers_test.go) and wires it into a fresh
// Handlers/Repository pair.
func newTestHandlers(t testing.TB) (*Handlers, *Repository, *sql.DB) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	repo := NewRepository(sqlDB)
	h := NewHandlers(repo, shots.NewRepository(sqlDB))
	t.Cleanup(h.limiter.Stop)
	// DefaultImageDir ("/data/bean-images") isn't writable by a test
	// process — point image uploads at a throwaway dir instead.
	h.imageDir = t.TempDir()
	return h, repo, sqlDB
}

func newMux(h *Handlers) *http.ServeMux {
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux
}

func decodeBody(t testing.TB, body []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decoding response body %q: %v", body, err)
	}
	return m
}

func decodeBodyArray(t testing.TB, body []byte) []map[string]any {
	t.Helper()
	var m []map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decoding response array %q: %v", body, err)
	}
	return m
}
