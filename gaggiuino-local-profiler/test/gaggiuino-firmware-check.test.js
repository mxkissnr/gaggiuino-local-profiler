import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Same require-cache mocking pattern as test/import-route.test.js — no real
// GitHub API calls from this unit test.
const axiosPath = require.resolve('axios');
const axiosGet  = vi.fn();
require.cache[axiosPath] = { exports: { get: axiosGet, default: { get: axiosGet } } };

const { getLatestFirmwareRelease, CHANNEL_TAG_PREFIX, _resetCacheForTests } = require('../lib/machines/gaggiuino/firmware-check');

function ghRelease(tag, publishedAt) {
    return { tag_name: tag, published_at: publishedAt, html_url: `https://github.com/Zer0-bit/gaggiuino/releases/tag/${tag}` };
}

beforeEach(() => {
    axiosGet.mockReset();
    _resetCacheForTests();
});

describe('getLatestFirmwareRelease (#620)', () => {
    it('picks the newest main-* release for channel 0 (stable)', async () => {
        axiosGet.mockResolvedValue({ data: [
            ghRelease('main-aaaaaaa', '2026-08-01T00:00:00Z'),
            ghRelease('main-7889b7d', '2026-08-02T00:00:00Z'),
            ghRelease('dev-cccccccc', '2026-08-03T00:00:00Z'),
        ] });
        const result = await getLatestFirmwareRelease(0);
        expect(result).toEqual({
            hash: '7889b7d',
            publishedAt: '2026-08-02T00:00:00Z',
            releaseUrl: 'https://github.com/Zer0-bit/gaggiuino/releases/tag/main-7889b7d',
        });
    });

    it('channel 1 (test) also draws from main-*, per the documented assumption', async () => {
        axiosGet.mockResolvedValue({ data: [ghRelease('main-1234567', '2026-08-01T00:00:00Z')] });
        const result = await getLatestFirmwareRelease(1);
        expect(result.hash).toBe('1234567');
        expect(CHANNEL_TAG_PREFIX[1]).toBe('main-');
    });

    it('channel 2 (debug) draws from dev-*', async () => {
        axiosGet.mockResolvedValue({ data: [
            ghRelease('main-1234567', '2026-08-02T00:00:00Z'),
            ghRelease('dev-89abcde', '2026-08-01T00:00:00Z'),
        ] });
        const result = await getLatestFirmwareRelease(2);
        expect(result.hash).toBe('89abcde');
    });

    it('returns null when no release matches the channel prefix', async () => {
        axiosGet.mockResolvedValue({ data: [ghRelease('main-1234567', '2026-08-01T00:00:00Z')] });
        const result = await getLatestFirmwareRelease(2);
        expect(result).toBeNull();
    });

    it('propagates a GitHub API failure to the caller (route layer turns it into a 502)', async () => {
        axiosGet.mockRejectedValue(new Error('network error'));
        await expect(getLatestFirmwareRelease(0)).rejects.toThrow('network error');
    });

    it('caches per channel — a second call within the TTL does not re-fetch', async () => {
        axiosGet.mockResolvedValue({ data: [ghRelease('main-1234567', '2026-08-01T00:00:00Z')] });
        await getLatestFirmwareRelease(0);
        await getLatestFirmwareRelease(0);
        expect(axiosGet).toHaveBeenCalledTimes(1);
    });

    it('does not share a cached result across different channels', async () => {
        axiosGet.mockResolvedValueOnce({ data: [ghRelease('main-1111111', '2026-08-01T00:00:00Z')] });
        axiosGet.mockResolvedValueOnce({ data: [ghRelease('dev-2222222', '2026-08-01T00:00:00Z')] });
        const stable = await getLatestFirmwareRelease(0);
        const debug  = await getLatestFirmwareRelease(2);
        expect(stable.hash).toBe('1111111');
        expect(debug.hash).toBe('2222222');
        expect(axiosGet).toHaveBeenCalledTimes(2);
    });

    it('falls back to channel 0 (stable) for an unrecognized channel value', async () => {
        axiosGet.mockResolvedValue({ data: [ghRelease('main-1234567', '2026-08-01T00:00:00Z')] });
        const result = await getLatestFirmwareRelease(99);
        expect(result.hash).toBe('1234567');
    });
});
