import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
const require = createRequire(import.meta.url);

const tmpDir = mkdtempSync(path.join(tmpdir(), 'glp-bean-images-'));

// Redirect bean image storage to a scratch dir and mock axios before
// requiring ImageService, same require-cache pattern as geo.test.js.
const constantsPath = require.resolve('../lib/constants');
const realConstants = require(constantsPath);
require.cache[constantsPath].exports = {
    ...realConstants,
    BEAN_IMAGE_DIR: tmpDir,
    ALLOWED_IMAGE_HOSTS: ['kaffeebraun.com', 'cdn.shopify.com'],
    BEAN_IMAGE_MAX_BYTES: 1024, // small cap to make the size-rejection test cheap
};

const axiosPath = require.resolve('axios');
const axiosGet  = vi.fn();
require.cache[axiosPath] = { exports: { get: axiosGet, default: { get: axiosGet } } };

const { fetchBeanImage, deleteBeanImage, imagePath, isAllowedImageUrl, saveUploadedImage, deleteImage } = require('../lib/services/ImageService');

beforeEach(() => axiosGet.mockReset());
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

describe('isAllowedImageUrl', () => {
    it('accepts allowlisted hosts, rejects everything else', () => {
        expect(isAllowedImageUrl('https://cdn.shopify.com/foo.jpg')).toBe(true);
        expect(isAllowedImageUrl('https://evil.example.com/foo.jpg')).toBe(false);
        expect(isAllowedImageUrl('ftp://cdn.shopify.com/foo.jpg')).toBe(false);
        expect(isAllowedImageUrl('not a url')).toBe(false);
    });
});

describe('fetchBeanImage', () => {
    it('downloads and writes the file, returning the extension', async () => {
        const buf = Buffer.from('fake-jpeg-bytes');
        axiosGet.mockResolvedValueOnce({ headers: { 'content-type': 'image/jpeg' }, data: buf });
        const ext = await fetchBeanImage(1, 'https://cdn.shopify.com/img.jpg');
        expect(ext).toBe('jpg');
        expect(existsSync(imagePath(1, 'jpg'))).toBe(true);
    });

    it('rejects disallowed hosts without making a request', async () => {
        const ext = await fetchBeanImage(2, 'https://evil.example.com/img.jpg');
        expect(ext).toBeNull();
        expect(axiosGet).not.toHaveBeenCalled();
    });

    it('rejects non-image content types', async () => {
        axiosGet.mockResolvedValueOnce({ headers: { 'content-type': 'text/html' }, data: Buffer.from('<html>') });
        expect(await fetchBeanImage(3, 'https://cdn.shopify.com/img.jpg')).toBeNull();
    });

    it('rejects oversized bodies even if the server lies in headers', async () => {
        const big = Buffer.alloc(2048, 1); // exceeds the 1024-byte test cap
        axiosGet.mockResolvedValueOnce({ headers: { 'content-type': 'image/jpeg' }, data: big });
        expect(await fetchBeanImage(4, 'https://cdn.shopify.com/img.jpg')).toBeNull();
    });

    it('normalizes protocol-relative URLs before validating the host', async () => {
        axiosGet.mockResolvedValueOnce({ headers: { 'content-type': 'image/png' }, data: Buffer.from('x') });
        const ext = await fetchBeanImage(5, '//cdn.shopify.com/img.png');
        expect(ext).toBe('png');
        expect(axiosGet).toHaveBeenCalledWith('https://cdn.shopify.com/img.png', expect.any(Object));
    });

    it('tolerates network errors', async () => {
        axiosGet.mockRejectedValueOnce(new Error('timeout'));
        expect(await fetchBeanImage(6, 'https://cdn.shopify.com/img.jpg')).toBeNull();
    });
});

describe('deleteBeanImage', () => {
    it('removes the file and is a no-op when already gone', async () => {
        axiosGet.mockResolvedValueOnce({ headers: { 'content-type': 'image/webp' }, data: Buffer.from('x') });
        await fetchBeanImage(7, 'https://cdn.shopify.com/img.webp');
        expect(existsSync(imagePath(7, 'webp'))).toBe(true);
        deleteBeanImage(7, 'webp');
        expect(existsSync(imagePath(7, 'webp'))).toBe(false);
        expect(() => deleteBeanImage(7, 'webp')).not.toThrow();
    });
});

// Direct-upload path used by grinder photos (no URL fetch, so no SSRF
// surface — but the same content-type whitelist and size cap apply).
describe('saveUploadedImage', () => {
    it('writes the buffer under a prefixed filename and returns the extension', () => {
        const ext = saveUploadedImage('grinder-', 42, Buffer.from('fake-png-bytes'), 'image/png');
        expect(ext).toBe('png');
        expect(existsSync(imagePath(42, 'png', 'grinder-'))).toBe(true);
        // a bean image with the same numeric id never collides
        expect(imagePath(42, 'png', 'grinder-')).not.toBe(imagePath(42, 'png'));
    });

    it('rejects unsupported content types', () => {
        expect(saveUploadedImage('grinder-', 43, Buffer.from('<html>'), 'text/html')).toBeNull();
    });

    it('rejects oversized buffers', () => {
        const big = Buffer.alloc(2048, 1); // exceeds the 1024-byte test cap
        expect(saveUploadedImage('grinder-', 44, big, 'image/jpeg')).toBeNull();
    });

    it('rejects empty buffers', () => {
        expect(saveUploadedImage('grinder-', 45, Buffer.alloc(0), 'image/jpeg')).toBeNull();
    });

    // CodeQL js/type-confusion-through-parameter-tampering: a body parser
    // upstream of the raw-body route could hand this a non-Buffer (e.g. an
    // array/object from a JSON payload) or a repeated-header array as the
    // content-type. Both must be rejected outright, not coerced.
    it('rejects a non-Buffer body (array/object type confusion)', () => {
        expect(saveUploadedImage('grinder-', 47, ['image/png', 'fake'], 'image/png')).toBeNull();
        expect(saveUploadedImage('grinder-', 48, { length: 3 }, 'image/png')).toBeNull();
    });

    it('rejects a non-string content type (array/object type confusion)', () => {
        expect(saveUploadedImage('grinder-', 49, Buffer.from('x'), ['image/png', 'text/html'])).toBeNull();
        expect(saveUploadedImage('grinder-', 50, Buffer.from('x'), { toString: () => 'image/png' })).toBeNull();
    });
});

describe('deleteImage (prefixed)', () => {
    it('removes a prefixed file and is a no-op when already gone', () => {
        saveUploadedImage('grinder-', 46, Buffer.from('x'), 'image/webp');
        expect(existsSync(imagePath(46, 'webp', 'grinder-'))).toBe(true);
        deleteImage(46, 'webp', 'grinder-');
        expect(existsSync(imagePath(46, 'webp', 'grinder-'))).toBe(false);
        expect(() => deleteImage(46, 'webp', 'grinder-')).not.toThrow();
    });
});
