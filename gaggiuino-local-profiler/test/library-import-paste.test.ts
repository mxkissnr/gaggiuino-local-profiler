import { describe, it, expect, beforeEach, vi } from 'vitest';

// import.ts's module graph (state, i18n, api) reads localStorage/navigator at
// load (the other library tests' pattern), so stub the browser globals before
// importing it below.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };

// Both import endpoints are mocked: the tests assert the exact URL/text a
// paste sends and never touch a network.
const api = vi.hoisted(() => ({
  importFromUrl: vi.fn<(url: string) => Promise<Response>>(),
  importFromPaste: vi.fn<(url: string, text: string) => Promise<Response>>(),
}));
vi.mock('../public-src/api/system.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/system.js')>();
  return { ...actual, importFromUrl: api.importFromUrl, importFromPaste: api.importFromPaste };
});

// library.ts is huge and only its bean-form helpers are reachable here, so
// stand it in (same as library-scan-manual.test.ts).
const library = vi.hoisted(() => ({
  openBeanForm: vi.fn(),
  setFormOrigins: vi.fn(),
  setFormFlavors: vi.fn(),
}));
vi.mock('../public-src/views/library.js', () => library);

// The elements the import paths read/write. The fake keeps a real innerHTML
// string so the escaping assertions can inspect what would reach the DOM.
class FakeEl {
  id: string;
  style: Record<string, string> = {};
  value = '';
  textContent = '';
  innerHTML = '';
  checked = false;
  disabled = false;
  href = '#';
  radioValue = '0';
  // The paste row's status line; only it is ever queried by class (import.ts).
  msg: FakeEl | null = null;
  private listeners: Array<() => void> = [];

  constructor(id: string) {
    this.id = id;
  }

  focus(): void {}

  insertAdjacentHTML(_position: string, markup: string): void {
    this.innerHTML += markup;
  }

  addEventListener(_type: string, fn: () => void): void {
    this.listeners.push(fn);
  }

  removeEventListener(_type: string, fn: () => void): void {
    this.listeners = this.listeners.filter(entry => entry !== fn);
  }

  dispatchClick(): void {
    for (const fn of [...this.listeners]) fn();
  }

  querySelector(selector: string): { value: string } | FakeEl | null {
    if (selector.includes('input[name="variantPick"]')) return { value: this.radioValue };
    if (selector === '.lib-url-paste-msg') return this.msg;
    return null;
  }
}

let elements: Record<string, FakeEl>;
let importUrlBtn: FakeEl;
let pasteRow: FakeEl;

function el(id: string): FakeEl {
  const found = elements[id];
  if (!found) throw new Error(`element ${id} missing`);
  return found;
}

function resp(status: number, body: unknown, unreadable = false): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => (unreadable ? Promise.reject(new Error('not json')) : Promise.resolve(body)),
  } as unknown as Response;
}

const { importFromUrl, importFromPaste, toggleUrlImport } =
  (await import('../public-src/views/library/import.js')) as unknown as {
    importFromUrl: () => Promise<void>;
    importFromPaste: () => Promise<void>;
    toggleUrlImport: () => void;
  };
const { S } = (await import('../public-src/state/index.js')) as unknown as { S: { currentLang: string } };
const { t } = (await import('../public-src/i18n.js')) as unknown as { t: (key: string) => string };

const alertSpy = vi.fn();

const BLOCKED_URL = 'https://shop.example.com/products/bean';
const DATA_URL = 'https://shop.example.com/products/bean.js';

beforeEach(() => {
  const ids = [
    'urlImportRow', 'urlImportInput', 'urlImportPasteManual', 'urlImportPastePartial',
    'urlImportPasteSteps', 'urlImportPasteLink', 'urlImportPasteText', 'urlImportPasteInvalid',
    'urlImportPasteTooLarge', 'urlImportPasteBtn', 'beanFormImportNotice', 'beanFormDuplicateWarning',
    'beanFormExtraRecipes', 'beanFormName', 'beanFormRoaster', 'beanFormNotes', 'beanFormVariety',
    'beanFormProcess', 'beanFormDecaf', 'beanFormRoastType', 'beanFormRegion', 'beanFormAltitude',
    'beanFormImporter', 'beanFormHarvest', 'beanFormProducer', 'beanFormBrewTemp', 'beanFormBrewRatio',
    'beanFormBrewTime', 'beanFormBrewNotes', 'beanFormPrice', 'variantPickerRow', 'variantPickerList',
    'variantPickerConfirm',
  ];
  elements = {};
  for (const id of ids) elements[id] = new FakeEl(id);
  pasteRow = new FakeEl('urlImportPasteRow');
  pasteRow.msg = new FakeEl('pasteMsg');
  elements['urlImportPasteRow'] = pasteRow;
  importUrlBtn = new FakeEl('importUrlBtn');

  g.document = {
    getElementById: (id: string) => elements[id] ?? null,
    querySelector: (selector: string) => (selector === '#urlImportRow .lib-url-btn' ? importUrlBtn : null),
  };
  g.alert = alertSpy;

  api.importFromUrl.mockReset();
  api.importFromPaste.mockReset();
  alertSpy.mockReset();
  library.openBeanForm.mockReset();
  library.setFormOrigins.mockReset();
  library.setFormFlavors.mockReset();
  S.currentLang = 'en';
  // The paste panel and its source URL are module state: a visible row toggled
  // closed runs _hidePastePanel() and resets both between tests.
  el('urlImportRow').style.display = 'flex';
  toggleUrlImport();
});

describe('shop import: a blocked shop offers the paste path', () => {
  it('shows the message, the product-data link and the paste steps', async () => {
    api.importFromUrl.mockResolvedValue(resp(502, { code: 'shop_rate_limited', productDataUrl: DATA_URL }));
    el('urlImportInput').value = BLOCKED_URL;

    await importFromUrl();

    expect(el('urlImportPasteRow').style.display).toBe('flex');
    expect(el('urlImportPasteSteps').style.display).toBe('flex');
    expect(el('urlImportPasteLink').href).toBe(DATA_URL);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(library.openBeanForm).not.toHaveBeenCalled();
  });

  it('offers manual entry when the shop gave no product-data URL', async () => {
    api.importFromUrl.mockResolvedValue(resp(502, { code: 'shop_rate_limited' }));
    el('urlImportInput').value = BLOCKED_URL;

    await importFromUrl();

    expect(el('urlImportPasteRow').style.display).toBe('flex');
    expect(el('urlImportPasteSteps').style.display).toBe('none');
    expect(el('urlImportPasteManual').style.display).toBe('');
  });

  it('never links a javascript: product-data URL', async () => {
    api.importFromUrl.mockResolvedValue(resp(502, { code: 'shop_rate_limited', productDataUrl: 'javascript:alert(1)' }));
    el('urlImportInput').value = BLOCKED_URL;

    await importFromUrl();

    expect(el('urlImportPasteSteps').style.display).toBe('none');
    expect(el('urlImportPasteLink').href).toBe('#');
    expect(el('urlImportPasteManual').style.display).toBe('');
  });

  it('falls back to the generic error for a 502 with an unreadable body', async () => {
    api.importFromUrl.mockResolvedValue(resp(502, null, true));
    el('urlImportInput').value = BLOCKED_URL;

    await importFromUrl();

    expect(el('urlImportPasteRow').style.display).toBe('none');
    expect(alertSpy).toHaveBeenCalledWith(t('lib_url_error'));
  });

  it('keeps the generic error for a 500', async () => {
    api.importFromUrl.mockResolvedValue(resp(500, {}));
    el('urlImportInput').value = BLOCKED_URL;

    await importFromUrl();

    expect(el('urlImportPasteRow').style.display).toBe('none');
    expect(alertSpy).toHaveBeenCalledWith(t('lib_url_error'));
  });

  it('closes the panel when a new import starts', async () => {
    api.importFromUrl.mockResolvedValue(resp(502, { code: 'shop_rate_limited', productDataUrl: DATA_URL }));
    el('urlImportInput').value = BLOCKED_URL;
    await importFromUrl();
    expect(el('urlImportPasteRow').style.display).toBe('flex');

    api.importFromUrl.mockResolvedValue(resp(500, {}));
    await importFromUrl();

    expect(el('urlImportPasteRow').style.display).toBe('none');
  });

  it('closes the panel when the URL row is hidden again', async () => {
    api.importFromUrl.mockResolvedValue(resp(502, { code: 'shop_rate_limited', productDataUrl: DATA_URL }));
    el('urlImportInput').value = BLOCKED_URL;
    el('urlImportRow').style.display = 'flex';
    await importFromUrl();
    expect(el('urlImportPasteRow').style.display).toBe('flex');

    toggleUrlImport();

    expect(el('urlImportRow').style.display).toBe('none');
    expect(el('urlImportPasteRow').style.display).toBe('none');

    // Re-opened: the closed panel must not offer a paste it no longer links.
    toggleUrlImport();
    await importFromPaste();
    expect(api.importFromPaste).not.toHaveBeenCalled();
  });
});

describe('shop import: a partial import fills the form and keeps the paste path', () => {
  const data = { name: 'Bean', source: 'shop.example.com', importMethod: 'jsonld', productDataUrl: DATA_URL };

  it('fills the form, shows the partial hint and links the product data', async () => {
    api.importFromUrl.mockResolvedValue(resp(200, data));
    el('urlImportInput').value = BLOCKED_URL;
    el('urlImportPasteText').value = '{}';

    await importFromUrl();

    expect(library.openBeanForm).toHaveBeenCalled();
    expect(el('beanFormName').value).toBe('Bean');
    expect(el('beanFormImportNotice').innerHTML).toContain(t('lib_url_shop_blocked_partial'));
    expect(el('urlImportPasteRow').style.display).toBe('flex');
    expect(el('urlImportPasteSteps').style.display).toBe('flex');
    expect(el('urlImportPastePartial').style.display).toBe('');
    expect(pasteRow.msg!.style.display).toBe('none');
  });

  it('sends a later paste with the import\'s URL, not the edited input', async () => {
    api.importFromUrl.mockResolvedValue(resp(200, data));
    api.importFromPaste.mockResolvedValue(resp(200, { name: 'Pasted' }));
    el('urlImportInput').value = BLOCKED_URL;
    await importFromUrl();

    el('urlImportInput').value = 'https://other.example.com/x';
    el('urlImportPasteText').value = '{"title":"x"}';
    await importFromPaste();

    expect(api.importFromPaste).toHaveBeenCalledWith(BLOCKED_URL, '{"title":"x"}');
    expect(el('beanFormName').value).toBe('Pasted');
  });

  it('does not show the panel when the product-data URL is unsafe', async () => {
    api.importFromUrl.mockResolvedValue(resp(200, { ...data, productDataUrl: 'javascript:alert(1)' }));
    el('urlImportInput').value = BLOCKED_URL;

    await importFromUrl();

    expect(library.openBeanForm).toHaveBeenCalled();
    expect(el('beanFormImportNotice').innerHTML).not.toContain(t('lib_url_shop_blocked_partial'));
    expect(el('urlImportPasteRow').style.display).toBe('none');
  });

  it('stays hidden for a normal 200 without product data', async () => {
    api.importFromUrl.mockResolvedValue(resp(200, { name: 'Bean' }));
    el('urlImportInput').value = BLOCKED_URL;

    await importFromUrl();

    expect(el('urlImportPasteRow').style.display).toBe('none');
    expect(library.openBeanForm).toHaveBeenCalled();
  });
});

describe('shop import: pasting product data', () => {
  async function showPanel(): Promise<void> {
    api.importFromUrl.mockResolvedValue(resp(502, { code: 'shop_rate_limited', productDataUrl: DATA_URL }));
    el('urlImportInput').value = BLOCKED_URL;
    await importFromUrl();
  }

  it('parses the paste and fills the form like a fetch', async () => {
    await showPanel();
    api.importFromPaste.mockResolvedValue(resp(200, { name: 'Pasted', price_eur: 12.5 }));
    el('urlImportPasteText').value = '{"title":"Pasted"}';

    await importFromPaste();

    expect(api.importFromPaste).toHaveBeenCalledWith(BLOCKED_URL, '{"title":"Pasted"}');
    expect(library.openBeanForm).toHaveBeenCalled();
    expect(el('beanFormName').value).toBe('Pasted');
    expect(el('urlImportPasteRow').style.display).toBe('none');
    expect(el('urlImportPasteText').value).toBe('');
  });

  it('opens the variant picker and fills the form after confirm', async () => {
    await showPanel();
    api.importFromPaste.mockResolvedValue(resp(200, {
      name: 'Pasted',
      variants: [{ title: '250 g', price: 1000 }, { title: '1 kg', price: 3200 }],
    }));
    el('urlImportPasteText').value = '{}';
    el('variantPickerList').radioValue = '1';

    await importFromPaste();

    expect(el('variantPickerRow').style.display).toBe('');
    expect(library.openBeanForm).not.toHaveBeenCalled();

    el('variantPickerConfirm').dispatchClick();

    expect(library.openBeanForm).toHaveBeenCalled();
    expect(el('beanFormPrice').value).toBe('32.00');
  });

  it('shows the invalid error for a 400 and keeps the text', async () => {
    await showPanel();
    api.importFromPaste.mockResolvedValue(resp(400, { error: 'invalid product data' }));
    el('urlImportPasteText').value = 'not product data';

    await importFromPaste();

    expect(el('urlImportPasteInvalid').style.display).toBe('');
    expect(library.openBeanForm).not.toHaveBeenCalled();
    expect(el('urlImportPasteText').value).toBe('not product data');
  });

  it('shows the too-large error for a 413', async () => {
    await showPanel();
    api.importFromPaste.mockResolvedValue(resp(413, { error: 'too large' }));
    el('urlImportPasteText').value = 'x';

    await importFromPaste();

    expect(el('urlImportPasteTooLarge').style.display).toBe('');
    expect(library.openBeanForm).not.toHaveBeenCalled();
  });

  it('uses the generic error for any other failure', async () => {
    await showPanel();
    api.importFromPaste.mockResolvedValue(resp(500, {}));
    el('urlImportPasteText').value = '{}';

    await importFromPaste();

    expect(alertSpy).toHaveBeenCalledWith(t('lib_url_error'));
    expect(library.openBeanForm).not.toHaveBeenCalled();
  });

  it('escapes pasted markup in the name, the duplicate warning and a variant title', async () => {
    await showPanel();
    api.importFromPaste.mockResolvedValue(resp(200, {
      name: '<img src=x onerror=alert(1)>',
      duplicateWarning: { name: '<img src=x>' },
      variants: [{ title: '<img src=x>', price: 1000 }, { title: '1 kg', price: 2000 }],
    }));
    el('urlImportPasteText').value = '{}';

    await importFromPaste();
    // Two variants: the form (and the duplicate warning) only fills on confirm.
    el('variantPickerConfirm').dispatchClick();

    expect(el('beanFormName').value).toBe('<img src=x onerror=alert(1)>');
    expect(el('beanFormDuplicateWarning').innerHTML).toContain('&lt;img');
    expect(el('variantPickerList').innerHTML).toContain('&lt;img');
    expect(el('beanFormDuplicateWarning').innerHTML).not.toContain('<img');
    expect(el('variantPickerList').innerHTML).not.toContain('<img');
  });

  it('does nothing when no shop is blocked', async () => {
    el('urlImportPasteText').value = '{}';

    await importFromPaste();

    expect(api.importFromPaste).not.toHaveBeenCalled();
  });
});
