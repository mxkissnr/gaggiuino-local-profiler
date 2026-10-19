// Maintenance log notes: entries the backend took over from the machine carry
// the fixed marker text AUTO_SYNCED_NOTE. The log must render that marker as
// the translated badge instead of the raw English note — #1763.
import { describe, it, expect, beforeEach } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;

const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => _store.get(k) ?? null,
  setItem: (k: string, v: string) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };

interface FakeElement { innerHTML: string }

const { S } = await import('../public-src/state/index.js');
const { renderMaintLog, AUTO_SYNCED_NOTE } = await import('../public-src/views/maintenance.js');

type LogEntry = Parameters<typeof renderMaintLog>[0][number];

function entry(notes: string | null): LogEntry {
  return { id: 1, task: 'backflush', ts: 1767225600, machineId: 1, shotCountAtTime: 120, notes };
}

describe('maintenance log auto-synced note — #1763', () => {
  let log: FakeElement;

  beforeEach(() => {
    log = { innerHTML: '' };
    g.document = {
      // Only the log container is read; the year counter lookup returns null.
      getElementById: (id: string): FakeElement | null => (id === 'maintLog' ? log : null),
    };
    S.currentLang = 'de';
    S.machines = [];
  });

  it('renders the translated badge instead of the backend marker text', () => {
    renderMaintLog([entry(AUTO_SYNCED_NOTE)]);
    expect(log.innerHTML).toContain('class="maint-auto-synced"');
    expect(log.innerHTML).not.toContain(AUTO_SYNCED_NOTE);
  });

  it('renders a user note unchanged and escaped', () => {
    renderMaintLog([entry('Replaced <gasket> & cleaned')]);
    expect(log.innerHTML).toContain('Replaced &lt;gasket&gt; &amp; cleaned');
    expect(log.innerHTML).not.toContain('maint-auto-synced');
  });

  it('renders nothing for an empty note', () => {
    renderMaintLog([entry('')]);
    expect(log.innerHTML).not.toContain('maint-auto-synced');
    expect(log.innerHTML).not.toContain(AUTO_SYNCED_NOTE);
  });
});
