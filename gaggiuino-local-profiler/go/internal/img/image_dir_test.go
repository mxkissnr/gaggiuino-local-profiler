package img

import "testing"

// DefaultImageDir is resolved once at package init, before a test can set an
// env var, so the resolver itself is exercised directly: GLP_IMAGE_DIR must
// change the directory the server reads/writes images to, and an unset (or
// empty) value must fall back to the production /data mount (CLAUDE.md rule
// (a) — a test proves the setting changes behaviour).
func TestResolveImageDir(t *testing.T) {
	t.Run("GLP_IMAGE_DIR overrides the production mount", func(t *testing.T) {
		t.Setenv("GLP_IMAGE_DIR", "/tmp/glp-image-dir-test")
		if got := resolveImageDir(); got != "/tmp/glp-image-dir-test" {
			t.Fatalf("resolveImageDir() = %q, want %q", got, "/tmp/glp-image-dir-test")
		}
	})

	t.Run("empty GLP_IMAGE_DIR falls back to the production mount", func(t *testing.T) {
		t.Setenv("GLP_IMAGE_DIR", "")
		if got := resolveImageDir(); got != "/data/bean-images" {
			t.Fatalf("resolveImageDir() = %q, want %q", got, "/data/bean-images")
		}
	})
}
