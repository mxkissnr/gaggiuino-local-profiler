package mcp

import (
	"encoding/json"
	"os"
)

// optionsFile mirrors lib/constants.js's OPTIONS_FILE — the same path
// internal/orders/options.go reads.
const optionsFile = "/data/options.json"

// isMCPEnabled ports the options.json feature-toggle pattern
// internal/orders/options.go established: read enable_mcp from
// /data/options.json (written by the Supervisor), falling back to the
// GLP_ENABLE_MCP env var for standalone Docker runs where that file is
// absent. A narrow, single-field read on purpose — the rest of options.json
// belongs to the not-yet-ported system domain.
func isMCPEnabled() bool {
	data, err := os.ReadFile(optionsFile)
	if err != nil {
		return os.Getenv("GLP_ENABLE_MCP") == "true"
	}
	var opts struct {
		EnableMCP bool `json:"enable_mcp"`
	}
	if err := json.Unmarshal(data, &opts); err != nil {
		return os.Getenv("GLP_ENABLE_MCP") == "true"
	}
	return opts.EnableMCP
}

// Enabled reports whether cmd/server should mount the MCP endpoint. Off by
// default; the whole feature is undocumented until the docs slice (#1196).
func Enabled() bool {
	return isMCPEnabled()
}
