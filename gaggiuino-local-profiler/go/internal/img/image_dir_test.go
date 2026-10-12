package img

import (
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/datadir"
)

// DefaultImageDir is resolved once at package init, before a test can set an
// env var, so the resolver itself is exercised directly: GLP_IMAGE_DIR must
// change the directory the server reads/writes images to, and an unset (or
// empty) value must fall back to the bean-images directory under
// datadir.Root — a per-test directory in a `go test` binary, never the real
// data mount (CLAUDE.md rule (a) — a test proves the setting changes
// behaviour).
func TestResolveImageDir(t *testing.T) {
	t.Run("GLP_IMAGE_DIR overrides the resolved data dir", func(t *testing.T) {
		t.Setenv("GLP_IMAGE_DIR", "/tmp/glp-image-dir-test")
		if got := resolveImageDir(); got != "/tmp/glp-image-dir-test" {
			t.Fatalf("resolveImageDir() = %q, want %q", got, "/tmp/glp-image-dir-test")
		}
	})

	t.Run("empty GLP_IMAGE_DIR falls back under the test data dir", func(t *testing.T) {
		t.Setenv("GLP_IMAGE_DIR", "")
		got := resolveImageDir()
		if strings.HasPrefix(got, "/data/") {
			t.Fatalf("resolveImageDir() = %q; a test binary must not resolve images under the real /data directory", got)
		}
		if want := datadir.Path("bean-images"); got != want {
			t.Fatalf("resolveImageDir() = %q, want %q", got, want)
		}
	})
}
