// #1962 slice 14: editing an existing entry saves on commit (change), creating
// still needs the save button. The node test env has no DOM, so these fakes
// stand in for the handful of form/status methods the helper touches.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bindFormAutosave } from '../public-src/components/form-autosave.js';

class FakeStatus {
  className = '';
  innerHTML = '';
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();

  classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !this.classes.has(c);
      if (on) this.classes.add(c); else this.classes.delete(c);
      return on;
    },
    contains: (c: string) => this.classes.has(c),
  };

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
}

class FakeActions {
  readonly appended: FakeStatus[] = [];

  appendChild(el: FakeStatus): void { this.appended.push(el); }
}

interface FakeForm {
  readonly listeners: Array<(e: unknown) => void>;
  readonly actions: FakeActions;
  commit: (target: unknown) => void;
}

function makeForm(hasActions = true): FakeForm {
  const actions = new FakeActions();
  const listeners: Array<(e: unknown) => void> = [];
  return {
    listeners,
    actions,
    querySelector: (sel: string) => (hasActions && sel === '.lib-form-actions' ? actions : null),
    addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'change') listeners.push(fn); },
    commit: (target: unknown) => { for (const fn of [...listeners]) fn({ target }); },
  } as unknown as FakeForm;
}

const g = globalThis as unknown as Record<string, unknown>;
const INPUT = { type: 'text' };

const created: FakeStatus[] = [];

beforeEach(() => {
  created.length = 0;
  g.document = {
    createElement: () => {
      const status = new FakeStatus();
      created.push(status);
      return status;
    },
  };
});

function bind(form: FakeForm, editing: boolean, save: () => Promise<boolean>): () => void {
  return bindFormAutosave(form as unknown as HTMLElement, { isEditing: () => editing, save });
}

function createdStatuses(): FakeStatus[] {
  return created;
}

describe('bindFormAutosave (#1962)', () => {
  it('mounts one status element at the end of the form actions', () => {
    const form = makeForm();
    bind(form, true, () => Promise.resolve(true));

    const statuses = createdStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.className).toBe('autosave-status');
    expect(statuses[0]?.attributes.get('role')).toBe('status');
    expect(form.actions.appended).toHaveLength(1);
    expect(form.actions.appended[0]).toBe(statuses[0]);
  });

  it('does nothing for a form without an actions row', () => {
    const form = makeForm(false);
    bind(form, true, () => Promise.resolve(true));

    expect(createdStatuses()).toHaveLength(0);
  });

  it('does not save while creating', () => {
    const save = vi.fn(() => Promise.resolve(true));
    const form = makeForm();
    bind(form, false, save);

    form.commit(INPUT);

    expect(save).not.toHaveBeenCalled();
  });

  it('saves once on change and shows pending then saved', async () => {
    let finish: (ok: boolean) => void = () => {};
    const save = vi.fn(() => new Promise<boolean>(r => { finish = r; }));
    const form = makeForm();
    bind(form, true, save);

    form.commit(INPUT);
    expect(save).toHaveBeenCalledTimes(1);
    const status = createdStatuses()[0];
    expect(status?.innerHTML).toBe('Saving…');

    finish(true);
    await vi.waitFor(() => expect(status?.innerHTML).toContain('Saved'));
  });

  it('keeps a "Not saved" state when the save fails', async () => {
    const form = makeForm();
    bind(form, true, () => Promise.resolve(false));

    form.commit(INPUT);
    await vi.waitFor(() => expect(createdStatuses()[0]?.innerHTML).toBe('Not saved'));
    const status = createdStatuses()[0];
    expect(status?.classes.has('visible')).toBe(true);
    expect(status?.classes.has('failed')).toBe(true);
  });

  it('the saved state does not fade', async () => {
    vi.useFakeTimers();
    try {
      const form = makeForm();
      bind(form, true, () => Promise.resolve(true));

      form.commit(INPUT);
      await vi.advanceTimersByTimeAsync(0);
      const status = createdStatuses()[0];
      expect(status?.innerHTML).toContain('Saved');
      expect(status?.classes.has('visible')).toBe(true);

      await vi.advanceTimersByTimeAsync(5000);
      expect(status?.innerHTML).toContain('Saved');
      expect(status?.classes.has('visible')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a save that throws shows Not saved', async () => {
    const form = makeForm();
    bind(form, true, () => Promise.reject(new Error('offline')));

    form.commit(INPUT);
    await vi.waitFor(() => expect(createdStatuses()[0]?.innerHTML).toBe('Not saved'));
    const status = createdStatuses()[0];
    expect(status?.classes.has('failed')).toBe(true);
    expect(status?.classes.has('visible')).toBe(true);
  });

  it('a later successful save drops the failed state', async () => {
    let ok = false;
    const form = makeForm();
    bind(form, true, () => Promise.resolve(ok));

    form.commit(INPUT);
    await vi.waitFor(() => expect(createdStatuses()[0]?.classes.has('failed')).toBe(true));

    ok = true;
    form.commit(INPUT);
    const status = createdStatuses()[0];
    await vi.waitFor(() => expect(status?.innerHTML).toContain('Saved'));
    expect(status?.classes.has('failed')).toBe(false);
    expect(status?.classes.has('visible')).toBe(true);
  });

  it('reset clears the state', async () => {
    const form = makeForm();
    const reset = bind(form, true, () => Promise.resolve(true));

    form.commit(INPUT);
    const status = createdStatuses()[0];
    await vi.waitFor(() => expect(status?.innerHTML).toContain('Saved'));

    reset();
    expect(status?.innerHTML).toBe('');
    expect(status?.classes.has('visible')).toBe(false);
    expect(status?.classes.has('failed')).toBe(false);
  });

  it('a save still running at reset does not label the next entry', async () => {
    let finish: (ok: boolean) => void = () => {};
    const form = makeForm();
    const reset = bind(form, true, () => new Promise<boolean>(r => { finish = r; }));

    form.commit(INPUT);
    reset();
    finish(true);
    await vi.waitFor(() => expect(createdStatuses()[0]?.innerHTML).toBe(''));
    expect(createdStatuses()[0]?.classes.has('visible')).toBe(false);
  });

  it('a form without an actions row returns a callable no-op', () => {
    const form = makeForm(false);
    const reset = bind(form, true, () => Promise.resolve(true));

    expect(typeof reset).toBe('function');
    expect(() => reset()).not.toThrow();
  });

  it('collapses changes during a running save into exactly one more save', async () => {
    const resolvers: Array<(ok: boolean) => void> = [];
    const save = vi.fn(() => new Promise<boolean>(r => { resolvers.push(r); }));
    const form = makeForm();
    bind(form, true, save);

    form.commit(INPUT);
    form.commit(INPUT);
    form.commit(INPUT);
    expect(save).toHaveBeenCalledTimes(1);

    resolvers[0]?.(true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));

    resolvers[1]?.(true);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('ignores a picked file', () => {
    const save = vi.fn(() => Promise.resolve(true));
    const form = makeForm();
    bind(form, true, save);

    form.commit({ type: 'file' });

    expect(save).not.toHaveBeenCalled();
  });
});
