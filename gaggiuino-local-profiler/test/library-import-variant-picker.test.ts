import { describe, it, expect, vi } from 'vitest';

// import.ts's module graph (state, i18n, api) reads localStorage/navigator at
// load (the library tests' pattern); library.ts is huge and untouched by the
// picker, so stand it in (same as library-scan-manual.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

vi.mock('../public-src/views/library.js', () => ({ openBeanForm: vi.fn() }));

interface Variant {
  title?: string;
  price: number;
}

// The picker only reads #variantPickerRow / #variantPickerList /
// #variantPickerConfirm and, on confirm, the checked radio through list.
// querySelector. Click tracking is what the assertions need, so the fake keeps
// a real listener list.
class FakeEl {
  innerHTML = '';
  style: Record<string, string> = {};
  radioValue = '0';
  private listeners: Array<() => void> = [];

  addEventListener(_type: string, fn: () => void): void {
    this.listeners.push(fn);
  }

  removeEventListener(_type: string, fn: () => void): void {
    this.listeners = this.listeners.filter(entry => entry !== fn);
  }

  dispatchClick(): void {
    for (const fn of [...this.listeners]) fn();
  }

  querySelector(selector: string): { value: string } | null {
    return selector.includes('input[name="variantPick"]') ? { value: this.radioValue } : null;
  }
}

const { openVariantPicker } = await import('../public-src/views/library/import.js');

const VARIANTS: Variant[] = [
  { title: '250 g', price: 1000 },
  { title: '1 kg', price: 3200 },
];

describe('variant picker (#1614 slice 4)', () => {
  it('fires onPick once after the picker is re-opened without confirming', () => {
    const row = new FakeEl();
    const list = new FakeEl();
    const confirm = new FakeEl();
    list.radioValue = '1'; // the second variant is selected
    const elements: Record<string, FakeEl> = {
      variantPickerRow: row,
      variantPickerList: list,
      variantPickerConfirm: confirm,
    };
    g.document = { getElementById: (id: string) => elements[id] ?? null };

    const onPick = vi.fn();
    openVariantPicker(VARIANTS, onPick);
    openVariantPicker(VARIANTS, onPick); // re-opened before the first confirm
    confirm.dispatchClick();

    // Without removing the previous handler the single click would fire onPick
    // once per open.
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(VARIANTS[1]);
    expect(row.style.display).toBe('none');
  });
});
