// Package datadir resolves the base directory every on-disk data path in the
// app is rooted at.
//
// Production keeps the hard-coded /data mount: that is where the Home
// Assistant add-on and the standalone Docker image expect to read and write
// glp.db, api_token.txt, options.json, the preheat state/history files and the
// bean-images directory. Tests, however, must never touch it. A test binary
// that builds the whole app (cmd/server's newTestApp) starts the background
// image cleanup against the real data directory with an empty database, so on
// any host that actually has a /data directory every existing photo looks
// orphaned and is deleted; other tests write the real preheat state/history
// files and read the real options.json. Guarding each package with its own
// TestMain is easy to forget when a new package is added.
//
// Root therefore redirects any binary built by `go test` to a per-process
// temporary directory (testing.Testing reports that), unless GLP_DATA_DIR
// overrides it. No production code path changes: a normally built binary still
// resolves every path under /data.
package datadir

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// rootOnce/testRoot memoise the per-process test directory so every Root call
// in one test binary returns the same path.
var (
	rootOnce sync.Once
	testRoot string
)

// Root returns the base data directory:
//
//   - GLP_DATA_DIR, when set and non-empty.
//   - a per-process temporary directory, when the running binary was built by
//     `go test` (testing.Testing).
//   - /data otherwise.
//
// The test directory is created once per process; a failure to create it
// panics rather than falling back to /data, because silently writing into the
// real data directory is exactly what this package exists to prevent.
func Root() string {
	if dir := os.Getenv("GLP_DATA_DIR"); dir != "" {
		return dir
	}
	if testing.Testing() {
		rootOnce.Do(func() {
			dir, err := os.MkdirTemp("", "glp-test-data-")
			if err != nil {
				panic("datadir: creating per-test data directory: " + err.Error())
			}
			testRoot = dir
		})
		return testRoot
	}
	return "/data"
}

// Path returns name joined onto Root.
func Path(name string) string {
	return filepath.Join(Root(), name)
}
