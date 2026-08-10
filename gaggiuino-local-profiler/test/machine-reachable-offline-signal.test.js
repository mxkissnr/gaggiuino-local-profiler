// #655: "status dot stays green for hours/days after the machine is
// switched off, live tab keeps showing 'Ready to brew'". Root cause was
// twofold:
//  1. Neither the status dot (public-src/components/status.js) nor the live
//     tab (public-src/views/live.js / GET /api/live/data) ever read
//     state.machineReachable at all -- the dot only looked at
//     lastSync/lastSyncError, which lib/sync.js's syncShots() never touches
//     when a configured switch entity reports the machine off (its early
//     return happens before any network call).
//  2. state.machineReachable itself froze at its last value once the
//     machine was switched off, because lib/poll.js's
//     checkAndApplyMachinePower() stops the only frequent reachability
//     prober (pollViaGaggiuinoStatus, via stopLivePolling()) without ever
//     setting state.machineReachable = false itself.
// These tests exercise the reported symptom end-to-end at each of the three
// fixed spots, not just the individual diffs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ── 1. Status dot (frontend) ────────────────────────────────────────────

const _store = new Map();
globalThis.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: k => { _store.delete(k); },
};
const _sessionStore = new Map();
globalThis.sessionStorage = {
  getItem: k => (_sessionStore.has(k) ? _sessionStore.get(k) : null),
  setItem: (k, v) => { _sessionStore.set(k, String(v)); },
  removeItem: k => { _sessionStore.delete(k); },
};
globalThis.navigator ??= { language: 'en-US' };
const _realFetch = globalThis.fetch;

const { S } = await import('../public-src/state.js');
const { updateStatus } = await import('../public-src/components/status.js');

function makeFakeDocument() {
  const registry = new Map();
  function makeElement() {
    return { className: '', textContent: '', title: '', style: {}, disabled: false, classList: { add() {}, remove() {}, contains: () => false } };
  }
  return {
    getElementById: id => registry.get(id),
    _preRegister(id) {
      const el = makeElement();
      registry.set(id, el);
      return el;
    },
  };
}

describe('status.js dot color reflects machineReachable (#655)', () => {
  let doc, fetchCalls;

  beforeEach(() => {
    doc = makeFakeDocument();
    ['statusDot', 'railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'btnLive'].forEach(id => doc._preRegister(id));
    globalThis.document = doc;
    S.primaryShotId = null;
    S.currentLang = 'en';
    // Non-empty so onboarding.js's updateMachineBanner() (called unconditionally
    // inside updateStatus(), before the dot logic under test) takes its
    // "already have shots" no-banner path -- the banner itself (which calls
    // document.createElement, unsupported by this minimal fake document) is
    // out of scope here; only the status dot is under test.
    S.shots = [{ id: 1 }];

    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = _realFetch;
  });

  function mockStatusResponse(body) {
    globalThis.fetch = vi.fn((url) => {
      fetchCalls.push(String(url));
      if (String(url).startsWith('api/status')) {
        return Promise.resolve({ ok: true, json: async () => body });
      }
      return Promise.resolve({ ok: false }); // api/switch
    });
  }

  it('shows the error dot when machineReachable is false, even with a fresh lastSync and no lastSyncError -- the exact reported symptom', async () => {
    mockStatusResponse({
      lastSync: new Date().toISOString(), // looks fresh/healthy in isolation
      lastSyncError: null,                // no sync error reported either
      machineReachable: false,            // but the machine itself is off/unreachable
      machineHostname: 'gaggiuino.local',
    });

    await updateStatus();

    expect(doc.getElementById('statusDot').className).toBe('status-dot error');
    expect(doc.getElementById('railStatusDot').className).toBe('status-dot error');
  });

  it('stays green when machineReachable is true and there is no sync error, even if lastSync is old (unrelated to reachability)', async () => {
    mockStatusResponse({
      lastSync: '2020-01-01T00:00:00.000Z',
      lastSyncError: null,
      machineReachable: true,
      machineHostname: 'gaggiuino.local',
    });

    await updateStatus();

    expect(doc.getElementById('statusDot').className).toBe('status-dot ok');
  });

  it('still shows error when machineReachable is true but lastSyncError is set (sync can fail for other reasons)', async () => {
    mockStatusResponse({
      lastSync: new Date().toISOString(),
      lastSyncError: 'HTTP 500',
      machineReachable: true,
      machineHostname: 'gaggiuino.local',
    });

    await updateStatus();

    expect(doc.getElementById('statusDot').className).toBe('status-dot error');
  });

  it('falls back to the pre-existing unknown/ok logic when machineReachable is null (never checked yet)', async () => {
    mockStatusResponse({
      lastSync: null,
      lastSyncError: null,
      machineReachable: null,
      machineHostname: 'gaggiuino.local',
    });

    await updateStatus();

    expect(doc.getElementById('statusDot').className).toBe('status-dot unknown');
  });
});

// ── 2. GET /api/live/data (backend) ─────────────────────────────────────

describe('GET /api/live/data exposes machineReachable (#655)', () => {
  const express = require('express');
  const systemPath = require.resolve('../routes/system');
  const state = require('../lib/state');
  let server, baseUrl;

  afterEach(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  it('reports machineReachable:false in the live/data payload instead of looking identical to an idle-but-reachable machine', async () => {
    state.machineReachable = false;
    state.liveAccum = null; // exactly what an idle-but-reachable machine also looks like

    delete require.cache[systemPath];
    const systemRouter = require('../routes/system');
    const app = express();
    app.use(systemRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const r = await fetch(`${baseUrl}/api/live/data`);
    const body = await r.json();

    expect(body.isLive).toBe(false);
    expect(body.machineReachable).toBe(false);
  });

  it('reports machineReachable:true when the machine is genuinely reachable and idle', async () => {
    state.machineReachable = true;
    state.liveAccum = null;

    delete require.cache[systemPath];
    const systemRouter = require('../routes/system');
    const app = express();
    app.use(systemRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const r = await fetch(`${baseUrl}/api/live/data`);
    const body = await r.json();

    expect(body.machineReachable).toBe(true);
  });
});

// ── 3. lib/poll.js checkAndApplyMachinePower() ──────────────────────────

describe('checkAndApplyMachinePower() flips machineReachable false on the on->off transition (#655)', () => {
  const dbPath = require.resolve('../lib/db');
  const Database = require('better-sqlite3');
  const realDb = require(dbPath);
  const registryPath = require.resolve('../lib/machines/registry');
  const pollPath = require.resolve('../lib/poll');
  // #736: lib/poll.js's stopLivePolling()/startLivePolling() now call
  // lib/preheat.js's buildPreheatResponse(), which resolves the default
  // machine via lib/machines/registry.js -- if lib/preheat.js was already
  // require()d earlier in this file (describe block 2 above pulls it in
  // transitively via routes/system.js, before any DB mock exists), its own
  // module-scoped `registry` binding stays pinned to that stale,
  // real-DB-backed registry module forever, even after registryPath's cache
  // entry is later replaced here -- must be dropped and re-required fresh
  // in lockstep with registryPath/pollPath below.
  const preheatPath = require.resolve('../lib/preheat');
  const haPath = require.resolve('../lib/ha');
  const state = require('../lib/state');
  let memDb, realHa;

  beforeEach(() => {
    memDb = new Database(':memory:');
    realDb.initSchema(memDb);
    require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };
    delete require.cache[registryPath];
    delete require.cache[preheatPath];
    delete require.cache[pollPath];

    const registry = require('../lib/machines/registry');
    registry.ensureDefaultMachine();
    registry.updateMachine(1, { switchEntity: 'switch.machine' });

    realHa = require(haPath);
  });

  afterEach(() => {
    memDb.close();
    require.cache[dbPath].exports = realDb;
    require.cache[haPath].exports = realHa;
    state.machineReachable = null;
  });

  it('sets state.machineReachable = false the moment the switch entity reports the machine off, without waiting for any timeout', async () => {
    // Simulate "was on and reachable" -- exactly the frozen-true scenario
    // from the bug report (machine was fine, then switched off).
    state.machineReachable = true;

    require.cache[haPath].exports = { ...realHa, getSwitchState: vi.fn().mockResolvedValue(false), HA_TOKEN: 'test-token' };
    delete require.cache[pollPath];
    const { checkAndApplyMachinePower } = require('../lib/poll');
    const { MachineRuntimeState } = require('../lib/machine-runtime-state');
    const runtime = new MachineRuntimeState();
    runtime.machineOn = true; // was on

    await checkAndApplyMachinePower(runtime);

    expect(runtime.machineOn).toBe(false);
    expect(state.machineReachable).toBe(false);
  });

  it('does not touch machineReachable when the switch state has not changed (no redundant flip on every 30s check)', async () => {
    state.machineReachable = true;

    require.cache[haPath].exports = { ...realHa, getSwitchState: vi.fn().mockResolvedValue(true), HA_TOKEN: 'test-token' };
    delete require.cache[pollPath];
    const { checkAndApplyMachinePower } = require('../lib/poll');
    const { MachineRuntimeState } = require('../lib/machine-runtime-state');
    const runtime = new MachineRuntimeState();
    runtime.machineOn = true; // already on, no transition

    await checkAndApplyMachinePower(runtime);

    expect(state.machineReachable).toBe(true);
  });
});

// ── 3b. lib/poll.js post-power-on sync retry (#663) ─────────────────────

describe('checkAndApplyMachinePower() retries the post-power-on sync a few times if the machine is still booting (#663)', () => {
  const dbPath = require.resolve('../lib/db');
  const Database = require('better-sqlite3');
  const realDb = require(dbPath);
  const registryPath = require.resolve('../lib/machines/registry');
  const pollPath = require.resolve('../lib/poll');
  // #736: same stale-registry-reference reasoning as describe block 3 above
  // -- startLivePolling() now also calls buildPreheatResponse().
  const preheatPath = require.resolve('../lib/preheat');
  const haPath = require.resolve('../lib/ha');
  const syncPath = require.resolve('../lib/sync');
  const realSync = require(syncPath);
  const state = require('../lib/state');
  let memDb, realHa;

  beforeEach(() => {
    vi.useFakeTimers();
    memDb = new Database(':memory:');
    realDb.initSchema(memDb);
    require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };
    delete require.cache[registryPath];
    delete require.cache[preheatPath];
    delete require.cache[pollPath];

    const registry = require('../lib/machines/registry');
    registry.ensureDefaultMachine();
    registry.updateMachine(1, { switchEntity: 'switch.machine' });

    realHa = require(haPath);
  });

  afterEach(() => {
    vi.useRealTimers();
    memDb.close();
    require.cache[dbPath].exports = realDb;
    require.cache[haPath].exports = realHa;
    require.cache[syncPath].exports = realSync;
    state.machineReachable = null;
  });

  it('retries a few times a short interval apart when the first post-on attempt fails, instead of waiting for the regular sync schedule', async () => {
    const syncShots = vi.fn()
      .mockResolvedValueOnce(false)  // machine still booting its HTTP API
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);  // now up
    require.cache[syncPath].exports = { ...realSync, syncShots };

    require.cache[haPath].exports = { ...realHa, getSwitchState: vi.fn().mockResolvedValue(true), HA_TOKEN: 'test-token' };
    delete require.cache[pollPath];
    const { checkAndApplyMachinePower } = require('../lib/poll');
    const { MachineRuntimeState } = require('../lib/machine-runtime-state');
    const runtime = new MachineRuntimeState();
    runtime.machineOn = false; // off -> on transition

    await checkAndApplyMachinePower(runtime);
    expect(syncShots).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(syncShots).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10000);
    expect(syncShots).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10000);
    expect(syncShots).toHaveBeenCalledTimes(3);

    // Succeeded on the 3rd attempt -- no further retry even after another window.
    await vi.advanceTimersByTimeAsync(10000);
    expect(syncShots).toHaveBeenCalledTimes(3);
  });

  it('gives up after a bounded number of attempts if the machine never comes back up', async () => {
    const syncShots = vi.fn().mockResolvedValue(false);
    require.cache[syncPath].exports = { ...realSync, syncShots };

    require.cache[haPath].exports = { ...realHa, getSwitchState: vi.fn().mockResolvedValue(true), HA_TOKEN: 'test-token' };
    delete require.cache[pollPath];
    const { checkAndApplyMachinePower } = require('../lib/poll');
    const { MachineRuntimeState } = require('../lib/machine-runtime-state');
    const runtime = new MachineRuntimeState();
    runtime.machineOn = false;

    await checkAndApplyMachinePower(runtime);
    await vi.advanceTimersByTimeAsync(2000 + 10000 * 3 + 10000);

    expect(syncShots).toHaveBeenCalledTimes(4);
  });
});

// ── 4. lib/sync.js syncShots() early-return (documented, not "fixed") ───

describe('syncShots() switch-off early return leaves lastSyncTime/lastSyncError untouched (#655, by design)', () => {
  const dbPath = require.resolve('../lib/db');
  const Database = require('better-sqlite3');
  const realDb = require(dbPath);
  const registryPath = require.resolve('../lib/machines/registry');
  const syncPath = require.resolve('../lib/sync');
  const state = require('../lib/state');
  let memDb;

  beforeEach(() => {
    memDb = new Database(':memory:');
    realDb.initSchema(memDb);
    require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };
    delete require.cache[registryPath];
    delete require.cache[syncPath];

    const registry = require('../lib/machines/registry');
    registry.ensureDefaultMachine();
    registry.updateMachine(1, { switchEntity: 'switch.machine' });

    state.lastSyncTime = '2020-01-01T00:00:00.000Z';
    state.lastSyncError = null;
  });

  afterEach(() => {
    memDb.close();
    require.cache[dbPath].exports = realDb;
  });

  it('returns true early without updating lastSyncTime/lastSyncError or making a network call when the machine is off', async () => {
    const { syncShots } = require('../lib/sync');
    const ok = await syncShots({ machineOn: false });

    expect(ok).toBe(true);
    expect(state.lastSyncTime).toBe('2020-01-01T00:00:00.000Z'); // unchanged, not bumped to "now"
    expect(state.lastSyncError).toBeNull();
  });
});
