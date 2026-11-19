// #2120: the GaggiMate editor's header close is its only cancel. It hides the
// editor and drops the draft, exactly as the removed footer Cancel did.
import { describe, it, expect, vi } from 'vitest';

// The editor's import chain reads localStorage/navigator at module load time;
// same stubs as the editor escape test.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const { openNewGaggiMateProfile, handleGmEditorAction } = await import('../public-src/views/gaggimate-profile-editor.js');

interface FakeEl {
  innerHTML: string;
  style: Record<string, string>;
  textContent: string;
  dataset: Record<string, string>;
  addEventListener(): void;
}

// Every id resolves to a fake element; #gmProfileChart is absent so the
// Chart.js branch bails before it touches a canvas.
function installDocument(): Record<string, FakeEl> {
  const els: Record<string, FakeEl> = {};
  const getElementById = (id: string): FakeEl | undefined => {
    if (id === 'gmProfileChart') return undefined;
    return (els[id] ??= { innerHTML: '', style: {}, textContent: '', dataset: {}, addEventListener() {} });
  };
  g.document = { getElementById, querySelectorAll: () => [] };
  return els;
}

describe('GaggiMate editor header close (#2120)', () => {
  it('hides the editor and drops the draft', () => {
    const els = installDocument();
    const trigger: FakeEl = { innerHTML: '', style: {}, textContent: '', dataset: {}, addEventListener() {} };

    openNewGaggiMateProfile();
    expect(els.gmProfileEditorModal?.style.display).toBe('flex');

    handleGmEditorAction('gm-editor-close', trigger as unknown as HTMLElement);
    expect(els.gmProfileEditorModal?.style.display).toBe('none');

    // The draft is gone: a save after closing sends nothing.
    fetchSpy.mockReset();
    handleGmEditorAction('gm-editor-save', trigger as unknown as HTMLElement);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
