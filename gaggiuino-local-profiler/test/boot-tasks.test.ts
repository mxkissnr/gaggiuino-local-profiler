import { describe, it, expect, vi, afterEach } from 'vitest';
import { runBootTasks } from '../public-src/boot/run-step.js';

// #1615: the data boot chain used to be one promise chain, so a rejection
// anywhere silently skipped everything after it. runBootTasks() runs it as
// tasks with explicit dependencies: a failed prerequisite skips (and logs)
// only the tasks that need it, independent branches still run, and
// ordering-only (`after`) edges keep the old sequence without making a task
// depend on its predecessor succeeding.

afterEach(() => { vi.restoreAllMocks(); });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('runBootTasks (#1615)', () => {
  it('skips the dependents of a failed step but still runs the independent branches', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ran: string[] = [];
    const step = (name: string, fail = false) => () => {
      ran.push(name);
      if (fail) return Promise.reject(new Error(`${name} broke`));
      return Promise.resolve();
    };
    // Same shape as boot/data.ts: settings -> library -> shots is one chain;
    // machines and ui prefs are independent; status only orders itself after
    // the shots chain and the setup wizard needs status + machines.
    const outcomes = await runBootTasks([
      { name: 'token', run: step('token') },
      { name: 'machines', requires: ['token'], run: step('machines') },
      { name: 'ui prefs', requires: ['token'], run: step('ui prefs') },
      { name: 'settings', requires: ['token'], run: step('settings', true) },
      { name: 'library', requires: ['settings'], run: step('library') },
      { name: 'shots', requires: ['library'], run: step('shots') },
      { name: 'machine list', requires: ['machines'], after: ['shots'], run: step('machine list') },
      { name: 'status', requires: ['token'], after: ['shots', 'machines'], run: step('status') },
      { name: 'setup wizard', requires: ['status', 'machines'], run: step('setup wizard') },
    ]);

    expect(Object.fromEntries(outcomes)).toEqual({
      token: 'ok', machines: 'ok', 'ui prefs': 'ok', settings: 'failed',
      library: 'skipped', shots: 'skipped',
      'machine list': 'ok', status: 'ok', 'setup wizard': 'ok',
    });
    expect(ran).not.toContain('library');
    expect(ran).not.toContain('shots');
    expect(ran).toEqual(expect.arrayContaining(['machines', 'ui prefs', 'machine list', 'status', 'setup wizard']));
    expect(errorSpy).toHaveBeenCalledWith('[GLP] boot step "settings" failed:', expect.any(Error));
    expect(errorSpy).toHaveBeenCalledWith('[GLP] boot step "library" skipped: "settings" did not complete');
    expect(errorSpy).toHaveBeenCalledWith('[GLP] boot step "shots" skipped: "library" did not complete');
  });

  it('a synchronous throw counts as a failure too, and skips the task\'s dependents', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcomes = await runBootTasks([
      { name: 'a', run: () => { throw new TypeError('x is not a function'); } },
      { name: 'b', requires: ['a'], run: () => {} },
      { name: 'c', after: ['a'], run: () => {} },
    ]);
    expect(Object.fromEntries(outcomes)).toEqual({ a: 'failed', b: 'skipped', c: 'ok' });
  });

  it('keeps the old order: a dependent starts only once its dependencies have settled', async () => {
    const order: string[] = [];
    const token = deferred();
    const settings = deferred();
    const run = runBootTasks([
      { name: 'token', run: () => { order.push('token start'); return token.promise; } },
      { name: 'machines', requires: ['token'], run: () => { order.push('machines'); } },
      { name: 'settings', requires: ['token'], run: () => { order.push('settings start'); return settings.promise; } },
      { name: 'library', requires: ['settings'], run: () => { order.push('library'); } },
      { name: 'status', after: ['library', 'machines'], run: () => { order.push('status'); } },
    ]);
    // A task without dependencies starts synchronously.
    expect(order).toEqual(['token start']);
    await Promise.resolve();
    expect(order).toEqual(['token start']);

    token.resolve();
    await vi.waitFor(() => expect(order).toContain('settings start'));
    // Siblings waiting on the same dependency start in declaration order.
    expect(order).toEqual(['token start', 'machines', 'settings start']);

    settings.resolve();
    await run;
    expect(order).toEqual(['token start', 'machines', 'settings start', 'library', 'status']);
  });

  it('rejects a dependency on a task that is not declared before it', async () => {
    await expect(runBootTasks([
      { name: 'a', requires: ['b'], run: () => {} },
      { name: 'b', run: () => {} },
    ])).rejects.toThrow('boot task "a" depends on "b", which is not declared before it');
  });
});
