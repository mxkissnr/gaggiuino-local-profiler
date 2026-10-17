import { describe, it, expect, vi } from 'vitest';
import { installBootStubs } from './helpers/boot-stub-dom.js';

// #1615: main.ts's DOM wiring used to be one 730-line DOMContentLoaded
// handler, so a single element lookup failing on its `!` aborted every line
// after it, the data boot chain included. The wiring now runs as independent
// boot steps that each catch and log. Here the first element the app-shell
// step looks up is missing: that step is logged and skipped, while the later
// steps and the data boot chain still run.

describe('boot steps (#1615)', () => {
  it('a step that throws is logged and skipped; later steps and the data chain still run', async () => {
    const { doc, element, requested } = installBootStubs({ missingIds: ['collapseBtn'] });
    const g = globalThis as unknown as Record<string, unknown>;
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await import('../public-src/main.js');
    doc.dispatchEvent(new Event('DOMContentLoaded'));

    expect(errorSpy).toHaveBeenCalledWith('[GLP] boot step "app shell" failed:', expect.any(TypeError));
    expect(errorSpy.mock.calls.filter(c => String(c[0]).startsWith('[GLP] boot step'))).toHaveLength(1);

    const { S } = await import('../public-src/state/index.js');
    // The failed step's own wiring after the missing element is skipped...
    element('btnLibrary').dispatchEvent(new Event('click'));
    expect(S.currentMode).not.toBe('library');
    // ...but a later step (settings) is wired...
    element('restartSetupWizardBtn').dispatchEvent(new Event('click'));
    expect(S.setupWizardOpen).toBe(true);
    // ...and the data boot chain runs to its end.
    await vi.waitFor(() => expect(requested).toContain('api/version'), { timeout: 20000 });
    errorSpy.mockRestore();
  }, 30_000); // importing the whole main.ts module graph is slow under a parallel suite run
});
