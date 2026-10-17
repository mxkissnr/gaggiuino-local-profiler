import { describe, it, expect, vi } from 'vitest';
import { installBootStubs } from './helpers/boot-stub-dom.js';

// #1615: the real data boot chain (boot/data.ts) with one step failing. A
// drink menu answer that is not a list makes the shot-defaults card throw
// inside the settings step. Before, that rejection silently skipped the whole
// rest of the chain; now only what needs the settings (library -> shots) is
// skipped and logged, while the independent branches -- machines, the status
// poll, the update check and the setup wizard check -- still run.

describe('data boot chain with a failing step (#1615)', () => {
  it('skips the steps that depend on the failed one and still runs the independent ones', async () => {
    const { doc, requested } = installBootStubs({ bodies: { 'api/menu': {} } });
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

    // The update check is the chain's last request, after the status poll.
    await vi.waitFor(() => expect(requested).toContain('api/version'), { timeout: 20000 });
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
      '[GLP] boot step "shots" skipped: "library" did not complete'), { timeout: 20000 });
    expect(errorSpy).toHaveBeenCalledWith('[GLP] boot step "settings" failed:', expect.any(TypeError));
    expect(errorSpy).toHaveBeenCalledWith('[GLP] boot step "library" skipped: "settings" did not complete');
    expect(requested).toContain('api/machines');
    expect(requested).toContain('api/status');
    // The skipped library load never went out.
    expect(requested).not.toContain('api/library');
    errorSpy.mockRestore();
  }, 30_000); // importing the whole main.ts module graph is slow under a parallel suite run
});
