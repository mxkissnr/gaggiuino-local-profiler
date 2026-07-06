const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { BEAN_IMAGE_DIR, ALLOWED_IMAGE_HOSTS, BEAN_IMAGE_MAX_BYTES } = require('../constants');
const { log } = require('../helpers');

const CONTENT_TYPE_EXT = {
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/webp': 'webp',
    'image/gif':  'gif',
};

// Protocol-relative shop CDN URLs ("//cdn.shopify.com/...") → https.
function normalizeImageUrl(url) {
    if (typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (trimmed.startsWith('//')) return 'https:' + trimmed;
    return trimmed;
}

function isAllowedImageUrl(url) {
    try {
        const u = new URL(url);
        return ['http:', 'https:'].includes(u.protocol) && ALLOWED_IMAGE_HOSTS.includes(u.hostname);
    } catch { return false; }
}

function imagePath(beanId, ext) {
    return path.join(BEAN_IMAGE_DIR, `${beanId}.${ext}`);
}

// Downloads a bean image once, validating hard against SSRF: exact host
// allowlist, no redirect following (Shopify/kaffeebraun CDN URLs are direct),
// a size cap, and an image content-type whitelist. The filename is derived
// from the (already-numeric) bean id, never from the URL. Returns the file
// extension on success, or null (never throws — caller treats this as
// best-effort).
async function fetchBeanImage(beanId, imageUrl) {
    const url = normalizeImageUrl(imageUrl);
    if (!url || !isAllowedImageUrl(url)) return null;
    try {
        const r = await axios.get(url, {
            responseType: 'arraybuffer',
            maxRedirects: 0,
            maxContentLength: BEAN_IMAGE_MAX_BYTES,
            timeout: 8000,
            headers: { 'User-Agent': 'GLP/1.0 (Gaggiuino Local Profiler; private use)' },
            validateStatus: s => s === 200,
        });
        const contentType = String(r.headers['content-type'] || '').split(';')[0].trim();
        const ext = CONTENT_TYPE_EXT[contentType];
        if (!ext || !Buffer.isBuffer(r.data) || r.data.length === 0 || r.data.length > BEAN_IMAGE_MAX_BYTES) return null;
        fs.mkdirSync(BEAN_IMAGE_DIR, { recursive: true });
        fs.writeFileSync(imagePath(beanId, ext), r.data);
        return ext;
    } catch (e) {
        log(`Bean image download failed for bean ${beanId}: ${e.message}`, true);
        return null;
    }
}

function deleteBeanImage(beanId, ext) {
    if (!ext) return;
    try { fs.unlinkSync(imagePath(beanId, ext)); } catch { /* already gone */ }
}

module.exports = { fetchBeanImage, deleteBeanImage, imagePath, isAllowedImageUrl, normalizeImageUrl, CONTENT_TYPE_EXT };
