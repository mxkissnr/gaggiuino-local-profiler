// Package redact holds the app's one redaction function for text that leaves
// the process toward a client: a machine's last polling/sync error in
// GET /api/status and the MCP tools, and the log lines get_diagnostics
// returns. Users paste that text into public issues, so it must carry neither
// a credential nor where a machine lives on the network (#1626).
//
// It started as internal/system's redactURLs (http/https URLs only) next to
// internal/mcp's separate maskSecrets (credentials only, hosts kept); the two
// covered different cases and both missed some, so they were merged here.
// Reachability itself (reachable or not, and the error's wording) stays
// readable: only the values are replaced.
package redact
