// #729: "Test connection" now saves the machine form first (create via POST
// if no id yet, update via PUT if editing, same as the existing plain
// "Speichern" button) and, only on success, immediately tests the connection
// against the now-known id -- then briefly shows the result inline before
// closing the form and reloading the machines list, same as saveMachineForm()
// does. The previous standalone "Speichern und testen" button/action is gone
// (merged into this one), see machines-settings.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };
globalThis.window ??= globalThis;

// Same minimal fake DOM shape as machines-settings-theme-form.test.js.
class FakeEl {
  constructor() { this.value = ''; this.innerHTML = ''; this.textContent = ''; this.style = {}; }
  querySelectorAll() { return []; }
  addEventListener() {}
}

const elements = {};
function fakeElement(id) { return (elements[id] ??= new FakeEl()); }

globalThis.document = { getElementById: fakeElement };

const { S } = await import('../public-src/state.js');
// Node's own built-in `navigator` global (present since Node 21) reflects the
// host OS locale rather than a fixed 'en-US' -- S.currentLang's own
// navigator.language-based default (state.js) is therefore host-locale-
// dependent unless forced here, which would make this file's t()-derived
// assertions non-portable across machines.
S.currentLang = 'en';

const { saveMachineForm, testMachineForm } =
  await import('../public-src/components/machines-settings.js');

function setFormFields({ id = '', name = 'Test Machine', host = '192.168.1.50' } = {}) {
  fakeElement('machineFormId').value = id;
  fakeElement('machineFormName').value = name;
  fakeElement('machineFormType').value = 'gaggiuino';
  fakeElement('machineFormHost').value = host;
  fakeElement('machineFormSwitch').value = '';
  fakeElement('machineFormCard').style.display = ''; // as openMachineForm() would leave it
  fakeElement('machineFormTestResult').textContent = '';
}

describe('testMachineForm (#729)', () => {
  beforeEach(() => {
    for (const key of Object.keys(elements)) delete elements[key];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('on save success, tests the newly-created machine id, shows the result inline, then closes and reloads', async () => {
    setFormFields({ id: '' }); // brand-new machine — no id yet, POST path
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method });
      if (String(url) === 'api/machines' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ id: 42, name: 'Test Machine' }) };
      }
      if (String(url) === 'api/machines/42/test' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, reachable: true }) };
      }
      // loadMachines() GET after the setTimeout below
      if (String(url) === 'api/machines') return { ok: true, json: async () => [] };
      throw new Error(`unexpected fetch: ${opts?.method || 'GET'} ${url}`);
    };

    await testMachineForm();

    expect(calls).toEqual([
      { url: 'api/machines', method: 'POST' },
      { url: 'api/machines/42/test', method: 'POST' },
    ]);
    // Result shown inline immediately, form still open (closes after the delay below).
    expect(fakeElement('machineFormTestResult').textContent).toBe('✓ Reachable');
    expect(fakeElement('machineFormCard').style.display).toBe('');

    await vi.advanceTimersByTimeAsync(1200);

    expect(fakeElement('machineFormCard').style.display).toBe('none');
  });

  it('on save success while editing an existing machine, tests against the existing id, then closes', async () => {
    setFormFields({ id: '9' }); // editing — PUT path
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method });
      if (String(url) === 'api/machines/9' && opts?.method === 'PUT') {
        return { ok: true, json: async () => ({ id: 9, name: 'Test Machine' }) };
      }
      if (String(url) === 'api/machines/9/test' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, reachable: false }) };
      }
      if (String(url) === 'api/machines') return { ok: true, json: async () => [] };
      throw new Error(`unexpected fetch: ${opts?.method || 'GET'} ${url}`);
    };

    await testMachineForm();

    expect(calls).toEqual([
      { url: 'api/machines/9', method: 'PUT' },
      { url: 'api/machines/9/test', method: 'POST' },
    ]);
    expect(fakeElement('machineFormTestResult').textContent).toBe('✗ Not reachable');

    await vi.advanceTimersByTimeAsync(1200);

    expect(fakeElement('machineFormCard').style.display).toBe('none');
  });

  it('on save failure (server-rejected), shows the save error, never calls the test endpoint, and does not close', async () => {
    setFormFields({ id: '' });
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method });
      return { ok: false, status: 400, json: async () => ({ error: 'host not allowed' }) };
    };

    await testMachineForm();

    expect(calls).toEqual([{ url: 'api/machines', method: 'POST' }]);
    expect(fakeElement('machineFormTestResult').textContent).toBe('Error: host not allowed');
    expect(fakeElement('machineFormCard').style.display).toBe(''); // still open

    await vi.advanceTimersByTimeAsync(1200);

    expect(fakeElement('machineFormCard').style.display).toBe(''); // still open, no close scheduled
  });

  it('refuses when save fails validation (empty name/host), never calls fetch', async () => {
    setFormFields({ id: '', name: '', host: '' });
    globalThis.fetch = async () => { throw new Error('should not fetch'); };

    await testMachineForm();

    expect(fakeElement('machineFormTestResult').textContent).toBe('');
    expect(fakeElement('machineFormCard').style.display).toBe(''); // still open
  });

  // #730 review: #machineFormId used to stay empty after a successful save,
  // even though the machine now has a real id -- a second call before the
  // dwell timer closed the form (e.g. a double-click) re-entered
  // _saveMachine() with that still-empty id and POSTed a duplicate machine
  // instead of PUTing the one just created.
  it('#730 regression guard: writes the new id back into the form on success, so a second call would PUT instead of POST again', async () => {
    setFormFields({ id: '' });
    let calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method });
      if (String(url) === 'api/machines' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ id: 42, name: 'Test Machine' }) };
      }
      if (String(url) === 'api/machines/42' && opts?.method === 'PUT') {
        return { ok: true, json: async () => ({ id: 42, name: 'Test Machine' }) };
      }
      if (String(url) === 'api/machines/42/test' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, reachable: true }) };
      }
      if (String(url) === 'api/machines') return { ok: true, json: async () => [] };
      throw new Error(`unexpected fetch: ${opts?.method || 'GET'} ${url}`);
    };

    await testMachineForm();
    expect(fakeElement('machineFormId').value).toBe(42);

    // Simulate a second invocation landing before the dwell timer closes the
    // form (what a double-click used to trigger).
    calls = [];
    await testMachineForm();
    expect(calls[0]).toEqual({ url: 'api/machines/42', method: 'PUT' });
  });

  // #730 review: the button itself is also disabled for the whole
  // save+test+dwell window, so a real double-click can't even start a
  // second call in the browser (a disabled <button> doesn't fire click
  // events) -- belt-and-suspenders alongside the id-rewrite above.
  it('#730 regression guard: disables the test button for the whole in-flight+dwell window, re-enabling once the form closes', async () => {
    setFormFields({ id: '' });
    globalThis.fetch = async (url, opts) => {
      if (String(url) === 'api/machines' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ id: 42, name: 'Test Machine' }) };
      }
      if (String(url) === 'api/machines/42/test' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, reachable: true }) };
      }
      if (String(url) === 'api/machines') return { ok: true, json: async () => [] };
      throw new Error(`unexpected fetch: ${opts?.method || 'GET'} ${url}`);
    };
    const btn = fakeElement('machineFormTestBtn');
    expect(btn.disabled).toBeFalsy();

    const pending = testMachineForm(); // runs synchronously up to its first `await`
    expect(btn.disabled).toBe(true);

    await pending;
    expect(btn.disabled).toBe(true); // still disabled -- close is still pending in the dwell timer

    await vi.advanceTimersByTimeAsync(1200);
    expect(btn.disabled).toBe(false);
  });
});

describe('saveMachineForm (unchanged behavior)', () => {
  beforeEach(() => {
    for (const key of Object.keys(elements)) delete elements[key];
  });

  it('on success still closes the form and reloads the machines list', async () => {
    setFormFields({ id: '' });
    globalThis.fetch = async (url, opts) => {
      if (String(url) === 'api/machines' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ id: 5, name: 'Test Machine' }) };
      }
      if (String(url) === 'api/machines') return { ok: true, json: async () => [] }; // loadMachines() GET
      return { ok: true, json: async () => ({}) };
    };

    await saveMachineForm();

    expect(fakeElement('machineFormCard').style.display).toBe('none');
  });

  it('on failure shows the save error and does not close the form', async () => {
    setFormFields({ id: '' });
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad host' }) });

    await saveMachineForm();

    expect(fakeElement('machineFormTestResult').textContent).toBe('Error: bad host');
    expect(fakeElement('machineFormCard').style.display).toBe('');
  });
});
