// Package mcp is GLP's built-in Model Context Protocol server (#1196): a
// stateless Streamable-HTTP endpoint that exposes shot history to AI
// assistants, built on the official Go SDK.
//
// The server is off by default: cmd/server mounts it at /api/mcp only when
// options.json's enable_mcp (or GLP_ENABLE_MCP=true) turns it on. Because it
// lives under /api/, the existing auth.RequireToken middleware protects it
// with the same X-GLP-Token header every other /api/* route uses; the
// static-asset GET bypass deliberately does NOT apply. Requests carrying a
// foreign Origin header are rejected (DNS-rebinding protection, MCP spec
// MUST), and tool calls share internal/ratelimit's defaults.
//
// A second, independent opt-in — options.json's enable_mcp_write, or
// GLP_ENABLE_MCP_WRITE=true — adds three write tools (annotate_shot,
// set_known_grind, mark_maintenance_done) on top of the read-only set. While
// it is off they are not registered at all, so a client never sees them.
//
// A third, independent opt-in — options.json's enable_mcp_developer_tools, or
// GLP_ENABLE_MCP_DEVELOPER_TOOLS=true — adds the developer tools
// (get_shot_raw: a shot's full-resolution, undownsampled brew series;
// explain_score: one shot's score broken into its weighted parts). Like the
// write tools, they are not registered while the opt-in is off.
//
// Tools return structuredContent plus the SDK's text fallback, summarise by
// default (curves only on explicit request, downsampled), and report bad
// input or unknown ids as tool execution errors.
package mcp
