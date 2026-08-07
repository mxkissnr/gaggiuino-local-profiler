// #684: after a successful restore, the app used to only refresh shots
// (window.loadData()) before showing the result alert -- restored
// library/machines/settings/menu/etc. stayed stale until a manual reload.
// A full harness for backup-modal.js's restore confirm handler (apiFetch,
// initToken, closeBackupModal, alert, DOM wiring) would be disproportionate
// for pinning a single control-flow change -- test/backup-modal-markup.test.js
// documents the same tradeoff for this file. This asserts the actual source
// or the restore-success block: location.reload() happens after the result
// alert, and the old partial window.loadData() refresh is gone from that path.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../public-src/components/backup-modal.js'), 'utf8');

function restoreConfirmBlock() {
    const start = src.indexOf('confirmBtn.onclick = async () => {');
    const end   = src.indexOf('refreshRestorePreview();', start);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, end);
}

describe('restore confirm handler (#684)', () => {
    it('reloads the page after a successful restore', () => {
        expect(restoreConfirmBlock()).toMatch(/location\.reload\(\)/);
    });

    it('calls location.reload() after the result alert, not before (so the user sees the message)', () => {
        const block = restoreConfirmBlock();
        expect(block.indexOf('alert(')).toBeGreaterThan(-1);
        expect(block.indexOf('location.reload()')).toBeGreaterThan(block.indexOf('alert('));
    });

    it('no longer relies on the partial window.loadData() refresh for a successful restore', () => {
        expect(restoreConfirmBlock()).not.toMatch(/if \(window\.loadData\)/);
    });
});
