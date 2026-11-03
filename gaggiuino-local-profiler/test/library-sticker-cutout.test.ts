import { describe, it, expect, beforeEach, vi } from 'vitest';

// views/library.ts's import chain (bags.ts -> views/library.ts -> state/i18n)
// reads localStorage/navigator at module load time — stub the browser globals
// so the module graph can be imported under vitest's node environment (same
// pattern as test/library-shelf-classify.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
const alertMock = vi.fn<(msg: string) => void>();
g.alert = alertMock;

// The sticker modules are the heavy on-device machinery: mock both before the
// dynamic imports in the view resolve, so no onnxruntime code is ever loaded.
const mocks = vi.hoisted(() => ({
  openStickerEditor: vi.fn<(photo: Blob) => Promise<Blob | null>>(),
  isStickerCutoutAvailable: vi.fn<() => Promise<boolean>>(),
  saveBean: vi.fn(),
  invalidateBeanImage: vi.fn(),
  apiFetch: vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(),
  openCropEditor: vi.fn<(file: Blob, opts?: Record<string, unknown>) => Promise<unknown>>(),
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
  return { ...actual, saveBean: mocks.saveBean };
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
  return { ...actual, openCropEditor: mocks.openCropEditor };
});

interface LibraryModule {
  updateStickerButton: () => Promise<void>;
  cutOutBeanSticker: () => Promise<void>;
  stageNewBeanImage: (input: HTMLInputElement) => Promise<void>;
  saveBeanNoBag: () => Promise<void>;
  openBeanForm: (bean: unknown) => void;
  closeBeanForm: () => void;
}
interface ShelfModule {
  renderShelfTile: (b: unknown, opts: { muted: boolean; expanded?: boolean }) => string;
}

const library = (await import('../public-src/views/library.js')) as unknown as LibraryModule;
const { adjustBeanImage } = (await import('../public-src/views/library/bean-sticker.js')) as unknown as {
  adjustBeanImage: () => Promise<void>;
};
const { renderShelfTile } = (await import('../public-src/views/library/shelf.js')) as unknown as ShelfModule;
const { S } = await import('../public-src/state/index.js');

const CROP = { x: 0.125, y: 0, w: 0.75, h: 1 };
const CROP_QUERY = '0.125,0,0.75,1';
const NEW_CROP = { x: 0, y: 0.25, w: 1, h: 0.5 };
const NEW_CROP_QUERY = '0,0.25,1,0.5';

const route = (id: number): string => `api/library/bean/${id}/image`;
const jpeg = (text = 'jpeg'): Blob => new Blob([text], { type: 'image/jpeg' });
const png = (): Blob => new Blob(['png'], { type: 'image/png' });
const BEAN_PHOTO_OPTS = { shape: 'square', aspect: 'portrait' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function image(blob: Blob): Response {
  return new Response(blob, { status: 200 });
}

interface Call {
  url: string;
  opts: RequestInit | undefined;
}
function calls(): Call[] {
  return mocks.apiFetch.mock.calls.map(([url, opts]) => ({ url, opts }));
}
function contentType(call: Call | undefined): string | null {
  return new Headers(call?.opts?.headers).get('Content-Type');
}
function bodyText(call: Call | undefined): Promise<string> {
  return (call?.opts?.body as Blob).text();
}

interface FakeEl {
  value: string; checked: boolean; disabled: boolean; files?: unknown[] | undefined;
  style: Record<string, string>; dataset: Record<string, string>;
  innerHTML: string; textContent: string; hidden: boolean;
  onclick?: (() => void) | null;
  classList: { add(): void; remove(): void; toggle(): void; contains(): boolean };
  focus(): void; addEventListener(): void; removeEventListener(): void;
  appendChild(): void; insertBefore(): void; remove(): void;
  querySelectorAll(): never[]; querySelector(): null;
  setAttribute(): void; getAttribute(): null; removeAttribute(): void;
  ownerDocument?: unknown; parentNode?: unknown;
}

const makeEl = (over: Partial<FakeEl> = {}): FakeEl => ({
  value: '', checked: false, disabled: false, files: undefined, style: {}, dataset: {},
  innerHTML: '', textContent: '', hidden: false, onclick: null,
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
  fakeNodes['beanFormImageAdjustBtn'] = makeEl();
  fakeNodes['beanFormName'] = makeEl({ value: 'New Bean' });
  g.document = doc;
  g.window = { showToast: mocks.showToast };
}

function stickerBtn(): FakeEl {
  return fakeNodes['beanFormStickerBtn']!;
}
function adjustBtn(): FakeEl {
  return fakeNodes['beanFormImageAdjustBtn']!;
}

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

function resetAll(): void {
  mocks.openStickerEditor.mockReset();
  mocks.isStickerCutoutAvailable.mockReset();
  mocks.saveBean.mockReset();
  mocks.invalidateBeanImage.mockReset();
  mocks.apiFetch.mockReset();
  mocks.openCropEditor.mockReset();
  mocks.showToast.mockReset();
  alertMock.mockReset();
  warn.mockClear();
  S.beanEditId = null;
  S.coffeeLibrary = { beans: [], recipes: [], grinders: [] };
}

describe('bean-form sticker button (#1336)', () => {
  beforeEach(() => {
    resetAll();
    installDom();
    // Clears any staged photo left by a previous test.
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

describe('bean-form Crop photo button (#1845)', () => {
  beforeEach(() => {
    resetAll();
    installDom();
    library.closeBeanForm();
  });

  it('shows it for a JPEG bean without a stored crop', async () => {
    S.beanEditId = 5;
    S.coffeeLibrary.beans = [{ id: 5, name: 'B', image: 'jpg', bags: [] }];
    mocks.isStickerCutoutAvailable.mockResolvedValue(false);
    await library.updateStickerButton();
    expect(adjustBtn().style.display).toBe('');
  });

  it('hides it for a legacy sticker without a stored crop', async () => {
    S.beanEditId = 5;
    S.coffeeLibrary.beans = [{ id: 5, name: 'B', image: 'png', bags: [] }];
    mocks.isStickerCutoutAvailable.mockResolvedValue(true);
    await library.updateStickerButton();
    expect(adjustBtn().style.display).toBe('none');
  });

  it('hides it for a sticker with a crop when the cut-out is unavailable', async () => {
    S.beanEditId = 5;
    S.coffeeLibrary.beans = [{ id: 5, name: 'B', image: 'png', imageCrop: CROP, bags: [] }];
    mocks.isStickerCutoutAvailable.mockResolvedValue(false);
    await library.updateStickerButton();
    expect(adjustBtn().style.display).toBe('none');
  });

  it('shows it for a sticker with a crop when the cut-out is available', async () => {
    S.beanEditId = 5;
    S.coffeeLibrary.beans = [{ id: 5, name: 'B', image: 'png', imageCrop: CROP, bags: [] }];
    mocks.isStickerCutoutAvailable.mockResolvedValue(true);
    await library.updateStickerButton();
    expect(adjustBtn().style.display).toBe('');
  });

  it('hides it in create mode, even with a staged photo', async () => {
    mocks.isStickerCutoutAvailable.mockResolvedValue(true);
    mocks.openCropEditor.mockResolvedValue({ blob: jpeg('cropped'), crop: CROP, original: jpeg() });
    const input = { files: [{}], value: 'x' } as unknown as HTMLInputElement;
    await library.stageNewBeanImage(input);
    await library.updateStickerButton();
    expect(adjustBtn().style.display).toBe('none');
  });

  it('hides it in edit mode without a photo', async () => {
    S.beanEditId = 5;
    S.coffeeLibrary.beans = [{ id: 5, name: 'B', bags: [] }];
    mocks.isStickerCutoutAvailable.mockResolvedValue(true);
    await library.updateStickerButton();
    expect(adjustBtn().style.display).toBe('none');
  });

  it('is hidden by closeBeanForm()', () => {
    adjustBtn().style.display = '';
    library.closeBeanForm();
    expect(adjustBtn().style.display).toBe('none');
  });

  it('wires the button with onclick and opens the stored original', async () => {
    const bean = { id: 9, name: 'B', image: 'jpg', imageCrop: CROP, bags: [] };
    S.coffeeLibrary.beans = [bean];
    mocks.isStickerCutoutAvailable.mockResolvedValue(true);
    mocks.apiFetch.mockResolvedValue(image(jpeg('original')));
    mocks.openCropEditor.mockResolvedValue(null);

    library.openBeanForm(bean);
    expect(typeof adjustBtn().onclick).toBe('function');

    adjustBtn().onclick?.();
    await vi.waitFor(() => {
      expect(calls().some(c => c.url === `${route(9)}?original=1`)).toBe(true);
    });
  });
});

describe('adjustBeanImage (#1845)', () => {
  beforeEach(() => {
    resetAll();
    installDom();
    library.closeBeanForm();
  });

  it('re-crops a JPEG at its stored crop through ?crop= and stores the row', async () => {
    S.beanEditId = 7;
    S.coffeeLibrary.beans = [{ id: 7, name: 'B', image: 'jpg', imageCrop: CROP, bags: [] }];
    const original = jpeg('original');
    const cropped = jpeg('cropped');
    const recropped = json({ id: 7, name: 'B', image: 'jpg', imageCrop: NEW_CROP, bags: [] });
    mocks.apiFetch.mockResolvedValueOnce(image(original)).mockResolvedValueOnce(recropped);
    mocks.openCropEditor.mockResolvedValue({ blob: cropped, crop: NEW_CROP, original: jpeg('re-encoded') });

    await adjustBeanImage();

    const [stored, recrop] = calls();
    expect(stored?.url).toBe(`${route(7)}?original=1`);
    expect(stored?.opts?.cache).toBe('no-cache');
    expect(mocks.openCropEditor).toHaveBeenCalledWith(original, { ...BEAN_PHOTO_OPTS, initialCrop: CROP });
    expect(recrop?.url).toBe(`${route(7)}?crop=${NEW_CROP_QUERY}`);
    expect(recrop?.opts?.method).toBe('POST');
    expect(recrop?.opts?.body).toBeUndefined();
    expect(mocks.openStickerEditor).not.toHaveBeenCalled();
    expect(S.coffeeLibrary.beans[0]?.imageCrop).toEqual(NEW_CROP);
    expect(mocks.invalidateBeanImage).toHaveBeenCalledWith(7);
  });

  it('sends nothing on a cancelled re-crop dialog', async () => {
    S.beanEditId = 7;
    const bean = { id: 7, name: 'B', image: 'jpg', imageCrop: CROP, bags: [] };
    S.coffeeLibrary.beans = [bean];
    mocks.apiFetch.mockResolvedValueOnce(image(jpeg('original')));
    mocks.openCropEditor.mockResolvedValue(null);

    await adjustBeanImage();

    expect(calls()).toHaveLength(1);
    expect(S.coffeeLibrary.beans[0]).toBe(bean);
  });

  it('opens an older JPEG on the current image with the hint and saves a photo plus original', async () => {
    S.beanEditId = 7;
    S.coffeeLibrary.beans = [{ id: 7, name: 'B', image: 'jpg', bags: [] }];
    const current = jpeg('current');
    const cropped = jpeg('cropped');
    const original = jpeg('original');
    mocks.apiFetch
      .mockResolvedValueOnce(image(current))
      .mockResolvedValueOnce(json({ id: 7, name: 'B', image: 'jpg', bags: [] }))
      .mockResolvedValueOnce(json({ id: 7, name: 'B', image: 'jpg', imageCrop: NEW_CROP, bags: [] }));
    mocks.openCropEditor.mockResolvedValue({ blob: cropped, crop: NEW_CROP, original });

    await adjustBeanImage();

    const [main, posted, stored] = calls();
    expect(main?.url).toBe(route(7));
    const opts = mocks.openCropEditor.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts['shape']).toBe('square');
    expect(opts['aspect']).toBe('portrait');
    expect(opts['initialCrop']).toBeUndefined();
    expect(typeof opts['hint']).toBe('string');
    expect(mocks.openCropEditor).toHaveBeenCalledWith(current, expect.objectContaining(opts));
    expect(posted?.url).toBe(route(7));
    expect(posted?.opts?.method).toBe('POST');
    expect(await bodyText(posted)).toBe('cropped');
    expect(stored?.url).toBe(`${route(7)}?original=1&crop=${NEW_CROP_QUERY}`);
    expect(contentType(stored)).toBe('image/jpeg');
    expect(await bodyText(stored)).toBe('original');
    expect(S.coffeeLibrary.beans[0]?.imageCrop).toEqual(NEW_CROP);
  });

  it('crops a sticker first, cuts it out, and re-saves the original with the new crop', async () => {
    S.beanEditId = 8;
    S.coffeeLibrary.beans = [{ id: 8, name: 'S', image: 'png', imageCrop: CROP, bags: [] }];
    const original = jpeg('original');
    const cropped = jpeg('cropped');
    const cutout = png();
    mocks.apiFetch
      .mockResolvedValueOnce(image(original))
      .mockResolvedValueOnce(json({ id: 8, name: 'S', image: 'png', bags: [] }))
      .mockResolvedValueOnce(json({ id: 8, name: 'S', image: 'png', imageCrop: NEW_CROP, bags: [] }));
    mocks.openCropEditor.mockResolvedValue({ blob: cropped, crop: NEW_CROP, original: jpeg('re-encoded') });
    mocks.openStickerEditor.mockResolvedValue(cutout);

    await adjustBeanImage();

    expect(mocks.openCropEditor).toHaveBeenCalledWith(original, { ...BEAN_PHOTO_OPTS, initialCrop: CROP });
    expect(mocks.openStickerEditor).toHaveBeenCalledWith(cropped);
    expect(mocks.openCropEditor.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.openStickerEditor.mock.invocationCallOrder[0] ?? 0);

    const [storedOriginal, posted, resaved] = calls();
    expect(storedOriginal?.url).toBe(`${route(8)}?original=1`);
    expect(posted?.url).toBe(route(8));
    expect(posted?.opts?.method).toBe('POST');
    expect(contentType(posted)).toBe('image/png');
    expect(await bodyText(posted)).toBe('png');
    expect(resaved?.url).toBe(`${route(8)}?original=1&crop=${NEW_CROP_QUERY}`);
    expect(await bodyText(resaved)).toBe('original');
    expect(calls().some(c => c.url.includes('?crop=') && !c.url.includes('original=1'))).toBe(false);
    expect(S.coffeeLibrary.beans[0]?.imageCrop).toEqual(NEW_CROP);
    expect(mocks.showToast).toHaveBeenCalled();
  });

  it('never opens the sticker editor when the sticker crop dialog is cancelled', async () => {
    S.beanEditId = 8;
    const bean = { id: 8, name: 'S', image: 'png', imageCrop: CROP, bags: [] };
    S.coffeeLibrary.beans = [bean];
    mocks.apiFetch.mockResolvedValueOnce(image(jpeg('original')));
    mocks.openCropEditor.mockResolvedValue(null);

    await adjustBeanImage();

    expect(mocks.openStickerEditor).not.toHaveBeenCalled();
    expect(calls()).toHaveLength(1);
    expect(S.coffeeLibrary.beans[0]).toBe(bean);
  });

  it('sends nothing when the sticker editor is cancelled after the crop', async () => {
    S.beanEditId = 8;
    const bean = { id: 8, name: 'S', image: 'png', imageCrop: CROP, bags: [] };
    S.coffeeLibrary.beans = [bean];
    mocks.apiFetch.mockResolvedValueOnce(image(jpeg('original')));
    mocks.openCropEditor.mockResolvedValue({ blob: jpeg('cropped'), crop: NEW_CROP, original: jpeg() });
    mocks.openStickerEditor.mockResolvedValue(null);

    await adjustBeanImage();

    expect(calls()).toHaveLength(1);
    expect(S.coffeeLibrary.beans[0]).toBe(bean);
  });
});

describe('cutOutBeanSticker (#1336)', () => {
  beforeEach(() => {
    resetAll();
    installDom();
    library.closeBeanForm();
  });

  it('fetches the photo, uploads the PNG and re-saves the original of a cropped photo', async () => {
    S.beanEditId = 7;
    S.coffeeLibrary.beans = [{ id: 7, name: 'B', image: 'jpg', imageCrop: CROP, bags: [] }];
    const photo = jpeg('photo');
    const original = jpeg('original');
    const cutout = png();
    mocks.apiFetch
      .mockResolvedValueOnce(image(photo))
      .mockResolvedValueOnce(image(original))
      .mockResolvedValueOnce(json({ id: 7, name: 'B', image: 'png', bags: [] }))
      .mockResolvedValueOnce(json({ id: 7, name: 'B', image: 'png', imageCrop: CROP, bags: [] }));
    mocks.openStickerEditor.mockResolvedValue(cutout);

    await library.cutOutBeanSticker();

    const [fetched, fetchedOriginal, posted, stored] = calls();
    // The original is fetched before the upload, which drops it.
    expect(fetched?.url).toBe(route(7));
    expect(fetched?.opts).toBeUndefined();
    expect(fetchedOriginal?.url).toBe(`${route(7)}?original=1`);
    expect(fetchedOriginal?.opts?.cache).toBe('no-cache');
    expect(mocks.openStickerEditor).toHaveBeenCalledWith(photo);
    expect(posted?.url).toBe(route(7));
    expect(posted?.opts?.method).toBe('POST');
    expect(contentType(posted)).toBe('image/png');
    expect(await bodyText(posted)).toBe('png');
    expect(stored?.url).toBe(`${route(7)}?original=1&crop=${CROP_QUERY}`);
    expect(contentType(stored)).toBe('image/jpeg');
    expect(await bodyText(stored)).toBe('original');
    expect(S.coffeeLibrary.beans[0]?.image).toBe('png');
    expect(S.coffeeLibrary.beans[0]?.imageCrop).toEqual(CROP);
    expect(mocks.invalidateBeanImage).toHaveBeenCalledWith(7);
    expect(mocks.showToast).toHaveBeenCalled();
    expect(stickerBtn().disabled).toBe(false);
  });

  it('posts a photo without a stored original alone and warns once', async () => {
    S.beanEditId = 7;
    S.coffeeLibrary.beans = [{ id: 7, name: 'B', image: 'jpg', bags: [] }];
    mocks.apiFetch
      .mockResolvedValueOnce(image(jpeg('photo')))
      .mockResolvedValueOnce(json({ id: 7, name: 'B', image: 'png', bags: [] }));
    mocks.openStickerEditor.mockResolvedValue(png());

    await library.cutOutBeanSticker();

    expect(calls()).toHaveLength(2);
    expect(calls()[1]?.url).toBe(route(7));
    expect(calls()[1]?.opts?.method).toBe('POST');
    expect(calls().some(c => c.url.includes('original=1'))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('uploads nothing when the editor resolves null', async () => {
    S.beanEditId = 7;
    S.coffeeLibrary.beans = [{ id: 7, name: 'B', image: 'jpg', bags: [] }];
    mocks.apiFetch.mockResolvedValueOnce(image(jpeg('photo')));
    mocks.openStickerEditor.mockResolvedValue(null);

    await library.cutOutBeanSticker();

    expect(calls()).toHaveLength(1);
    expect(mocks.invalidateBeanImage).not.toHaveBeenCalled();
  });

  it('replaces only the staged blob, so the save path stores the original too', async () => {
    const stagedCropped = jpeg('staged');
    const stagedOriginal = jpeg('staged-original');
    mocks.openCropEditor.mockResolvedValue({ blob: stagedCropped, crop: CROP, original: stagedOriginal });
    mocks.openStickerEditor.mockResolvedValue(png());
    mocks.saveBean.mockResolvedValue({ id: 42, name: 'New Bean', bags: [] });
    mocks.apiFetch
      .mockResolvedValueOnce(json({ id: 42, name: 'New Bean', image: 'png', bags: [] }))
      .mockResolvedValueOnce(json({ id: 42, name: 'New Bean', image: 'png', imageCrop: CROP, bags: [] }));

    const input = { files: [{}], value: 'x' } as unknown as HTMLInputElement;
    await library.stageNewBeanImage(input);
    await library.cutOutBeanSticker();
    expect(mocks.openStickerEditor).toHaveBeenCalledWith(stagedCropped);

    // The regular save path now uploads the cut-out PNG plus the staged original.
    await library.saveBeanNoBag();
    const posted = calls().filter(c => c.url.startsWith('api/library/bean/42/image'));
    expect(posted).toHaveLength(2);
    expect(posted[0]?.url).toBe('api/library/bean/42/image');
    expect(contentType(posted[0])).toBe('image/png');
    expect(await bodyText(posted[0])).toBe('png');
    expect(posted[1]?.url).toBe(`api/library/bean/42/image?original=1&crop=${CROP_QUERY}`);
    expect(await bodyText(posted[1])).toBe('staged-original');
  });
});

describe('shelf sticker look (#1336)', () => {
  it('marks only png photos as stickers', () => {
    const pngTile = renderShelfTile({ id: 1, name: 'A', image: 'png', bags: [] }, { muted: false });
    const jpgTile = renderShelfTile({ id: 2, name: 'B', image: 'jpg', bags: [] }, { muted: false });
    expect(pngTile).toContain('is-sticker');
    expect(jpgTile).not.toContain('is-sticker');
  });
});
