// #729: "Test connection" saves the machine form first (create via POST if
// no id yet, update via PUT if editing, same as the existing plain
// "Speichern" button) and, only on success, immediately tests the connection
// against the now-known id, showing the result inline. The previous
// standalone "Speichern und testen" button/action is gone (merged into this
// one), see machines-settings.js.
//
// #731: that implicit save must not itself start a shot import (only an
// explicit "Speichern" click should) -- so testMachineForm()'s POST/PUT
// carry a `?sync=0` query param the plain saveMachineForm() path doesn't,
// see test/machines-api.test.js's sync-on-save suite for the server side.
//
// #733: #729 originally auto-closed the form after a 1200ms dwell, matching
// Save's behavior -- live testing found that confusing for a *test* action
// (the user wants to see the result and stay in place, e.g. to fix a bad
// host and test again), so the auto-close was removed. Only the explicit
// Save button closes the form now; the id-rewrite/button-disable guards from
// the #730 review still apply since the form (and its Test button) stays
// open and clickable.
import { describe, it, expect, beforeEach } from 'vitest';

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

describe('testMachineForm (#729/#733)', () => {
  beforeEach(() => {
    for (const key of Object.keys(elements)) delete elements[key];
  });

  it('on save success, tests the newly-created machine id, shows the result inline, and leaves the form open', async () => {
    setFormFields({ id: '' }); // brand-new machine — no id yet, POST path
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method });
      // #731: the implicit save behind "Test connection" carries ?sync=0 so
      // the server doesn't start an import for it -- see machines-settings.js.
      if (String(url) === 'api/machines?sync=0' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ id: 42, name: 'Test Machine' }) };
      }
      if (String(url) === 'api/machines/42/test' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, reachable: true }) };
      }
      // loadMachines() GET after the test call
      if (String(url) === 'api/machines') return { ok: true, json: async () => [] };
      throw new Error(`unexpected fetch: ${opts?.method || 'GET'} ${url}`);
    };

    await testMachineForm();

    expect(calls).toEqual([
      { url: 'api/machines?sync=0', method: 'POST' },
      { url: 'api/machines/42/test', method: 'POST' },
      { url: 'api/machines', method: undefined }, // loadMachines() refresh
    ]);
    expect(fakeElement('machineFormTestResult').textContent).toBe('✓ Reachable');
    expect(fakeElement('machineFormCard').style.display).toBe('');
  });

  it('on save success while editing an existing machine, tests against the existing id and leaves the form open', async () => {
    setFormFields({ id: '9' }); // editing — PUT path
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method });
      if (String(url) === 'api/machines/9?sync=0' && opts?.method === 'PUT') {
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
      { url: 'api/machines/9?sync=0', method: 'PUT' },
      { url: 'api/machines/9/test', method: 'POST' },
      { url: 'api/machines', method: undefined },
    ]);
    expect(fakeElement('machineFormTestResult').textContent).toBe('✗ Not reachable');
    expect(fakeElement('machineFormCard').style.display).toBe('');
  });

  it('on save failure (server-rejected), shows the save error and never calls the test endpoint', async () => {
    setFormFields({ id: '' });
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method });
      return { ok: false, status: 400, json: async () => ({ error: 'host not allowed' }) };
    };

    await testMachineForm();

    expect(calls).toEqual([{ url: 'api/machines?sync=0', method: 'POST' }]);
    expect(fakeElement('machineFormTestResult').textContent).toBe('Error: host not allowed');
    expect(fakeElement('machineFormCard').style.display).toBe(''); // still open
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
  // form closed re-entered _saveMachine() with that still-empty id and
  // POSTed a duplicate machine instead of PUTing the one just created. The
  // form staying open by default (#733) makes a second click even easier to
  // trigger, so this guard matters more now, not less.
  it('#730 regression guard: writes the new id back into the form on success, so a second call would PUT instead of POST again', async () => {
    setFormFields({ id: '' });
    let calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method });
      if (String(url) === 'api/machines?sync=0' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ id: 42, name: 'Test Machine' }) };
      }
      if (String(url) === 'api/machines/42?sync=0' && opts?.method === 'PUT') {
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

    // Simulate a second invocation while the form is still open (what a
    // double-click, or simply testing again, triggers).
    calls = [];
    await testMachineForm();
    expect(calls[0]).toEqual({ url: 'api/machines/42?sync=0', method: 'PUT' });
  });

  // #730 review: the button itself is also disabled for the whole
  // save+test window, so a real double-click can't even start a second call
  // in the browser (a disabled <button> doesn't fire click events) --
  // belt-and-suspenders alongside the id-rewrite above.
  it('#730 regression guard: disables the test button for the whole in-flight window, re-enabling once it settles', async () => {
    setFormFields({ id: '' });
    globalThis.fetch = async (url, opts) => {
      if (String(url) === 'api/machines?sync=0' && opts?.method === 'POST') {
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
    expect(btn.disabled).toBe(false);
  });

  // #734 review: #733 removed the auto-close, so the form (and the
  // still-clickable machines list behind it) can now stay open long enough
  // for the user to switch to editing a *different* machine while a test is
  // still in flight -- without a staleness guard, machine A's test result
  // would land in #machineFormTestResult after the user has already moved
  // on to viewing/editing machine B's data.
  it('#734 regression guard: discards a test result if #machineFormId no longer matches the machine being tested', async () => {
    setFormFields({ id: '9' });
    let resolveTest;
    const pendingTest = new Promise(res => { resolveTest = res; });
    globalThis.fetch = async (url, opts) => {
      if (String(url) === 'api/machines/9?sync=0' && opts?.method === 'PUT') {
        return { ok: true, json: async () => ({ id: 9, name: 'Test Machine' }) };
      }
      if (String(url) === 'api/machines/9/test' && opts?.method === 'POST') return pendingTest;
      if (String(url) === 'api/machines') return { ok: true, json: async () => [] };
      throw new Error(`unexpected fetch: ${opts?.method || 'GET'} ${url}`);
    };

    const pending = testMachineForm();
    // Let the save round-trip (and testMachineForm()'s own id write-back)
    // fully settle before simulating the machine switch below -- a
    // macrotask tick guarantees every already-queued microtask (the mocked
    // PUT's await chain) has drained, landing us inside _testMachine()'s
    // still-pending `await apiFetch(.../test)` call.
    await new Promise(res => setTimeout(res, 0));
    // Simulate openMachineForm(otherMachine) landing while the test above is
    // still in flight -- it overwrites the id and clears the result field.
    fakeElement('machineFormId').value = 17;
    fakeElement('machineFormTestResult').textContent = '';

    resolveTest({ ok: true, json: async () => ({ ok: true, reachable: true }) });
    await pending;

    expect(fakeElement('machineFormTestResult').textContent).toBe('');
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
