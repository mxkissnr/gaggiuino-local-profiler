// #1962 slice 14: editing an existing entry saves on commit (change), creating
// still needs the save button. The node test env has no DOM, so these fakes
// stand in for the handful of form/status methods the helper touches.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bindFormAutosave } from '../public-src/components/form-autosave.js';

class FakeStatus {
  className = '';
  textContent = '';
  readonly classes = new Set<string>();

  classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
  };
}

class FakeActions {
  readonly prepended: FakeStatus[] = [];

  prepend(el: FakeStatus): void { this.prepended.push(el); }
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

function bind(form: FakeForm, editing: boolean, save: () => Promise<boolean>): void {
  bindFormAutosave(form as unknown as HTMLElement, { isEditing: () => editing, save });
}

function createdStatuses(): FakeStatus[] {
  return created;
}

describe('bindFormAutosave (#1962)', () => {
  it('mounts one status element into the form actions', () => {
    const form = makeForm();
    bind(form, true, () => Promise.resolve(true));

    const statuses = createdStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.className).toBe('autosave-status');
    expect(form.actions.prepended).toHaveLength(1);
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
    expect(status?.textContent).toBe('Saving…');

    finish(true);
    await vi.waitFor(() => expect(status?.textContent).toBe('Saved'));
  });

  it('clears the status when the save fails', async () => {
    const form = makeForm();
    bind(form, true, () => Promise.resolve(false));

    form.commit(INPUT);
    await vi.waitFor(() => expect(createdStatuses()[0]?.textContent).toBe(''));
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
