import { apiFetch, apiFetchJson } from './fetch.js';
import type { McpSettings, McpSettingsInput } from './types.js';

// Typed client for the `mcp` domain (go/internal/mcp): the Settings page
// toggles the built-in MCP server from here (#1288, part of #1196).
//
// Same contract as api/orders.ts: URL building and the JSON-headers
// boilerplate live here; the GET parses its body via apiFetchJson and the
// POST returns the raw Response so the caller can gate on `ok` (a
// non-dev build answers 400 to `allowDeveloperTools: true`).

/** GET /api/mcp/settings — the stored toggles plus this build's developer-tools availability. */
export function getMcpSettings(): Promise<McpSettings> {
  return apiFetchJson<McpSettings>('api/mcp/settings');
}

/** POST /api/mcp/settings — the body replaces the stored settings, so all three toggles are sent. */
export function postMcpSettings(input: McpSettingsInput): Promise<Response> {
  return apiFetch('api/mcp/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
