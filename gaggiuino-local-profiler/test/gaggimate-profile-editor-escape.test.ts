import { describe, it, expect, beforeEach, vi } from 'vitest';

// gaggimate-profile-editor.ts's import chain (state/i18n/constants/shots) reads
// localStorage/navigator at module load time — stub the minimum browser globals
// so the module graph can be imported under vitest's node environment (same
// pattern as test/library-profile-editor.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const { openGaggiMateProfileEditor } = await import('../public-src/views/gaggimate-profile-editor.js');

// The rendered value attribute for the injected payload, after esc() turns the
// embedded quotes into &quot;.
const EVIL = '1" onfocus="alert(1)';
const EVIL_ATTR = 'value="1&quot; onfocus=&quot;alert(1)"';
// What a breakout would look like: an unescaped quote right before a new
// onfocus attribute name.
const BREAKOUT = '" onfocus="';

interface FakeEl {
  innerHTML: string;
  style: Record<string, string>;
  textContent: string;
  addEventListener(): void;
}

// Minimal fake document. The editor renders into #gmEditorBody and only reads a
// handful of other ids for binding; #gmProfileChart is absent so the Chart.js
// branch bails before it touches a canvas.
function fakeDocument() {
  const els: Record<string, FakeEl> = {};
  const getElementById = (id: string): FakeEl | undefined => {
    if (id === 'gmProfileChart') return undefined;
    return (els[id] ??= { innerHTML: '', style: {}, textContent: '', addEventListener() {} });
  };
  return { els, document: { getElementById, querySelectorAll: () => [] } };
}

function profileResponse(profile: unknown): Response {
  return { ok: true, json: () => Promise.resolve(profile) } as unknown as Response;
}

async function renderRaw(profile: unknown): Promise<string> {
  const { els, document: doc } = fakeDocument();
  g.document = doc;
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValueOnce(profileResponse(profile));
  await openGaggiMateProfileEditor('p1');
  return els.gmEditorBody.innerHTML;
}

describe('gaggimate profile editor escapes machine-supplied values', () => {
  beforeEach(() => { fetchSpy.mockReset(); });

  it('escapes a standard profile\'s string-typed temperature, duration and stop-weight', async () => {
    const html = await renderRaw({
      id: 'p1', label: 'Evil', description: '', type: 'standard', utility: false, favorite: false,
      temperature: EVIL,
      phases: [{
        name: 'Brew', phase: 'brew', valve: 1, pump: 100, duration: EVIL,
        targets: [{ type: 'volumetric', operator: 'gte', value: EVIL }],
      }],
    });

    const tempInput = /<input[^>]*id="gmTemperature"[^>]*>/.exec(html)?.[0] ?? '';
    expect(tempInput).toContain(EVIL_ATTR); // machine temperature lands in the value attribute escaped
    expect(html).toContain(EVIL_ATTR);      // duration and stop-weight too
    expect(html).not.toContain(BREAKOUT);   // no attribute breakout / no onfocus attribute
  });

  it('escapes a pro profile\'s string-typed temperature, pressure, flow, ramp length and target value', async () => {
    const html = await renderRaw({
      id: 'p2', label: 'Evil Pro', description: '', type: 'pro', utility: false, favorite: false,
      temperature: EVIL,
      phases: [{
        name: 'Brew', phase: 'brew', valve: 1, duration: EVIL, temperature: EVIL,
        pump: { target: 'pressure', pressure: EVIL, flow: EVIL },
        transition: { type: 'linear', duration: EVIL, adaptive: true, target: 'time' },
        targets: [{ type: 'pressure', operator: 'gte', value: EVIL }],
      }],
    });

    const tempInput = /<input[^>]*id="gmTemperature"[^>]*>/.exec(html)?.[0] ?? '';
    expect(tempInput).toContain(EVIL_ATTR);
    expect(html).toContain(EVIL_ATTR);    // phase temperature, pressure, flow, ramp length, target value
    expect(html).not.toContain(BREAKOUT);
  });
});
