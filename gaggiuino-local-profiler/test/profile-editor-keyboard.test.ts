// #2198: both profile editors take the shared dialog keyboard from
// dialog-a11y (#1619) — Escape closes them through the same function as the
// header close button, Tab stays inside, and closing returns focus to the
// opener. The helper itself is covered by the confirm dialog tests; here only
// the wiring of each editor is checked, so the helper module is mocked.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const dlg = vi.hoisted(() => {
  const release = vi.fn();
  const attachDialogKeyboard = vi.fn(() => ({ release }));
  return { release, attachDialogKeyboard };
});
vi.mock('../public-src/components/dialog-a11y.js', () => ({
  attachDialogKeyboard: dlg.attachDialogKeyboard,
  focusablesWithin: vi.fn(() => []),
  trapTabKey: vi.fn(),
}));

const { openProfileForm, closeProfileForm } = await import('../public-src/views/library-profile-editor.js');
const { openNewGaggiMateProfile, closeGaggiMateEditor } = await import('../public-src/views/gaggimate-profile-editor.js');

interface FakeEl {
  innerHTML: string;
  textContent: string;
  value: string;
  style: Record<string, string>;
  classList: { add(): void; remove(): void };
  addEventListener(): void;
  focus(): void;
}

// Every id resolves to a fake element; #profilePreviewChart and #gmProfileChart
// stay absent so both Chart.js branches bail before touching a canvas.
function installDocument(): Record<string, FakeEl> {
  const els: Record<string, FakeEl> = {};
  const getElementById = (id: string): FakeEl | undefined => {
    if (id === 'profilePreviewChart' || id === 'gmProfileChart') return undefined;
    return (els[id] ??= {
      innerHTML: '', textContent: '', value: '', style: {},
      classList: { add() {}, remove() {} }, addEventListener() {}, focus() {},
    });
  };
  g.document = { getElementById, querySelectorAll: () => [] };
  return els;
}

// Module-level keyboard handles outlive a test, so close both editors before
// resetting the mocks: each close releases its handle and clears it.
function resetEditorState(): void {
  installDocument();
  closeProfileForm();
  closeGaggiMateEditor();
  dlg.attachDialogKeyboard.mockClear();
  dlg.release.mockClear();
}

function lastEscapeHandler(): () => void {
  const calls = dlg.attachDialogKeyboard.mock.calls;
  const args = calls[calls.length - 1] as unknown as [HTMLElement, () => void];
  return args[1];
}

describe('Gaggiuino profile editor keyboard (#2198)', () => {
  beforeEach(resetEditorState);

  it('openProfileForm attaches the shared dialog keyboard to the Gaggiuino editor', () => {
    const els = installDocument();
    openProfileForm();

    expect(dlg.attachDialogKeyboard).toHaveBeenCalledTimes(1);
    const [host, onEscape, opts] = dlg.attachDialogKeyboard.mock.calls[0] as unknown as [
      HTMLElement, () => void, { initialFocus?: HTMLElement | null },
    ];
    expect(host).toBe(els.profileEditorModal);
    expect(onEscape).toBe(closeProfileForm);
    expect(opts.initialFocus).toBe(els.closeProfileFormBtn);
  });

  it('Escape in the Gaggiuino editor runs closeProfileForm and releases the keyboard', () => {
    const els = installDocument();
    openProfileForm();

    lastEscapeHandler()();

    expect(els.profileEditorModal?.style.display).toBe('none');
    expect(dlg.release).toHaveBeenCalledTimes(1);
  });

  it('opening the Gaggiuino editor twice releases the first handle', () => {
    installDocument();
    openProfileForm();
    expect(dlg.release).not.toHaveBeenCalled();

    openProfileForm();
    expect(dlg.attachDialogKeyboard).toHaveBeenCalledTimes(2);
    expect(dlg.release).toHaveBeenCalledTimes(1);
  });
});

describe('GaggiMate profile editor keyboard (#2198)', () => {
  beforeEach(resetEditorState);

  it('the GaggiMate editor attaches the shared dialog keyboard on open', () => {
    const els = installDocument();
    openNewGaggiMateProfile();

    expect(dlg.attachDialogKeyboard).toHaveBeenCalledTimes(1);
    const [host, onEscape] = dlg.attachDialogKeyboard.mock.calls[0] as unknown as [
      HTMLElement, () => void,
    ];
    expect(host).toBe(els.gmProfileEditorModal);
    expect(onEscape).toBe(closeGaggiMateEditor);
  });

  it('Escape in the GaggiMate editor closes it and releases the keyboard', () => {
    const els = installDocument();
    openNewGaggiMateProfile();

    lastEscapeHandler()();

    expect(els.gmProfileEditorModal?.style.display).toBe('none');
    expect(dlg.release).toHaveBeenCalledTimes(1);
  });
});
