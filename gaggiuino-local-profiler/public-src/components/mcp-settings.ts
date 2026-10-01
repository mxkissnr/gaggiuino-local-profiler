// AI-assistant (MCP) Settings card (#1288, part of #1196). The MCP server
// was previously switched on through the Home Assistant add-on options; it
// now reads/writes its own /api/mcp/settings blob and this always-visible
// card is the only place to turn it on. Loaded once at app init (main.js),
// same as notify-settings.js. The developer-tools row only exists on the
// GLP_DEV_BUILD channel — GET reports developerToolsAvailable and the row
// stays hidden (and its value stays false) everywhere else.
import { getMcpSettings, postMcpSettings } from '../api/mcp.js';
import type { McpSettingsInput } from '../api/types.js';
import { t, tHtml } from '../i18n.js';
import { html } from '../utils.js';
import { CHECK_ICON_SVG } from '../icons.js';

// Remembered from the last GET so the disable logic and save() agree on
// whether the developer tools are part of this build at all.
let _developerToolsAvailable = false;

type McpKey = 'enabled' | 'allowWrite' | 'allowDeveloperTools';

function box(list: HTMLElement, key: McpKey): HTMLInputElement | null {
  return list.querySelector<HTMLInputElement>(`[data-mcp-key="${key}"]`);
}

// Write and developer tools only apply while the server itself is on, and the
// developer row is only shown on a build that offers it.
export function renderMcpSettingsCard(): void {
  const list = document.getElementById('mcpSettingsList');
  if (!list) return;
  const devRow = document.getElementById('mcpDevRow');
  if (devRow) devRow.style.display = _developerToolsAvailable ? '' : 'none';
  const on = box(list, 'enabled')?.checked ?? false;
  const write = box(list, 'allowWrite');
  const dev = box(list, 'allowDeveloperTools');
  if (write) write.disabled = !on;
  if (dev) dev.disabled = !on;
}

export async function loadMcpSettingsCard(): Promise<void> {
  const list = document.getElementById('mcpSettingsList');
  if (!list) return;
  const settings = await getMcpSettings().catch(() => null);
  if (!settings) return;
  _developerToolsAvailable = settings.developerToolsAvailable === true;
  const enabled = box(list, 'enabled');
  const write = box(list, 'allowWrite');
  const dev = box(list, 'allowDeveloperTools');
  if (enabled) enabled.checked = settings.enabled === true;
  if (write) write.checked = settings.allowWrite === true;
  if (dev) dev.checked = _developerToolsAvailable && settings.allowDeveloperTools === true;
  renderMcpSettingsCard();
}

export async function saveMcpSettings(): Promise<void> {
  const list = document.getElementById('mcpSettingsList');
  if (!list) return;
  const body: McpSettingsInput = {
    enabled: box(list, 'enabled')?.checked ?? false,
    allowWrite: box(list, 'allowWrite')?.checked ?? false,
    // the row is hidden unless the build offers the tools, and hidden means off
    allowDeveloperTools: _developerToolsAvailable && (box(list, 'allowDeveloperTools')?.checked ?? false),
  };
  const r = await postMcpSettings(body);
  if (!r.ok) {
    if (window.showToast) window.showToast(t('error_generic', r.status));
    return;
  }
  const btn = document.getElementById('mcpSettingsSaveBtn');
  if (btn) {
    btn.innerHTML = html`${CHECK_ICON_SVG} ${tHtml('orders_types_saved')}`;
    setTimeout(() => { btn.textContent = t('orders_types_save'); }, 2000);
  }
}
