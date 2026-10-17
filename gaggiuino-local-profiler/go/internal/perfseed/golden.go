package perfseed

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Equivalence is the dataset the #1616 equivalence tests pin: smaller than
// Default so the tests stay fast, still with every edge case Seed writes.
var Equivalence = Options{Shots: 800, Samples: 120}

// UpdateEnv names the environment variable that makes AssertGolden rewrite
// its golden file instead of comparing against it:
//
//	GLP_UPDATE_GOLDEN=1 go test ./internal/... -run Equivalence
//
// Only regenerate a golden on purpose — they pin pre-#1616 output, and a
// diff means a response changed.
const UpdateEnv = "GLP_UPDATE_GOLDEN"

// AssertGolden marshals got as indented JSON (map keys sorted) and compares
// it with testdata/perf1616/<name>.json in the calling package's directory.
func AssertGolden(tb testing.TB, name string, got any) {
	tb.Helper()
	b, err := json.MarshalIndent(got, "", "  ")
	if err != nil {
		tb.Fatalf("perfseed: marshaling golden %s: %v", name, err)
	}
	b = append(b, '\n')
	path := filepath.Join("testdata", "perf1616", name+".json")
	if os.Getenv(UpdateEnv) != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			tb.Fatal(err)
		}
		if err := os.WriteFile(path, b, 0o644); err != nil {
			tb.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		tb.Fatalf("perfseed: reading golden %s (run with %s=1 to create it): %v", path, UpdateEnv, err)
	}
	if !bytes.Equal(want, b) {
		tb.Errorf("perfseed: %s differs from the golden output\n--- got ---\n%s", path, truncate(b, 4000))
	}
}

// Digest returns a short hex SHA-256 of v's JSON encoding, for pinning a
// response too large to keep as a readable golden file.
func Digest(tb testing.TB, v any) string {
	tb.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		tb.Fatalf("perfseed: digest: %v", err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// Strip returns a deep copy of a decoded JSON value with every object key
// in drop removed at any depth — for fields that pass a seed-day-relative
// value straight through (timestamps, dates) and would otherwise make a
// golden change from one day to the next.
func Strip(v any, drop ...string) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			skip := false
			for _, d := range drop {
				if k == d {
					skip = true
					break
				}
			}
			if !skip {
				out[k] = Strip(val, drop...)
			}
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = Strip(val, drop...)
		}
		return out
	default:
		return v
	}
}

// DecodeJSON decodes b into a generic value, failing the test on error.
func DecodeJSON(tb testing.TB, b []byte) any {
	tb.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		tb.Fatalf("perfseed: decoding JSON: %v", err)
	}
	return v
}

func truncate(b []byte, n int) []byte {
	if len(b) <= n {
		return b
	}
	return append(b[:n:n], []byte("\n…")...)
}

// PinUTC sets time.Local to UTC for the rest of the test and restores it
// on cleanup. The seed's local-midnight anchor and the local-clock badges
// (night owl, early bird, …) would otherwise make a golden depend on the
// machine's time zone. Call it before Seed, and never from a parallel test.
func PinUTC(tb testing.TB) {
	tb.Helper()
	prev := time.Local
	time.Local = time.UTC
	tb.Cleanup(func() { time.Local = prev })
}

// OpenEquivalence pins UTC and opens a database seeded with Equivalence.
func OpenEquivalence(tb testing.TB) (*sql.DB, Info) {
	tb.Helper()
	PinUTC(tb)
	return OpenSeeded(tb, Equivalence)
}
