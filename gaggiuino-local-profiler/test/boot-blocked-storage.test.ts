import { describe, it, expect, vi } from 'vitest';
import { installBootStubs } from './helpers/boot-stub-dom.js';

// #1615: with storage blocked by the browser (cookies/site data off, Safari
// private mode, sandboxed iframe) merely reading the `localStorage` global
// throws a SecurityError. state/index.ts used to read it at import time and
// initToken() at the head of the boot chain, so the whole SPA failed to
// start. This boots the real main.ts with both storage getters throwing and
// checks the import, the DOMContentLoaded wiring and the data boot chain all
// still run. An error thrown or rejected anywhere along the way surfaces as
// an unhandled error, which fails the vitest run on its own.

function throwingStorage(): never {
  throw new DOMException('The operation is insecure.', 'SecurityError');
}

describe('boot with blocked storage (#1615)', () => {
  it('imports main.ts, wires the DOM and runs the data boot chain while localStorage/sessionStorage throw', async () => {
    const { doc, element, requested } = installBootStubs();
    const g = globalThis as unknown as Record<string, unknown>;
    Object.defineProperty(g, 'localStorage', { get: throwingStorage, configurable: true });
    Object.defineProperty(g, 'sessionStorage', { get: throwingStorage, configurable: true });

    await import('../public-src/main.js');
    doc.dispatchEvent(new Event('DOMContentLoaded'));

    // The data boot chain ran to its end: token first, then the
    // settings/library/shots sequence, then the awaited status poll, after
    // which the update check (api/version) is the chain's last request.
    await vi.waitFor(() => {
      expect(requested).toContain('api/library');
      expect(requested).toContain('api/shots');
      expect(requested).toContain('api/version');
    }, { timeout: 20000 });
    expect(requested[0]).toBe('api/token');

    // The DOM wiring ran too: a nav button main.ts wired switches the mode.
    const { S } = await import('../public-src/state/index.js');
    element('btnLibrary').dispatchEvent(new Event('click'));
    expect(S.currentMode).toBe('library');
    // Reads fell back to defaults instead of throwing.
    expect(S.currentLang).toBe('en');
  }, 30_000); // importing the whole main.ts module graph is slow under a parallel suite run
});
