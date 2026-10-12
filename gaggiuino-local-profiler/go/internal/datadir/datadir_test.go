package datadir

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRootRedirectsTestBinariesAwayFromData is the core guarantee: in a binary
// built by `go test`, Root must resolve somewhere other than the real data
// directory, and that somewhere must be a stable, existing directory.
func TestRootRedirectsTestBinariesAwayFromData(t *testing.T) {
	t.Setenv("GLP_DATA_DIR", "")

	root := Root()
	if root == "/data" {
		t.Fatalf("Root() = %q; a test binary must never use the real /data directory", root)
	}
	info, err := os.Stat(root)
	if err != nil {
		t.Fatalf("Root() = %q is not statable: %v", root, err)
	}
	if !info.IsDir() {
		t.Fatalf("Root() = %q is not a directory", root)
	}
	if again := Root(); again != root {
		t.Fatalf("Root() is not stable: got %q then %q", root, again)
	}
}

// TestPathJoinsRoot proves GLP_DATA_DIR steers Path, the seam every package's
// data path now goes through.
func TestPathJoinsRoot(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GLP_DATA_DIR", dir)

	if got, want := Path("x.json"), filepath.Join(dir, "x.json"); got != want {
		t.Fatalf("Path(\"x.json\") = %q, want %q", got, want)
	}
}

// TestNoHardCodedDataPathsInNonTestSources keeps a future change from
// reintroducing the literal this package replaced: no non-test Go file outside
// datadir.go may contain a "\"/data/" path literal, because such a path would
// bypass the test-binary redirection above.
func TestNoHardCodedDataPathsInNonTestSources(t *testing.T) {
	// ../.. is the go module root (covering go/internal and go/cmd); the
	// extra root keeps a top-level cmd tree covered if one is ever added.
	for _, root := range []string{"../..", "../../../cmd"} {
		if _, err := os.Stat(root); err != nil {
			continue
		}
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			name := d.Name()
			if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") || name == "datadir.go" {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if strings.Contains(string(data), "\"/data/") {
				t.Errorf("%s contains a hard-coded \"/data/ path literal; use datadir.Path instead", path)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walking %s: %v", root, err)
		}
	}
}
