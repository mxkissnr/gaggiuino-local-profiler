// #684: after a successful restore, the app used to only refresh shots
// (window.loadData()) before showing the result alert -- restored
// library/machines/settings/menu/etc. stayed stale until a manual reload.
//
// This drives the real restore confirm handler through a fake DOM (the same
// harness test/backup-modal-preview.test.ts uses) with a mocked successful
// postRestore, and records the order of the result alert and location.reload()
// instead of grepping backup-modal.ts for the two calls.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const mocks = vi.hoisted(() => ({ postRestore: vi.fn() }));
vi.mock('../public-src/api/system.js', () => ({ requestBackup: vi.fn(), postRestore: mocks.postRestore }));

interface FakeDoc {
  els: Record<string, FakeEl>;
  checkboxes: FakeEl[];
  createElement: () => FakeEl;
  getElementById: (id: string) => FakeEl;
  querySelectorAll: (selector: string) => FakeEl[];
}

class FakeEl {
  id = '';
  innerHTML = '';
  textContent = '';
  className = '';
  style: Record<string, string> = {};
  checked = false;
  disabled = false;
  value = '';
  hidden = false;
  children: FakeEl[] = [];
  onchange: (() => void) | null = null;
  oninput: (() => void) | null = null;
  onclick: (() => void) | null = null;
  private readonly doc: FakeDoc;
  readonly classList = {
    add: (_name: string): void => {},
    remove: (_name: string): void => {},
    contains: (_name: string): boolean => false,
    toggle: (_name: string, _on?: boolean): boolean => false,
  };

  constructor(doc: FakeDoc) {
    this.doc = doc;
  }

  addEventListener(_type: string, _fn: (...args: unknown[]) => void): void { /* module-load keydown wiring only */ }
  removeEventListener(_type: string, _fn: (...args: unknown[]) => void): void { /* no-op */ }
  appendChild(child: FakeEl): FakeEl { this.children.push(child); return child; }
  querySelector(_selector: string): FakeEl { return this.doc.createElement(); }
  querySelectorAll(): FakeEl[] { return []; }
}

function makeDocument(): FakeDoc {
  const els: Record<string, FakeEl> = {};
  const doc: FakeDoc = {
    els,
    checkboxes: [],
    createElement: () => new FakeEl(doc),
    getElementById: (id: string) => (els[id] ??= Object.assign(new FakeEl(doc), { id })),
    querySelectorAll: (selector: string) => (selector === '.backup-section-cb' ? doc.checkboxes : []),
  };
  return doc;
}

// A restore-file stub: only arrayBuffer() and value are read by the modal.
interface FileLike {
  arrayBuffer: () => Promise<ArrayBuffer>;
}
function jsonFile(bundle: Record<string, unknown>): FileLike {
  return {
    arrayBuffer: () => {
      const bytes = new TextEncoder().encode(JSON.stringify(bundle));
      return Promise.resolve(bytes.buffer);
    },
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}
// postRestore's non-zip path resolves to the Response-like restore result the
// modal reads with .ok/.json().
function restoreResponse(body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

async function flushPromises(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

// Call order of the observable side effects of a successful restore.
const order: string[] = [];
let alertMsg: unknown;

let doc: FakeDoc = makeDocument();
g.document = doc;
g.alert = (msg: unknown): void => { alertMsg = msg; order.push('alert'); };
g.location = { reload: (): void => { order.push('reload'); } };
const loadData = vi.fn();
g.window = { showToast: (): void => {}, loadData };

const { openBackupRestoreModal } = await import('../public-src/components/backup-modal.js');

beforeEach(() => {
  order.length = 0;
  alertMsg = undefined;
  loadData.mockReset();
  mocks.postRestore.mockReset();
  doc = makeDocument();
  g.document = doc;
  const cb = doc.createElement();
  cb.value = 'shots';
  cb.checked = true;
  cb.disabled = false;
  doc.checkboxes.push(cb);
  // The dry-run preview (openBackupRestoreModal) gets a preview body; the real
  // restore (confirm) gets the applied-result body.
  mocks.postRestore.mockImplementation((opts: { dryRun?: boolean } | undefined) =>
    opts?.dryRun
      ? Promise.resolve(jsonResponse({ preview: { shots: 3 } }))
      : Promise.resolve(restoreResponse({ ok: true, shots: 3 })));
});

describe('restore confirm handler (#684)', () => {
  it('shows the result alert, then reloads, and never falls back to window.loadData', async () => {
    const input = { files: [jsonFile({ glp_backup: true, shots: [1] })], value: '' };
    await openBackupRestoreModal(input as unknown as HTMLInputElement);

    doc.getElementById('backupModalConfirmBtn').onclick?.();
    await flushPromises();

    expect(order).toContain('alert');
    expect(order).toContain('reload');
    expect(order.indexOf('alert')).toBeLessThan(order.indexOf('reload'));
    expect(order).not.toContain('loadData');
    expect(loadData).not.toHaveBeenCalled();
    // The alert carries the restored-shot-count message, not an empty string.
    expect(typeof alertMsg).toBe('string');
    expect(String(alertMsg)).toContain('3');
  });

  it('does not reload before the alert, so the user sees the message first', async () => {
    const input = { files: [jsonFile({ glp_backup: true, shots: [1] })], value: '' };
    await openBackupRestoreModal(input as unknown as HTMLInputElement);

    doc.getElementById('backupModalConfirmBtn').onclick?.();
    await flushPromises();

    expect(order).toEqual(['alert', 'reload']);
  });
});
