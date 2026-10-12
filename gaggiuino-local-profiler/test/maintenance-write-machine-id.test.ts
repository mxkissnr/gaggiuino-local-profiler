// maintenance.ts _writeMachineId() in the all-machines scope — #1605. A write
// that omits an explicit machine (the manual log entry from
// submitMaintLogEntry()) must target the default machine, not merely the first
// registered one: the two differ whenever the machine list is not ordered with
// the default machine first, so the old machines[0] fallback sent the entry to
// the wrong machine.
//
// Only the write path is exercised (no dashboard render): the fake document
// serves the three fields submitMaintLogEntry reads, and the fetch mock records
// the URL addMaintenanceLogEntry is finally called with.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;

const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => _store.get(k) ?? null,
  setItem: (k: string, v: string) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };

interface FakeField { value: string }

function makeFakeDocument() {
  const fields = new Map<string, FakeField>();
  return {
    // Only maintLogTask/maintLogDate/maintLogNotes are registered; every other
    // lookup (maintLogForm, maintLog) returns null, so the post-write
    // closeMaintLogForm()/loadMaintLog() calls are no-ops.
    getElementById: (id: string): FakeField | null => fields.get(id) ?? null,
    _set(id: string, value: string): void { fields.set(id, { value }); },
  };
}

const { S } = await import('../public-src/state/index.js');
const { submitMaintLogEntry } = await import('../public-src/views/maintenance.js');

describe('_writeMachineId() in the all-machines scope — #1605', () => {
  let doc: ReturnType<typeof makeFakeDocument>;
  let fetchUrls: string[];

  beforeEach(() => {
    doc = makeFakeDocument();
    doc._set('maintLogTask', 'descaling');
    doc._set('maintLogDate', '2026-01-01');
    doc._set('maintLogNotes', 'manual entry');
    g.document = doc;
    // Two machines, default is the second: the all-machines scope must not
    // simply take machines[0].
    S.machines = [{ id: 3, name: 'B' }, { id: 5, name: 'A', isDefault: true }];
    fetchUrls = [];
    g.fetch = vi.fn((url: unknown) => {
      fetchUrls.push(String(url));
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as unknown as Response);
    });
  });

  it('targets the default machine (not machines[0]) for a manual log entry', async () => {
    await submitMaintLogEntry();
    expect(fetchUrls).toContain('api/maintenance/log?machineId=5');
  });
});
