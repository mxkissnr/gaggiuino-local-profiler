import { describe, it, expect, beforeEach, vi } from 'vitest';

// views/library.js's import chain (bags.js -> views/library.js -> state/i18n)
// reads localStorage/navigator at module load time — stub the browser globals
// so the module graph can be imported under vitest's node environment (same
// pattern as test/library-shelf-classify.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };

// The sticker modules are the heavy on-device machinery: mock both before the
// dynamic imports in the view resolve, so no onnxruntime code is ever loaded.
const mocks = vi.hoisted(() => ({
  openStickerEditor: vi.fn(),
  isStickerCutoutAvailable: vi.fn(),
  uploadBeanImage: vi.fn(),
  saveBean: vi.fn(),
  invalidateBeanImage: vi.fn(),
  apiFetch: vi.fn(),
  crop: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../public-src/components/sticker/editor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/components/sticker/editor.js')>();
  return { ...actual, openStickerEditor: mocks.openStickerEditor };
});
vi.mock('../public-src/components/sticker/segment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/components/sticker/segment.js')>();
  return { ...actual, isStickerCutoutAvailable: mocks.isStickerCutoutAvailable };
});
vi.mock('../public-src/api/library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/library.js')>();
  return { ...actual, uploadBeanImage: mocks.uploadBeanImage, saveBean: mocks.saveBean };
});
vi.mock('../public-src/bean-image.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/bean-image.js')>();
  return { ...actual, invalidateBeanImage: mocks.invalidateBeanImage };
});
vi.mock('../public-src/api/transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/transport.js')>();
  return { ...actual, apiFetch: mocks.apiFetch };
});
vi.mock('../public-src/components/image-crop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/components/image-crop.js')>();
  return { ...actual, openImageCropEditor: mocks.crop };
});

interface LibraryModule {
  updateStickerButton: () => Promise<void>;
  cutOutBeanSticker: () => Promise<void>;
  stageNewBeanImage: (input: HTMLInputElement) => Promise<void>;
  saveBeanNoBag: () => Promise<void>;
  closeBeanForm: () => void;
}
interface ShelfModule {
  renderShelfTile: (b: unknown, opts: { muted: boolean; expanded?: boolean }) => string;
}

const library = (await import('../public-src/views/library.js')) as unknown as LibraryModule;
const { renderShelfTile } = (await import('../public-src/views/library/shelf.js')) as unknown as ShelfModule;
const { S } = await import('../public-src/state/index.js');

interface FakeEl {
  value: string; checked: boolean; disabled: boolean; files?: unknown[] | undefined;
  style: Record<string, string>; dataset: Record<string, string>;
  innerHTML: string; textContent: string; hidden: boolean;
  classList: { add(): void; remove(): void; toggle(): void; contains(): boolean };
  focus(): void; addEventListener(): void; removeEventListener(): void;
  appendChild(): void; insertBefore(): void; remove(): void;
  querySelectorAll(): never[]; querySelector(): null;
  setAttribute(): void; getAttribute(): null; removeAttribute(): void;
  ownerDocument?: unknown; parentNode?: unknown;
}

const makeEl = (over: Partial<FakeEl> = {}): FakeEl => ({
  value: '', checked: false, disabled: false, files: undefined, style: {}, dataset: {},
  innerHTML: '', textContent: '', hidden: false,
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  focus() {}, addEventListener() {}, removeEventListener() {},
  appendChild() {}, insertBefore() {}, remove() {},
  querySelectorAll: () => [], querySelector: () => null,
  setAttribute() {}, getAttribute: () => null, removeAttribute() {},
  ...over,
});

let fakeNodes: Record<string, FakeEl> = {};

function installDom(): void {
  fakeNodes = {};
  const doc = {
    getElementById: (id: string): FakeEl => (fakeNodes[id] ??= makeEl()),
    querySelector: () => null,
    querySelectorAll: () => [] as never[],
    createElement: () => makeEl(),
    body: makeEl(),
  };
  // Pre-create the nodes the tests assert on.
  fakeNodes['beanFormStickerBtn'] = makeEl();
  fakeNodes['beanFormName'] = makeEl({ value: 'New Bean' });
  g.document = doc;
  g.window = { showToast: mocks.showToast };
}

function stickerBtn(): FakeEl {
  return fakeNodes['beanFormStickerBtn']!;
}

describe('bean-form sticker button (#1336)', () => {
  beforeEach(() => {
    mocks.openStickerEditor.mockReset();
    mocks.isStickerCutoutAvailable.mockReset();
    mocks.uploadBeanImage.mockReset();
    mocks.saveBean.mockReset();
    mocks.invalidateBeanImage.mockReset();
    mocks.apiFetch.mockReset();
    mocks.crop.mockReset();
    mocks.showToast.mockReset();
    S.beanEditId = null;
    S.coffeeLibrary = { beans: [], recipes: [], grinders: [] };
    installDom();
    // Clears any staged blob left by a previous test.
    library.closeBeanForm();
  });

  it('hides the button when the cut-out models are not available', async () => {
    S.beanEditId = 5;
    S.coffeeLibrary.beans = [{ id: 5, name: 'B', image: 'jpg', bags: [] }];
    mocks.isStickerCutoutAvailable.mockResolvedValue(false);
    await library.updateStickerButton();
    expect(stickerBtn().style.display).toBe('none');
  });

  it('shows the button in edit mode when the bean has a photo', async () => {
    S.beanEditId = 5;
    S.coffeeLibrary.beans = [{ id: 5, name: 'B', image: 'jpg', bags: [] }];
    mocks.isStickerCutoutAvailable.mockResolvedValue(true);
    await library.updateStickerButton();
    expect(stickerBtn().style.display).toBe('');
  });

  it('hides the button in create mode without a staged photo', async () => {
    mocks.isStickerCutoutAvailable.mockResolvedValue(true);
    await library.updateStickerButton();
    expect(stickerBtn().style.display).toBe('none');
  });
});

describe('cutOutBeanSticker (#1336)', () => {
  beforeEach(() => {
    mocks.openStickerEditor.mockReset();
    mocks.isStickerCutoutAvailable.mockReset();
    mocks.uploadBeanImage.mockReset();
    mocks.saveBean.mockReset();
    mocks.invalidateBeanImage.mockReset();
    mocks.apiFetch.mockReset();
    mocks.crop.mockReset();
    mocks.showToast.mockReset();
    S.beanEditId = null;
    S.coffeeLibrary = { beans: [], recipes: [], grinders: [] };
    installDom();
    library.closeBeanForm();
  });

  it('fetches the photo, uploads the PNG and invalidates the cache in edit mode', async () => {
    S.beanEditId = 7;
    const photo = { type: 'image/jpeg' };
    const png = { type: 'image/png' };
    mocks.apiFetch.mockResolvedValue({ ok: true, statusText: 'OK', blob: () => Promise.resolve(photo) });
    mocks.openStickerEditor.mockResolvedValue(png);
    mocks.uploadBeanImage.mockResolvedValue({
      ok: true, statusText: 'OK',
      json: () => Promise.resolve({ id: 7, name: 'B', image: 'png', bags: [] }),
    });

    await library.cutOutBeanSticker();

    expect(mocks.apiFetch).toHaveBeenCalledWith('api/library/bean/7/image');
    expect(mocks.openStickerEditor).toHaveBeenCalledWith(photo);
    expect(mocks.uploadBeanImage).toHaveBeenCalledWith(7, png);
    expect(mocks.invalidateBeanImage).toHaveBeenCalledWith(7);
    expect(mocks.showToast).toHaveBeenCalled();
    expect(stickerBtn().disabled).toBe(false);
  });

  it('uploads nothing when the editor resolves null', async () => {
    S.beanEditId = 7;
    mocks.apiFetch.mockResolvedValue({ ok: true, statusText: 'OK', blob: () => Promise.resolve({ type: 'image/jpeg' }) });
    mocks.openStickerEditor.mockResolvedValue(null);

    await library.cutOutBeanSticker();

    expect(mocks.uploadBeanImage).not.toHaveBeenCalled();
    expect(mocks.invalidateBeanImage).not.toHaveBeenCalled();
  });

  it('replaces the staged blob with the PNG in create mode', async () => {
    const original = { type: 'image/jpeg' };
    const png = { type: 'image/png' };
    mocks.crop.mockResolvedValue(original);
    mocks.openStickerEditor.mockResolvedValue(png);
    mocks.saveBean.mockResolvedValue({ id: 42, name: 'New Bean', bags: [] });
    mocks.uploadBeanImage.mockResolvedValue({
      ok: true, statusText: 'OK',
      json: () => Promise.resolve({ id: 42, name: 'New Bean', image: 'png', bags: [] }),
    });

    const input = { files: [{}], value: 'x' } as unknown as HTMLInputElement;
    await library.stageNewBeanImage(input);
    await library.cutOutBeanSticker();
    expect(mocks.openStickerEditor).toHaveBeenCalledWith(original);

    // The regular save path now uploads the cut-out PNG, not the original.
    await library.saveBeanNoBag();
    expect(mocks.uploadBeanImage).toHaveBeenCalledTimes(1);
    expect(mocks.uploadBeanImage.mock.calls[0]?.[1]).toBe(png);
  });
});

describe('shelf sticker look (#1336)', () => {
  it('marks only png photos as stickers', () => {
    const png = renderShelfTile({ id: 1, name: 'A', image: 'png', bags: [] }, { muted: false });
    const jpg = renderShelfTile({ id: 2, name: 'B', image: 'jpg', bags: [] }, { muted: false });
    expect(png).toContain('is-sticker');
    expect(jpg).not.toContain('is-sticker');
  });
});
