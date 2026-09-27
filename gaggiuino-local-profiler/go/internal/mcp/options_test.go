package mcp

import (
	"os"
	"path/filepath"
	"testing"
)

// withOptionsFile points the option reader at a temp options.json containing
// contents, restoring the real path when the test ends.
func withOptionsFile(t *testing.T, contents string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "options.json")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write options.json: %v", err)
	}
	prev := optionsFile
	optionsFile = path
	t.Cleanup(func() { optionsFile = prev })
}

func TestBoolOptionReadsValues(t *testing.T) {
	// A non-boolean sibling field must not break the read (the reason the
	// parser decodes into json.RawMessage rather than map[string]bool).
	withOptionsFile(t, `{"enable_mcp":true,"enable_mcp_write":false,"unrelated":7}`)
	// The file wins over the env vars when both are set.
	t.Setenv("GLP_ENABLE_MCP", "false")
	t.Setenv("GLP_ENABLE_MCP_WRITE", "true")
	if !Enabled() {
		t.Fatalf("Enabled() = false, want true")
	}
	if WriteEnabled() {
		t.Fatalf("WriteEnabled() = true, want false")
	}
}

func TestBoolOptionAbsentFieldIsFalse(t *testing.T) {
	withOptionsFile(t, `{"enable_mcp":true}`)
	// An absent field is false and, matching the old enable_mcp semantics,
	// does NOT fall back to the env var once the file parses.
	t.Setenv("GLP_ENABLE_MCP_WRITE", "true")
	if WriteEnabled() {
		t.Fatalf("WriteEnabled() = true for an absent field, want false")
	}
}

func TestBoolOptionInvalidValueFallsBackToEnv(t *testing.T) {
	withOptionsFile(t, `{"enable_mcp_write":"yes"}`)
	t.Setenv("GLP_ENABLE_MCP_WRITE", "true")
	if !WriteEnabled() {
		t.Fatalf("WriteEnabled() = false, want true from the env fallback")
	}
	t.Setenv("GLP_ENABLE_MCP_WRITE", "false")
	if WriteEnabled() {
		t.Fatalf("WriteEnabled() = true, want false from the env fallback")
	}
}

func TestBoolOptionMissingFileUsesEnv(t *testing.T) {
	prev := optionsFile
	optionsFile = filepath.Join(t.TempDir(), "absent.json")
	t.Cleanup(func() { optionsFile = prev })
	t.Setenv("GLP_ENABLE_MCP", "true")
	t.Setenv("GLP_ENABLE_MCP_WRITE", "false")
	if !Enabled() {
		t.Fatalf("Enabled() = false with a missing file and env true, want true")
	}
	if WriteEnabled() {
		t.Fatalf("WriteEnabled() = true with a missing file and env false, want false")
	}
}
