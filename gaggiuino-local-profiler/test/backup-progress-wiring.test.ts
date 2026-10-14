// #960/#1110: the progress plumbing must stay wired end to end. Instead of
// grepping backup-modal.ts / status.ts / api/system.ts for the right imports and
// calls, these drive the real modules with a mocked transport layer: the modal's
// buttons must disable for the whole transfer and its progress row must update
// through the onProgress callback the wrapper forwards; the Dev Tools card must
// do the same with its button label; and the typed system.ts wrappers must keep
// targeting the right endpoints.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ApiFetchToBlobResult, ApiUploadResult } from '../public-src/api/transport.js';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const transport = vi.hoisted(() => ({
  apiFetch: vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(),
  apiFetchToBlob: vi.fn<(url: string, opts?: { onProgress?: (received: number, total: number | null) => void }) => Promise<ApiFetchToBlobResult>>(),
  apiUpload: vi.fn<(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: unknown; onProgress?: (loaded: number, total: number) => void }) => Promise<ApiUploadResult>>(),
}));

vi.mock('../public-src/api/transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/api/transport.js')>()),
  apiFetch: transport.apiFetch,
  apiFetchToBlob: transport.apiFetchToBlob,
  apiUpload: transport.apiUpload,
}));

vi.mock('../public-src/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/utils.js')>()),
  shareOrDownloadBlob: vi.fn(() => Promise.resolve()),
}));

interface FakeDoc {
  els: Record<string, FakeEl>;
  bySelector: Record<string, FakeEl>;
  checkboxes: FakeEl[];
  body: FakeEl;
  createElement: () => FakeEl;
  getElementById: (id: string) => FakeEl;
  querySelector: (selector: string) => FakeEl | null;
  querySelectorAll: (selector: string) => FakeEl[];
}

class FakeEl {
  id = '';
  innerHTML = '';
  textContent = '';
  className = '';
  title = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  checked = false;
  disabled = false;
  value = '';
  hidden = false;
  scrollTop = 0;
  children: FakeEl[] = [];
  onchange: (() => void) | null = null;
  oninput: (() => void) | null = null;
  onclick: (() => void) | null = null;
  readonly classList = {
    add: (_name: string): void => {},
    remove: (_name: string): void => {},
    contains: (_name: string): boolean => false,
    toggle: (_name: string, _on?: boolean): boolean => false,
  };

  addEventListener(_type: string, _fn: (...args: unknown[]) => void): void { /* module-load wiring only */ }
  removeEventListener(_type: string, _fn: (...args: unknown[]) => void): void { /* no-op */ }
  appendChild(child: FakeEl): FakeEl { this.children.push(child); return child; }
  setAttribute(_name: string, _value: string): void { /* no-op */ }
  removeAttribute(_name: string): void { /* no-op */ }
  remove(): void { /* no-op */ }
  focus(): void { /* no-op */ }
  querySelector(_selector: string): FakeEl { return new FakeEl(); }
  querySelectorAll(): FakeEl[] { return []; }
}

function makeElement(init: Partial<FakeEl> = {}): FakeEl {
  return Object.assign(new FakeEl(), init);
}

function makeDocument(): FakeDoc {
  const els: Record<string, FakeEl> = {};
  const bySelector: Record<string, FakeEl> = {};
  const doc: FakeDoc = {
    els,
    bySelector,
    checkboxes: [],
    body: new FakeEl(),
    createElement: () => new FakeEl(),
    getElementById: (id: string) => (els[id] ??= makeElement({ id })),
    querySelector: (selector: string) => bySelector[selector] ?? new FakeEl(),
    querySelectorAll: (selector: string) => (selector === '.backup-section-cb' ? doc.checkboxes : []),
  };
  return doc;
}

function uploadResult(body: unknown): ApiUploadResult {
  return { ok: true, status: 200, text: JSON.stringify(body) };
}
async function flushPromises(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

let doc: FakeDoc = makeDocument();
g.document = doc;
g.window = g;
const showToast = vi.fn();
const alertSpy = vi.fn();
g.showToast = showToast;
g.alert = alertSpy;
g.confirm = vi.fn(() => true);
g.location = { reload: vi.fn() };

const { openBackupExportModal, openBackupRestoreModal } = await import('../public-src/components/backup-modal.js');
const statusModule = await import('../public-src/components/status.js');
const systemModule = await import('../public-src/api/system.js');

function freshDoc(): void {
  doc = makeDocument();
  g.document = doc;
  const cb = doc.createElement();
  cb.value = 'shots';
  cb.checked = true;
  cb.disabled = false;
  doc.checkboxes.push(cb);
}

beforeEach(() => {
  transport.apiFetch.mockReset();
  transport.apiFetchToBlob.mockReset();
  transport.apiUpload.mockReset();
  showToast.mockReset();
  alertSpy.mockReset();
  freshDoc();
});

describe('backup-modal.ts progress wiring (#960)', () => {
  it('disables both modal buttons for the whole export transfer and drives the progress bar', async () => {
    let onProgress: ((received: number, total: number | null) => void) | undefined;
    let resolveBlob: (v: ApiFetchToBlobResult) => void = () => {};
    transport.apiFetchToBlob.mockImplementation((_url, opts) => {
      onProgress = opts?.onProgress;
      return new Promise<ApiFetchToBlobResult>(res => { resolveBlob = res; });
    });

    openBackupExportModal();
    const confirm = doc.getElementById('backupModalConfirmBtn');
    const cancel = doc.getElementById('backupModalCancelBtn');
    confirm.onclick?.();
    await flushPromises();

    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);

    onProgress?.(42, 100);
    expect(doc.getElementById('backupModalProgressLabel').textContent).toContain('42');

    resolveBlob({ ok: true, status: 200, blob: new Blob(['x']) });
    await flushPromises();
    expect(confirm.disabled).toBe(false);
    expect(cancel.disabled).toBe(false);
  });

  it('disables both modal buttons while a restore upload is pending, updates the bar, then re-enables', async () => {
    // The section-presence dry-run and the preview refresh go through apiFetch
    // and resolve at once; the actual apply has an upload progress callback and
    // goes through apiUpload, staying pending until we release it.
    transport.apiFetch.mockResolvedValue(
      { ok: true, status: 200, json: () => Promise.resolve({ preview: { sectionsPresent: ['shots'] } }) } as unknown as Response,
    );
    let onProgress: ((loaded: number, total: number) => void) | undefined;
    let resolveUpload: (v: ApiUploadResult) => void = () => {};
    transport.apiUpload.mockImplementation((_url, opts) => {
      onProgress = opts?.onProgress;
      return new Promise<ApiUploadResult>(res => { resolveUpload = res; });
    });

    const bytes = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0]);
    const input = { files: [{ arrayBuffer: () => Promise.resolve(bytes.buffer) }], value: '' };
    await openBackupRestoreModal(input as unknown as HTMLInputElement);
    await flushPromises();

    const confirm = doc.getElementById('backupModalConfirmBtn');
    const cancel = doc.getElementById('backupModalCancelBtn');
    confirm.onclick?.();
    await flushPromises();
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);

    onProgress?.(50, 100);
    expect(doc.getElementById('backupModalProgressLabel').textContent).toContain('50');

    resolveUpload(uploadResult({ ok: true, shots: 2 }));
    await flushPromises();
    expect(confirm.disabled).toBe(false);
    expect(cancel.disabled).toBe(false);
  });
});

describe('status.ts Dev Tools progress wiring (#960)', () => {
  it('exportDevDb disables the button, shows the transfer label, then restores it', async () => {
    const btn = makeElement({ textContent: 'Export DB', disabled: false });
    doc.els['devExportDbBtn'] = btn;
    let onProgress: ((received: number, total: number | null) => void) | undefined;
    let resolveBlob: (v: ApiFetchToBlobResult) => void = () => {};
    transport.apiFetchToBlob.mockImplementation((_url, opts) => {
      onProgress = opts?.onProgress;
      return new Promise<ApiFetchToBlobResult>(res => { resolveBlob = res; });
    });

    const pending = statusModule.exportDevDb();
    await flushPromises();
    expect(btn.disabled).toBe(true);

    onProgress?.(25, 100);
    expect(btn.textContent).toContain('25');

    resolveBlob({ ok: true, status: 200, blob: new Blob(['x']) });
    await pending;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Export DB');
  });

  it('importDevDb disables the card label while uploading, then restores it', async () => {
    const input = makeElement({ disabled: false });
    const label = makeElement({ textContent: 'Import DB', disabled: false });
    doc.els['devImportDbInput'] = input;
    doc.bySelector['#devToolsCard label span[data-i18n="settings_devtools_import_db"]'] = label;
    let resolveUpload: (v: ApiUploadResult) => void = () => {};
    transport.apiUpload.mockImplementation(() => new Promise<ApiUploadResult>(res => { resolveUpload = res; }));

    const file = { arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) } as unknown as File;
    const pending = statusModule.importDevDb(file);
    await flushPromises();
    expect(label.disabled).toBe(true);
    expect(input.disabled).toBe(true);

    resolveUpload(uploadResult({}));
    await pending;
    expect(label.disabled).toBe(false);
    expect(input.disabled).toBe(false);
    expect(alertSpy).toHaveBeenCalled();
  });
});

describe('api/system.ts transfer transport (#1110)', () => {
  it('requestBackup drives the export bar off the X-GLP-Backup-Estimate header', async () => {
    transport.apiFetchToBlob.mockResolvedValue({ ok: true, status: 200, blob: new Blob() });
    await systemModule.requestBackup({ sections: ['shots'] });
    expect(transport.apiFetchToBlob).toHaveBeenCalledWith(
      'api/backup',
      expect.objectContaining({ estimateHeader: 'X-GLP-Backup-Estimate' }),
    );
  });

  it('postRestore routes a zip upload through apiUpload against api/restore', async () => {
    transport.apiUpload.mockResolvedValue(uploadResult({}));
    await systemModule.postRestore({ zipBytes: new ArrayBuffer(4), onProgress: () => {} });
    expect(transport.apiUpload).toHaveBeenCalledWith('api/restore', expect.objectContaining({ method: 'POST' }));
  });

  it('exportDevDb and importDevDb target the Dev Tools debug endpoints with progress', async () => {
    transport.apiFetchToBlob.mockResolvedValue({ ok: true, status: 200, blob: new Blob() });
    transport.apiUpload.mockResolvedValue(uploadResult({}));
    await systemModule.exportDevDb(() => {});
    await systemModule.importDevDb(new ArrayBuffer(4), () => {});

    const blobCall = transport.apiFetchToBlob.mock.calls.at(-1);
    expect(blobCall?.[0]).toBe('api/debug/export-db');
    expect(typeof blobCall?.[1]?.onProgress).toBe('function');

    const uploadCall = transport.apiUpload.mock.calls.at(-1);
    expect(uploadCall?.[0]).toBe('api/debug/import-db');
    expect(typeof uploadCall?.[1]?.onProgress).toBe('function');
  });
});
