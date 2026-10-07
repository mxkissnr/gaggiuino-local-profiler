// #1514: at 1400 px the desktop topbar clipped the last nav tab to "Set".
// The scrolling .topbar-nav-scroll row (flex:1; min-width:0; overflow-x:auto
// with a hidden scrollbar) is what clipped it, so Settings moved out to a
// fixed slot between that row and .topbar-machine, as an icon-only gear.
// These assertions pin the markup that keeps it out of the scroller and
// named for assistive tech; like test/backup-modal-markup.test.ts they read
// index.html directly instead of driving a browser.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '../public-src/index.html'), 'utf8');

const navScroll = html.match(/<nav class="topbar-nav-scroll">[\s\S]*?<\/nav>/)?.[0] ?? '';
const settingsBtn = html.match(/<button\b[^>]*\bid="btnSettings"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';

describe('desktop topbar: Settings is a fixed gear outside the scrolling nav row (#1514)', () => {
    it('is no longer a descendant of the .topbar-nav-scroll container', () => {
        expect(navScroll).not.toBe('');
        expect(navScroll).not.toContain('id="btnSettings"');
    });

    it('sits after the nav row and before .topbar-machine', () => {
        const navEnd = html.indexOf('</nav>', html.indexOf('topbar-nav-scroll'));
        const btnAt = html.indexOf('id="btnSettings"');
        const machineAt = html.indexOf('class="topbar-machine"');
        expect(btnAt).toBeGreaterThan(navEnd);
        expect(btnAt).toBeLessThan(machineAt);
    });

    it('shows a gear icon at the normal rail-icon size, not the small one', () => {
        expect(settingsBtn).toContain('class="rail-icon"');
        expect(settingsBtn).not.toContain('rail-icon sm');
        expect(settingsBtn).toContain('r="3"');
    });

    it('has no visible .rail-label text node', () => {
        expect(settingsBtn).not.toContain('rail-label');
    });

    it('derives both the title and the accessible name from i18n, not fixed text', () => {
        expect(settingsBtn).toMatch(/data-i18n-title="nav_settings"/);
        expect(settingsBtn).toMatch(/data-i18n-aria-label="nav_settings"/);
        expect(settingsBtn).toMatch(/aria-label="[^"]+"/);
    });
});
