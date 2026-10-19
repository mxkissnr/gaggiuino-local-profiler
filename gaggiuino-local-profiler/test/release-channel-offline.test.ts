// #1762: GET api/machine/settings?category=system now fails fast (502) when
// the machine is known offline, and the release-channel select must be
// disabled after that failure so nobody picks a channel whose save would
// silently fail. A later successful load must re-enable it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (same bridge as machines-settings-theme-form.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

// Minimal fake DOM: enough for openMachineForm()/syncThemeFormUI() to run and
// for loadReleaseChannel() to read/write the select's value and disabled flag.
class FakeEl {
  value = '';
  innerHTML = '';
  textContent = '';
  style: Record<string, string> = {};
  disabled = false;
  constructor() {
    this.value = '';
    this.innerHTML = '';
    this.textContent = '';
    this.style = {};
  }
  querySelectorAll(): unknown[] { return []; }
}

const elements: Record<string, FakeEl> = {};
function fakeElement(id: string): FakeEl { return (elements[id] ??= new FakeEl()); }

g.document = { getElementById: fakeElement };

const okJson = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const errorJson = (status: number, body: unknown) =>
  Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) });

const { openMachineForm } = await import('../public-src/components/machines-settings.js');

type MachineFormArg = NonNullable<Parameters<typeof openMachineForm>[0]>;

const machine = { id: 7, name: 'Fake', type: 'gaggiuino', host: '192.168.1.50' } as unknown as MachineFormArg;

describe('release-channel select while the machine is offline (#1762)', () => {
  beforeEach(() => {
    for (const key of Object.keys(elements)) delete elements[key];
  });

  it('disables the select when the settings fetch answers 502, and re-enables it on the next successful load', async () => {
    g.fetch = () => errorJson(502, { error: 'machine offline' });
    openMachineForm(machine);
    const select = fakeElement('machineFormReleaseChannel');
    await vi.waitFor(() => expect(select.disabled).toBe(true));

    g.fetch = () => okJson({ releaseChannel: 1 });
    openMachineForm(machine);
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('1');
  });

  it('disables the select when the fetch rejects (network failure)', async () => {
    g.fetch = () => Promise.reject(new Error('network down'));
    openMachineForm(machine);
    const select = fakeElement('machineFormReleaseChannel');
    await vi.waitFor(() => expect(select.disabled).toBe(true));
  });
});
