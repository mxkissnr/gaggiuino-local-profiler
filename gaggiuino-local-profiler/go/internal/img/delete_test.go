package img

import (
	"os"
	"path/filepath"
	"testing"
)

// TestDelete_IgnoresUnknownExtensions pins that a stored extension outside
// the whitelist never becomes a filesystem path. Path builds the target with
// filepath.Join, so the traversal is already cleaned to the victim location
// the old unchecked Delete would have removed.
func TestDelete_IgnoresUnknownExtensions(t *testing.T) {
	cases := []struct {
		name string
		ext  string
	}{
		{"parent traversal", "x/../../victim"},
		{"inner traversal", "x/../victim"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "images")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			victim := Path(dir, 1, tc.ext, "shot-")
			if err := os.WriteFile(victim, []byte("keep"), 0o644); err != nil {
				t.Fatal(err)
			}

			Delete(dir, 1, tc.ext, "shot-")

			if _, err := os.Stat(victim); err != nil {
				t.Fatalf("victim %s removed by Delete(ext=%q): %v", victim, tc.ext, err)
			}
		})
	}
}

// TestDelete_RemovesKnownExtension is the happy path: a whitelisted
// extension still removes the photo and its thumbnail.
func TestDelete_RemovesKnownExtension(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "images")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	paths := []string{Path(dir, 7, "jpg", "shot-"), ThumbPath(dir, 7, "jpg", "shot-")}
	for _, p := range paths {
		if err := os.WriteFile(p, []byte{0x01}, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	Delete(dir, 7, "jpg", "shot-")

	for _, p := range paths {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s should have been removed (err=%v)", p, err)
		}
	}
}
