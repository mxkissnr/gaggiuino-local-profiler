import { describe, it, expect, beforeEach, vi } from 'vitest';

// #1614 slice 4: refreshRestorePreview() had no sequencing, so a slower earlier
// dry-run could overwrite the preview of a later checkbox/passphrase state (or
// paint into the modal after it was closed). These tests drive the real restore
// modal through the two overlapping-preview cases.

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= {};

const mocks = vi.hoisted(() => ({ postRestore: vi.fn() }));
vi.mock('../public-src/api/system.js', () => ({ requestBackup: vi.fn(), postRestore: mocks.postRestore }));

let resolvers: Array<(r: Response) => void> = [];

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
  };

  constructor(doc: FakeDoc) {
    this.doc = doc;
  }

  addEventListener(_type: string, _fn: (...args: unknown[]) => void): void { /* only the module-load keydown wiring */ }
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

async function flushPromises(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

let doc: FakeDoc = makeDocument();
g.document = doc;

const { openBackupRestoreModal, closeBackupModal } = await import('../public-src/components/backup-modal.js');

beforeEach(() => {
  resolvers = [];
  mocks.postRestore.mockReset();
  mocks.postRestore.mockImplementation(() => new Promise<Response>(res => { resolvers.push(res); }));
  doc = makeDocument();
  g.document = doc;
  const cb = doc.createElement();
  cb.value = 'shots';
  cb.checked = true;
  cb.disabled = false;
  doc.checkboxes.push(cb);
});

describe('restore preview sequencing (#1614 slice 4)', () => {
  it('a slower earlier dry-run does not overwrite a newer preview', async () => {
    const input = { files: [jsonFile({ glp_backup: true, shots: [1] })], value: '' };
    await openBackupRestoreModal(input as unknown as HTMLInputElement);
    expect(resolvers.length).toBe(1);

    input.files = [jsonFile({ glp_backup: true, shots: [2] })];
    await openBackupRestoreModal(input as unknown as HTMLInputElement);
    expect(resolvers.length).toBe(2);

    // The newer preview resolves first...
    resolvers[1]!(jsonResponse({ preview: { shots: 222 } }));
    await flushPromises();
    expect(doc.getElementById('backupPreview').innerHTML).toContain('222');

    // ...and the older one landing last must be dropped.
    resolvers[0]!(jsonResponse({ preview: { shots: 111 } }));
    await flushPromises();
    expect(doc.getElementById('backupPreview').innerHTML).toContain('222');
    expect(doc.getElementById('backupPreview').innerHTML).not.toContain('111');
  });

  it('drops an in-flight preview after the modal closes', async () => {
    const input = { files: [jsonFile({ glp_backup: true, shots: [1] })], value: '' };
    await openBackupRestoreModal(input as unknown as HTMLInputElement);
    expect(resolvers.length).toBe(1);

    closeBackupModal();
    resolvers[0]!(jsonResponse({ preview: { shots: 111 } }));
    await flushPromises();

    expect(doc.getElementById('backupPreview').innerHTML).not.toContain('111');
  });
});
