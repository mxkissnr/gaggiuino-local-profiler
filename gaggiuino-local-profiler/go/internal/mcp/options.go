package mcp

import (
	"encoding/json"
	"os"
)

// optionsFile mirrors lib/constants.js's OPTIONS_FILE — the same path
// internal/orders/options.go reads. A var (not a const) so tests can point
// the option reader at a temp file; production never reassigns it.
var optionsFile = "/data/options.json"

// boolOption ports the options.json feature-toggle pattern
// internal/orders/options.go established: read one boolean field from
// /data/options.json (written by the Supervisor), falling back to the GLP_*
// env var for standalone Docker runs where that file is absent. A narrow,
// single-field read on purpose — the rest of options.json belongs to the
// not-yet-ported system domain.
func boolOption(jsonField, envVar string) bool {
	data, err := os.ReadFile(optionsFile)
	if err != nil {
		return os.Getenv(envVar) == "true"
	}
	var opts map[string]json.RawMessage
	if err := json.Unmarshal(data, &opts); err != nil {
		return os.Getenv(envVar) == "true"
	}
	raw, ok := opts[jsonField]
	if !ok {
		return false
	}
	var enabled bool
	if err := json.Unmarshal(raw, &enabled); err != nil {
		return os.Getenv(envVar) == "true"
	}
	return enabled
}

// Enabled reports whether cmd/server should mount the MCP endpoint. Off by
// default; the whole feature is undocumented until the docs slice (#1196).
func Enabled() bool {
	return boolOption("enable_mcp", "GLP_ENABLE_MCP")
}

// WriteEnabled reports whether the MCP server should register its write
// tools. A second, independent opt-in on top of Enabled: without it the
// write tools are never registered, so a client cannot list or call them.
// Off by default and undocumented until the docs slice (#1196).
func WriteEnabled() bool {
	return boolOption("enable_mcp_write", "GLP_ENABLE_MCP_WRITE")
}

// DeveloperToolsEnabled reports whether the MCP server should register its
// developer tools (full-resolution / bulk data, currently get_shot_raw). A
// third, independent opt-in on top of Enabled: without it the tools are never
// registered, so a client cannot list or call them. Off by default and
// undocumented until the docs slice (#1196).
func DeveloperToolsEnabled() bool {
	return boolOption("enable_mcp_developer_tools", "GLP_ENABLE_MCP_DEVELOPER_TOOLS")
}
