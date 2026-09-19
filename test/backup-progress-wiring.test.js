import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Source-grep guards (same style as i18n.test.js's "shot detail view i18n
// wiring") that the #960 progress plumbing stays wired end to end. Package
// A3 (#1110) moved the raw apiFetchToBlob/apiUpload calls out of these two
// component files and into api/system.ts's typed requestBackup/postRestore/
// exportDevDb/importDevDb wrappers — the modal and the Dev Tools card now
// go through those wrappers instead of calling apiFetchToBlob/apiUpload
// directly, so the URL/header/onProgress-forwarding assertions moved to
// system.ts alongside them.
const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('backup-modal.ts progress wiring', () => {
  const src = read('public-src/components/backup-modal.ts');

  it('imports requestBackup and postRestore from api/system.js', () => {
    expect(src).toMatch(/import\s*\{[^}]*\brequestBackup\b[^}]*\}\s*from\s*'\.\.\/api\/system\.js'/);
    expect(src).toMatch(/import\s*\{[^}]*\bpostRestore\b[^}]*\}\s*from\s*'\.\.\/api\/system\.js'/);
  });

  it('disables both modal buttons for the whole transfer (setBusy)', () => {
    expect(src).toMatch(/function setBusy\(on[^)]*\)[^{]*\{[\s\S]*confirmBtn\.disabled = on;[\s\S]*cancelBtn\.disabled = on;/);
    expect(src).toContain('setBusy(true)');
  });

  it('no longer reads the export response with a bare r.blob()', () => {
    expect(src).not.toMatch(/await r\.blob\(\)/);
  });

  it('routes the real restore upload through postRestore with an onProgress callback', () => {
    expect(src).toMatch(/postRestore\(\{[^}]*onProgress[^}]*\}\)/);
  });
});

describe('api/system.ts backup/restore transport', () => {
  const src = read('public-src/api/system.ts');

  it('requestBackup drives the export bar off the X-GLP-Backup-Estimate header', () => {
    expect(src).toContain("estimateHeader: 'X-GLP-Backup-Estimate'");
    expect(src).toMatch(/apiFetchToBlob\('api\/backup'/);
  });

  it('postRestore routes through apiUpload against api/restore', () => {
    expect(src).toMatch(/apiUpload\('api\/restore'/);
  });
});

describe('status.js Dev Tools progress wiring', () => {
  const src = read('public-src/components/status.js');

  it('imports exportDevDb and importDevDb from api/system.js', () => {
    expect(src).toMatch(/import\s*\{[\s\S]*\bexportDevDb\b[\s\S]*\}\s*from\s*'\.\.\/api\/system\.js'/);
    expect(src).toMatch(/import\s*\{[\s\S]*\bimportDevDb\b[\s\S]*\}\s*from\s*'\.\.\/api\/system\.js'/);
  });

  it('shows transfer state in the button label and disables it (withButtonProgress)', () => {
    expect(src).toMatch(/function withButtonProgress\(btn, work\)/);
    expect(src).toContain('btn.disabled = true');
  });
});

describe('api/system.ts Dev Tools transport', () => {
  const src = read('public-src/api/system.ts');

  it('exportDevDb streams the DB download via apiFetchToBlob', () => {
    expect(src).toMatch(/apiFetchToBlob\('api\/debug\/export-db'/);
  });

  it('importDevDb uploads via apiUpload with an onProgress callback', () => {
    expect(src).toMatch(/apiUpload\('api\/debug\/import-db'/);
    expect(src).toContain('onProgress,');
  });
});
