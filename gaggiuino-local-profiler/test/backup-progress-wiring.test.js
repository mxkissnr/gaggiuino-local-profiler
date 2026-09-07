import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Source-grep guards (same style as i18n.test.js's "shot detail view i18n
// wiring") that the #960 progress plumbing stays wired end to end: the
// modal and the Dev Tools card must go through the progress-aware helpers,
// not back to a plain apiFetch + r.blob().
const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('backup-modal.js progress wiring', () => {
  const src = read('public-src/components/backup-modal.js');

  it('imports apiFetchToBlob and apiUpload from api.js', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bapiFetchToBlob\b[^}]*\}\s*from\s*'\.\.\/api\.js'/);
    expect(src).toMatch(/import\s*\{[^}]*\bapiUpload\b[^}]*\}\s*from\s*'\.\.\/api\.js'/);
  });

  it('drives the export bar off the X-GLP-Backup-Estimate header', () => {
    expect(src).toContain("estimateHeader: 'X-GLP-Backup-Estimate'");
  });

  it('disables both modal buttons for the whole transfer (setBusy)', () => {
    expect(src).toMatch(/function setBusy\(on\)\s*\{[\s\S]*confirmBtn\.disabled = on;[\s\S]*cancelBtn\.disabled = on;/);
    expect(src).toContain('setBusy(true)');
  });

  it('no longer reads the export response with a bare r.blob()', () => {
    expect(src).not.toMatch(/await r\.blob\(\)/);
  });

  it('routes the real restore upload through apiUpload with an onProgress callback', () => {
    expect(src).toMatch(/apiUpload\('api\/restore'/);
  });
});

describe('status.js Dev Tools progress wiring', () => {
  const src = read('public-src/components/status.js');

  it('exportDevDb streams the DB download via apiFetchToBlob', () => {
    expect(src).toMatch(/apiFetchToBlob\('api\/debug\/export-db'/);
    expect(src).not.toMatch(/apiFetch\('api\/debug\/export-db'\)/);
  });

  it('importDevDb uploads via apiUpload with an onProgress callback', () => {
    expect(src).toMatch(/apiUpload\('api\/debug\/import-db'/);
    expect(src).toContain('onProgress:');
  });

  it('shows transfer state in the button label and disables it (withButtonProgress)', () => {
    expect(src).toMatch(/function withButtonProgress\(btn, work\)/);
    expect(src).toContain('btn.disabled = true');
  });
});
