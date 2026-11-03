// #1845 slice 6b: the shot photo keeps its uncropped original and can be
// re-cropped later. The annotation panel's photo section now goes through
// photo-upload.ts (cropAndUploadPhoto / adjustPhoto / savedPhotoRow), and
// refreshShots() keeps the row's imageCrop in sync with the image. vitest runs
// in the node environment, so the globals the module chain reads at load are
// stubbed here (same pattern as test/live-sync-shots.test.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CropEditorOptions, CropEditorResult } from '../public-src/components/image-crop.js';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= {};
const alertMock = vi.fn<(msg: string) => void>();
g.alert = alertMock;

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(),
  openCropEditor: vi.fn<(file: Blob, opts?: CropEditorOptions) => Promise<CropEditorResult | null>>(),
  invalidateShotImage: vi.fn(),
  loadShotImageBlobUrl: vi.fn<(id: number) => Promise<string | null>>(),
  renderSidebar: vi.fn(),
  updateSidebarHighlighting: vi.fn(),
}));

vi.mock('../public-src/api/transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/transport.js')>();
  return { ...actual, apiFetch: mocks.apiFetch };
});
vi.mock('../public-src/components/image-crop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/components/image-crop.js')>();
  return { ...actual, openCropEditor: mocks.openCropEditor };
});
vi.mock('../public-src/bean-image.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/bean-image.js')>();
  return {
    ...actual,
    invalidateShotImage: mocks.invalidateShotImage,
    loadShotImageBlobUrl: mocks.loadShotImageBlobUrl,
  };
});
vi.mock('../public-src/components/sidebar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/components/sidebar.js')>();
  return {
    ...actual,
    renderSidebar: mocks.renderSidebar,
    updateSidebarHighlighting: mocks.updateSidebarHighlighting,
  };
});

const { S } = await import('../public-src/state/index.js');
const { t } = await import('../public-src/i18n.js');
// views/shots/index.js first, at module load, before any fake `document`: its
// import chain registers load-time listeners only when `document` exists.
const { refreshShots } = await import('../public-src/views/shots/index.js');
const { uploadShotImage, adjustShotImage, removeShotImage, _renderShotPhoto } =
  await import('../public-src/views/shots/annotation.js');

const CROP = { x: 0.125, y: 0, w: 0.75, h: 1 };
const NEW_CROP = { x: 0, y: 0.25, w: 1, h: 0.5 };

interface FakeStyle { display: string }
interface FakeBtn { style: FakeStyle; onclick: (() => void) | null }
interface FakeThumb {
  style: FakeStyle;
  src: string;
  attrs: Set<string>;
  setAttribute(name: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
}

let adjustBtn: FakeBtn;

function makeThumb(): FakeThumb {
  const attrs = new Set<string>();
  return {
    style: { display: '' },
    src: '',
    attrs,
    setAttribute: (name: string) => { attrs.add(name); },
    removeAttribute: (name: string) => { attrs.delete(name); },
    hasAttribute: (name: string) => attrs.has(name),
  };
}

function installDocument(withAdjustBtn = true): void {
  const thumb = makeThumb();
  const removeBtn: FakeBtn = { style: { display: '' }, onclick: null };
  adjustBtn = { style: { display: 'none' }, onclick: null };
  const elements: Record<string, unknown> = {
    annPhotoThumb: thumb,
    annPhotoRemoveBtn: removeBtn,
  };
  if (withAdjustBtn) elements['annPhotoAdjustBtn'] = adjustBtn;
  g.document = { getElementById: (id: string) => elements[id] ?? null };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function image(blob: Blob, status = 200): Response {
  return new Response(blob, { status });
}

interface Call { url: string; opts: RequestInit | undefined }

function calls(): Call[] {
  return mocks.apiFetch.mock.calls.map(([url, opts]) => ({ url, opts }));
}

function row(): Record<string, unknown> {
  return S.allShots[0] ?? {};
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
    if (i % 10 === 9) await new Promise(resolve => setTimeout(resolve, 0));
  }
}

const file = { size: 10, type: 'image/jpeg' } as Blob;
const cropped = new Blob(['c'], { type: 'image/jpeg' });
const original = new Blob(['o'], { type: 'image/jpeg' });

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.openCropEditor.mockReset();
  mocks.invalidateShotImage.mockReset();
  mocks.loadShotImageBlobUrl.mockReset();
  mocks.renderSidebar.mockReset();
  mocks.updateSidebarHighlighting.mockReset();
  alertMock.mockReset();
  mocks.loadShotImageBlobUrl.mockResolvedValue(null);
  S.allShots = [{ id: 7, timestamp: 1000 }];
  S.shots = S.allShots;
  S.primaryShotId = 7;
  installDocument();
});

describe('shot photo upload keeps the original (#1845)', () => {
  it('uploads the cropped photo, then the original with its crop', async () => {
    mocks.openCropEditor.mockResolvedValue({ blob: cropped, crop: CROP, original });
    mocks.apiFetch
      .mockResolvedValueOnce(json({ id: 7, image: 'jpg' }))
      .mockResolvedValueOnce(json({ id: 7, image: 'jpg', imageCrop: CROP }));

    const input = { files: [file], value: 'x' } as unknown as HTMLInputElement;
    await uploadShotImage(input);

    expect(mocks.openCropEditor).toHaveBeenCalledWith(file, { shape: 'circle' });
    const sent = calls();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.url).toBe('api/shots/7/image');
    expect(sent[0]?.opts?.method).toBe('POST');
    expect(sent[0]?.opts?.body).toBe(cropped);
    expect(new Headers(sent[0]?.opts?.headers).get('Content-Type')).toBe('image/jpeg');
    expect(sent[1]?.url).toBe('api/shots/7/image?original=1&crop=0.125,0,0.75,1');
    expect(sent[1]?.opts?.body).toBe(original);
    expect(new Headers(sent[1]?.opts?.headers).get('Content-Type')).toBe('image/jpeg');

    expect(input.value).toBe('');
    expect(row()['image']).toBe('jpg');
    expect(row()['imageCrop']).toEqual(CROP);
    expect(mocks.invalidateShotImage).toHaveBeenCalledWith(7);
    expect(mocks.renderSidebar).toHaveBeenCalledTimes(1);
    expect(adjustBtn.style.display).toBe('');
  });

  it('sends nothing when the crop dialog is cancelled', async () => {
    mocks.openCropEditor.mockResolvedValue(null);

    const input = { files: [file], value: 'x' } as unknown as HTMLInputElement;
    await uploadShotImage(input);

    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    expect('image' in row()).toBe(false);
    expect('imageCrop' in row()).toBe(false);
  });

  it('alerts and keeps the row when the upload fails', async () => {
    mocks.openCropEditor.mockResolvedValue({ blob: cropped, crop: CROP, original });
    mocks.apiFetch.mockResolvedValueOnce(json({ error: 'unsupported image' }, 400));

    const input = { files: [file], value: '' } as unknown as HTMLInputElement;
    await uploadShotImage(input);

    expect(calls()).toHaveLength(1);
    expect(alertMock).toHaveBeenCalledWith(t('error_generic', 'unsupported image'));
    expect('image' in row()).toBe(false);
    expect('imageCrop' in row()).toBe(false);
    expect(mocks.invalidateShotImage).not.toHaveBeenCalled();
  });

  it('patches the uploaded shot but leaves the panel alone when another shot is open by then', async () => {
    adjustBtn.style.display = 'none';
    mocks.openCropEditor.mockImplementation(() => {
      S.primaryShotId = 8;
      return Promise.resolve({ blob: cropped, crop: CROP, original });
    });
    mocks.apiFetch
      .mockResolvedValueOnce(json({ id: 7, image: 'jpg' }))
      .mockResolvedValueOnce(json({ id: 7, image: 'jpg', imageCrop: CROP }));

    const input = { files: [file], value: '' } as unknown as HTMLInputElement;
    await uploadShotImage(input);

    expect(row()['image']).toBe('jpg');
    expect(row()['imageCrop']).toEqual(CROP);
    expect(adjustBtn.style.display).toBe('none');
  });
});

describe('Crop photo button on a shot (#1845)', () => {
  it('shows the button with a click handler for a shot with a photo and hides it without one', () => {
    _renderShotPhoto({ id: 7, image: 'jpg' });
    expect(adjustBtn.style.display).toBe('');
    expect(typeof adjustBtn.onclick).toBe('function');

    _renderShotPhoto({ id: 7, image: null });
    expect(adjustBtn.style.display).toBe('none');
  });

  it('does not throw when the button is missing', () => {
    installDocument(false);
    expect(() => _renderShotPhoto({ id: 7, image: 'jpg' })).not.toThrow();
  });

  it('re-crops a photo with a stored original through ?crop=', async () => {
    const withCrop = { id: 7, timestamp: 1000, image: 'jpg', imageCrop: CROP };
    S.allShots = [withCrop];
    S.shots = S.allShots;
    mocks.apiFetch
      .mockResolvedValueOnce(image(original))
      .mockResolvedValueOnce(json({ id: 7, image: 'jpg', imageCrop: NEW_CROP }));
    mocks.openCropEditor.mockResolvedValue({ blob: cropped, crop: NEW_CROP, original });

    _renderShotPhoto({ id: 7, image: 'jpg' });
    expect(typeof adjustBtn.onclick).toBe('function');
    adjustBtn.onclick?.();
    await flush();

    const sent = calls();
    expect(sent[0]?.url).toBe('api/shots/7/image?original=1');
    expect(sent[0]?.opts).toEqual({ cache: 'no-cache' });
    expect(mocks.openCropEditor).toHaveBeenCalledWith(expect.any(Blob), { shape: 'circle', initialCrop: CROP });
    expect(sent[1]?.url).toBe('api/shots/7/image?crop=0,0.25,1,0.5');
    expect(sent[1]?.opts?.method).toBe('POST');
    expect(sent[1]?.opts?.body).toBeUndefined();

    expect(row()['imageCrop']).toEqual(NEW_CROP);
    expect(mocks.invalidateShotImage).toHaveBeenCalledWith(7);
  });

  it('sends no write request when the re-crop is cancelled', async () => {
    S.allShots = [{ id: 7, timestamp: 1000, image: 'jpg', imageCrop: CROP }];
    S.shots = S.allShots;
    mocks.apiFetch.mockResolvedValueOnce(image(original));
    mocks.openCropEditor.mockResolvedValue(null);

    await adjustShotImage();

    expect(calls().map(c => c.url)).toEqual(['api/shots/7/image?original=1']);
    expect(mocks.invalidateShotImage).not.toHaveBeenCalled();
  });

  it('opens an older shot photo with the hint and then stores its original', async () => {
    S.allShots = [{ id: 7, timestamp: 1000, image: 'jpg' }];
    S.shots = S.allShots;
    mocks.apiFetch
      .mockResolvedValueOnce(image(original))
      .mockResolvedValueOnce(json({ id: 7, image: 'jpg' }))
      .mockResolvedValueOnce(json({ id: 7, image: 'jpg', imageCrop: NEW_CROP }));
    mocks.openCropEditor.mockResolvedValue({ blob: cropped, crop: NEW_CROP, original });

    await adjustShotImage();

    const sent = calls();
    expect(sent[0]?.url).toBe('api/shots/7/image');
    expect(sent[0]?.opts).toEqual({ cache: 'no-cache' });
    expect(mocks.openCropEditor).toHaveBeenCalledWith(expect.any(Blob), {
      shape: 'circle', hint: t('crop_editor_legacy_hint'),
    });
    expect(sent[1]?.url).toBe('api/shots/7/image');
    expect(sent[1]?.opts?.body).toBe(cropped);
    expect(sent[2]?.url).toBe('api/shots/7/image?original=1&crop=0,0.25,1,0.5');
    expect(sent[2]?.opts?.body).toBe(original);
    expect(row()['imageCrop']).toEqual(NEW_CROP);
  });

  it('does nothing for a shot without a photo', async () => {
    await adjustShotImage();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(mocks.openCropEditor).not.toHaveBeenCalled();
  });

  it('remove drops the photo and its crop', async () => {
    S.allShots = [{ id: 7, timestamp: 1000, image: 'jpg', imageCrop: CROP }];
    S.shots = S.allShots;
    mocks.apiFetch.mockResolvedValueOnce(json({ ok: true }));

    await removeShotImage();

    const sent = calls();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('api/shots/7/image');
    expect(sent[0]?.opts?.method).toBe('DELETE');
    expect('image' in row()).toBe(false);
    expect('imageCrop' in row()).toBe(false);
    expect(adjustBtn.style.display).toBe('none');
  });
});

describe('refreshShots keeps imageCrop in sync (#1845)', () => {
  beforeEach(() => {
    S.primaryShotId = null;
  });

  it('takes the crop from the refreshed shot', async () => {
    mocks.apiFetch.mockResolvedValueOnce(
      json({ id: 7, annotation: {}, image: 'jpg', imageCrop: CROP, score: 80 }),
    );

    await refreshShots(['7']);

    expect(row()['imageCrop']).toEqual(CROP);
  });

  it('drops a stale crop when the refreshed shot has none', async () => {
    S.allShots = [{ id: 7, timestamp: 1000, image: 'jpg', imageCrop: CROP }];
    S.shots = S.allShots;
    mocks.apiFetch.mockResolvedValueOnce(json({ id: 7, annotation: {}, image: 'jpg', score: 80 }));

    await refreshShots(['7']);

    expect('imageCrop' in row()).toBe(false);
    expect(row()['image']).toBe('jpg');
  });
});
