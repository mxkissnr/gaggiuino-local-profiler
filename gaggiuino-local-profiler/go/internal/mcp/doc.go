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
// Tools return structuredContent plus the SDK's text fallback, summarise by
// default (curves only on explicit request, downsampled), and report bad
// input or unknown ids as tool execution errors.
package mcp
