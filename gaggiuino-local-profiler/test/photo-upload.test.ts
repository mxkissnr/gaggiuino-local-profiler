// #1845 slice 5a: photo-upload.ts is the one client of the photo route
// contract — a new photo, its uncropped original plus crop, and a re-crop of
// the stored original. vitest runs in the node environment, so the browser
// globals the module chain reads at load are stubbed here (same pattern as
// test/library-sticker-cutout.test.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CropEditorOptions, CropEditorResult } from '../public-src/components/image-crop.js';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
const alertMock = vi.fn<(msg: string) => void>();
g.alert = alertMock;

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(),
  openCropEditor: vi.fn<(file: Blob, opts?: CropEditorOptions) => Promise<CropEditorResult | null>>(),
}));

vi.mock('../public-src/api/transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/transport.js')>();
  return { ...actual, apiFetch: mocks.apiFetch };
});
vi.mock('../public-src/components/image-crop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/components/image-crop.js')>();
  return { ...actual, openCropEditor: mocks.openCropEditor };
});

const { cropAndUploadPhoto, adjustPhoto, savedPhotoRow } = await import('../public-src/photo-upload.js');
const { libraryImageUrl } = await import('../public-src/api/library.js');

const ROUTE = 'api/library/grinder/7/image';
const SHAPE = { shape: 'square' } as const;
const CROP = { x: 0.125, y: 0, w: 0.75, h: 1 };
const CROP_QUERY = '0.125,0,0.75,1';

const mainBlob = (): Blob => new Blob(['main'], { type: 'image/jpeg' });
const origBlob = (): Blob => new Blob(['orig'], { type: 'image/jpeg' });
const cropResult = (): CropEditorResult => ({ blob: mainBlob(), crop: CROP, original: origBlob() });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function image(blob: Blob, status = 200): Response {
  return new Response(blob, { status });
}

interface Call {
  url: string;
  opts: RequestInit | undefined;
}

function calls(): Call[] {
  return mocks.apiFetch.mock.calls.map(([url, opts]) => ({ url, opts }));
}

function contentType(call: Call | undefined): string | null {
  return new Headers(call.opts?.headers).get('Content-Type');
}

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.openCropEditor.mockReset();
  alertMock.mockReset();
  warn.mockClear();
});

describe('cropAndUploadPhoto', () => {
  it('sends nothing and resolves null when the dialog is cancelled', async () => {
    mocks.openCropEditor.mockResolvedValue(null);
    expect(await cropAndUploadPhoto(ROUTE, mainBlob(), SHAPE)).toBeNull();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('posts the main crop, then the original with its crop, and resolves the second response', async () => {
    mocks.openCropEditor.mockResolvedValue(cropResult());
    const mainResponse = json({ id: 7, image: true });
    const storedResponse = json({ id: 7, image: true, imageCrop: CROP });
    mocks.apiFetch.mockResolvedValueOnce(mainResponse).mockResolvedValueOnce(storedResponse);

    expect(await cropAndUploadPhoto(ROUTE, mainBlob(), SHAPE)).toBe(storedResponse);

    expect(mocks.openCropEditor).toHaveBeenCalledWith(expect.any(Blob), { shape: 'square' });
    const [main, original] = calls();
    expect(main?.url).toBe(ROUTE);
    expect(main?.opts?.method).toBe('POST');
    expect(contentType(main)).toBe('image/jpeg');
    expect(await (main?.opts?.body as Blob).text()).toBe('main');
    expect(original?.url).toBe(`${ROUTE}?original=1&crop=${CROP_QUERY}`);
    expect(original?.opts?.method).toBe('POST');
    expect(contentType(original)).toBe('image/jpeg');
    expect(await (original?.opts?.body as Blob).text()).toBe('orig');
  });

  it('resolves a failed main POST without sending the original', async () => {
    mocks.openCropEditor.mockResolvedValue(cropResult());
    const failed = json({ error: 'bad image' }, 400);
    mocks.apiFetch.mockResolvedValueOnce(failed);

    expect(await cropAndUploadPhoto(ROUTE, mainBlob(), SHAPE)).toBe(failed);
    expect(calls()).toHaveLength(1);
  });

  it('warns and resolves the main response when the dialog returned no original', async () => {
    mocks.openCropEditor.mockResolvedValue({ ...cropResult(), original: null });
    const mainResponse = json({ id: 7 });
    mocks.apiFetch.mockResolvedValueOnce(mainResponse);

    expect(await cropAndUploadPhoto(ROUTE, mainBlob(), SHAPE)).toBe(mainResponse);
    expect(calls()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the main response and warns when storing the original fails', async () => {
    mocks.openCropEditor.mockResolvedValue(cropResult());
    const mainResponse = json({ id: 7 });
    mocks.apiFetch.mockResolvedValueOnce(mainResponse).mockResolvedValueOnce(json({ error: 'slow down' }, 429));

    expect(await cropAndUploadPhoto(ROUTE, mainBlob(), SHAPE)).toBe(mainResponse);
    expect(calls()).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('adjustPhoto', () => {
  it('re-crops the stored original at its recorded crop', async () => {
    const recropped = json({ id: 7, imageCrop: CROP });
    mocks.apiFetch.mockResolvedValueOnce(image(origBlob())).mockResolvedValueOnce(recropped);
    mocks.openCropEditor.mockResolvedValue({ blob: mainBlob(), crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, original: origBlob() });

    expect(await adjustPhoto(ROUTE, CROP, SHAPE)).toBe(recropped);

    const [original, recrop] = calls();
    expect(original?.url).toBe(`${ROUTE}?original=1`);
    expect(original?.opts?.cache).toBe('no-cache');
    expect(mocks.openCropEditor).toHaveBeenCalledWith(expect.any(Blob), { shape: 'square', initialCrop: CROP });
    expect(recrop?.url).toBe(`${ROUTE}?crop=0,0,0.5,0.5`);
    expect(recrop?.opts?.method).toBe('POST');
    expect(recrop?.opts?.body).toBeUndefined();
  });

  it('resolves null and posts nothing when the re-crop dialog is cancelled', async () => {
    mocks.apiFetch.mockResolvedValueOnce(image(origBlob()));
    mocks.openCropEditor.mockResolvedValue(null);

    expect(await adjustPhoto(ROUTE, CROP, SHAPE)).toBeNull();
    expect(calls()).toHaveLength(1);
  });

  it.each([
    ['no crop at all', undefined],
    ['a crop outside the unit square', { x: -1, y: 0, w: 0.5, h: 0.5 }],
  ] as Array<[string, unknown]>)(
    'opens an older photo (%s) on the current image and saves it as a new photo plus original',
    async (_label, imageCrop) => {
      const storedResponse = json({ id: 7, imageCrop: CROP });
      mocks.apiFetch
        .mockResolvedValueOnce(image(mainBlob()))
        .mockResolvedValueOnce(json({ id: 7 }))
        .mockResolvedValueOnce(storedResponse);
      mocks.openCropEditor.mockResolvedValue(cropResult());

      expect(await adjustPhoto(ROUTE, imageCrop, SHAPE)).toBe(storedResponse);

      const [current, main, original] = calls();
      expect(current?.url).toBe(ROUTE);
      expect(current?.opts?.cache).toBe('no-cache');
      expect(mocks.openCropEditor).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({ shape: 'square' }));
      expect((mocks.openCropEditor.mock.calls[0]?.[1] as { initialCrop?: unknown }).initialCrop).toBeUndefined();
      expect(main?.url).toBe(ROUTE);
      expect(original?.url).toBe(`${ROUTE}?original=1&crop=${CROP_QUERY}`);
    },
  );

  it('falls back to the current image when the stored original is gone', async () => {
    const storedResponse = json({ id: 7, imageCrop: CROP });
    mocks.apiFetch
      .mockResolvedValueOnce(json({ error: 'no original' }, 404))
      .mockResolvedValueOnce(image(mainBlob()))
      .mockResolvedValueOnce(json({ id: 7 }))
      .mockResolvedValueOnce(storedResponse);
    mocks.openCropEditor.mockResolvedValue(cropResult());

    expect(await adjustPhoto(ROUTE, CROP, SHAPE)).toBe(storedResponse);

    const [missingOriginal, current, , original] = calls();
    expect(missingOriginal?.url).toBe(`${ROUTE}?original=1`);
    expect(current?.url).toBe(ROUTE);
    expect(original?.url).toBe(`${ROUTE}?original=1&crop=${CROP_QUERY}`);
    expect((mocks.openCropEditor.mock.calls[0]?.[1] as { initialCrop?: unknown }).initialCrop).toBeUndefined();
  });

  it('resolves the failed current-image GET without opening the dialog', async () => {
    const missing = json({ error: 'gone' }, 404);
    mocks.apiFetch.mockResolvedValueOnce(missing);

    expect(await adjustPhoto(ROUTE, undefined, SHAPE)).toBe(missing);
    expect(mocks.openCropEditor).not.toHaveBeenCalled();
  });

  it('ignores a second call while one is already running', async () => {
    let release: (value: CropEditorResult | null) => void = () => {};
    mocks.apiFetch.mockResolvedValueOnce(image(origBlob())).mockResolvedValueOnce(json({ id: 7 }));
    mocks.openCropEditor.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));

    const first = adjustPhoto(ROUTE, CROP, SHAPE);
    await vi.waitFor(() => { expect(mocks.openCropEditor).toHaveBeenCalledTimes(1); });

    expect(await adjustPhoto(ROUTE, CROP, SHAPE)).toBeNull();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);

    release(cropResult());
    await first;

    mocks.apiFetch.mockReset();
    mocks.openCropEditor.mockReset();
    mocks.apiFetch.mockResolvedValueOnce(image(origBlob())).mockResolvedValueOnce(json({ id: 7 }));
    mocks.openCropEditor.mockResolvedValue(cropResult());
    expect(await adjustPhoto(ROUTE, CROP, SHAPE)).not.toBeNull();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  });
});

describe('savedPhotoRow', () => {
  it('parses the entity JSON of a successful response', async () => {
    expect(await savedPhotoRow<{ id: number; name: string }>(json({ id: 7, name: 'Niche' })))
      .toEqual({ id: 7, name: 'Niche' });
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('alerts the server error and resolves null on a failure', async () => {
    expect(await savedPhotoRow(json({ error: 'no original' }, 409))).toBeNull();
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(String(alertMock.mock.calls[0]?.[0])).toContain('no original');
  });
});

describe('libraryImageUrl', () => {
  it('builds the photo route for a library kind', () => {
    expect(libraryImageUrl('puckscreen', 7)).toBe('api/library/puckscreen/7/image');
  });
});
