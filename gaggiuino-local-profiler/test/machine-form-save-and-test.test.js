// #727: "Speichern und testen" combined action — saves the machine form
// (create via POST if no id yet, update via PUT if editing, same as the
// existing plain "Speichern" button) and, only on success, immediately
// tests the connection against the now-known id. saveMachineForm() and
// testMachineForm() were refactored to share this save/test logic via two
// internal helpers (_saveMachine()/_testMachine()) rather than duplicating
// it — these tests also lock in that the two existing standalone buttons'
// behavior is unchanged by that refactor.
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

const { saveMachineForm, testMachineForm, saveAndTestMachineForm } =
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

describe('saveAndTestMachineForm (#727)', () => {
  beforeEach(() => {
    for (const key of Object.keys(elements)) delete elements[key];
  });

  it('on save success, tests the newly-created machine id and does not close the form or reload the machines list', async () => {
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
      throw new Error(`unexpected fetch: ${opts?.method || 'GET'} ${url}`);
    };

    await saveAndTestMachineForm();

    expect(calls).toEqual([
      { url: 'api/machines', method: 'POST' },
      { url: 'api/machines/42/test', method: 'POST' },
    ]);
    // closeMachineForm() would flip this to 'none' -- it must not have run.
    expect(fakeElement('machineFormCard').style.display).toBe('');
    expect(fakeElement('machineFormTestResult').textContent).toBe('✓ Reachable');
  });

  it('on save success while editing an existing machine, tests against the existing id', async () => {
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
      throw new Error(`unexpected fetch: ${opts?.method || 'GET'} ${url}`);
    };

    await saveAndTestMachineForm();

    expect(calls).toEqual([
      { url: 'api/machines/9', method: 'PUT' },
      { url: 'api/machines/9/test', method: 'POST' },
    ]);
    expect(fakeElement('machineFormTestResult').textContent).toBe('✗ Not reachable');
  });

  it('on save failure, shows the save error and never calls the test endpoint', async () => {
    setFormFields({ id: '' });
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method });
      return { ok: false, status: 400, json: async () => ({ error: 'host not allowed' }) };
    };

    await saveAndTestMachineForm();

    expect(calls).toEqual([{ url: 'api/machines', method: 'POST' }]);
    expect(fakeElement('machineFormTestResult').textContent).toBe('Error: host not allowed');
    expect(fakeElement('machineFormCard').style.display).toBe(''); // still open
  });
});

describe('saveMachineForm (unchanged behavior after #727 refactor)', () => {
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

describe('testMachineForm (unchanged behavior after #727 refactor)', () => {
  beforeEach(() => {
    for (const key of Object.keys(elements)) delete elements[key];
  });

  it('still refuses to test a never-saved machine (no id)', async () => {
    setFormFields({ id: '' });
    globalThis.fetch = async () => { throw new Error('should not fetch'); };

    await testMachineForm();

    expect(fakeElement('machineFormTestResult').textContent).toBe('Save first');
  });

  it('tests the existing id when already saved', async () => {
    setFormFields({ id: '3' });
    globalThis.fetch = async (url, opts) => {
      expect(String(url)).toBe('api/machines/3/test');
      expect(opts?.method).toBe('POST');
      return { ok: true, json: async () => ({ ok: true, reachable: true }) };
    };

    await testMachineForm();

    expect(fakeElement('machineFormTestResult').textContent).toBe('✓ Reachable');
  });
});
