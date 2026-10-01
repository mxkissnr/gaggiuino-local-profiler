// Package mcp is GLP's built-in Model Context Protocol server (#1196): a
// stateless Streamable-HTTP endpoint that exposes shot history to AI
// assistants, built on the official Go SDK.
//
// cmd/server always mounts the endpoint at /api/mcp; whether it answers is
// decided per request from the app-stored 'mcp_settings' kv row (#1288). While
// the master switch is off the endpoint answers 404 — the same response an
// unmounted route would give — so a real install can't tell it exists. Because
// it lives under /api/, the existing auth.RequireToken middleware protects it
// with the same X-GLP-Token header every other /api/* route uses; the
// static-asset GET bypass deliberately does NOT apply. Requests carrying a
// foreign Origin header are rejected (DNS-rebinding protection, MCP spec
// MUST), and tool calls share internal/ratelimit's defaults.
//
// GET/POST /api/mcp/settings (handlers.go) read and write those toggles, so
// enabling the server or changing its tool set takes effect on the next
// request with no restart.
//
// A second, independent opt-in — the stored allowWrite toggle — adds three
// write tools (annotate_shot, set_known_grind, mark_maintenance_done) on top
// of the read-only set. While it is off they are not registered at all, so a
// client never sees them.
//
// A third, independent opt-in — the stored allowDeveloperTools toggle — adds
// the developer tools (get_shot_raw: a shot's full-resolution, undownsampled
// brew series; explain_score: one shot's score broken into its weighted parts;
// get_preheat_history: the machine's recent preheat runs). It is effective
// only on a dev build (GLP_DEV_BUILD), so a released install can never expose
// them even if the row says otherwise.
//
// Tools return structuredContent plus the SDK's text fallback, summarise by
// default (curves only on explicit request, downsampled), and report bad
// input or unknown ids as tool execution errors.
package mcp
