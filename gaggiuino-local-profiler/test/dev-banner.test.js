// #683: persistent yellow "UNSTABLE DEV BUILD" banner, shown only on the
// dev-channel image (driven by s.devBuild from GET /api/status).
import { describe, it, expect, beforeEach } from 'vitest';

const { showDevBuildBanner, devBannerHeight } = await import('../public-src/components/dev-banner.js');

function makeFakeDocument() {
  const registry = new Map();
  const body = {
    insertAdjacentElement: (_pos, el) => { registry.set(el.id, el); },
  };
  return {
    body,
    getElementById: id => registry.get(id),
    createElement: () => ({ style: {}, textContent: '' }),
  };
}

describe('dev-build banner (#683)', () => {
  let doc;

  beforeEach(() => {
    doc = makeFakeDocument();
    globalThis.document = doc;
  });

  it('creates a banner with the expected warning text', () => {
    showDevBuildBanner();
    const banner = doc.getElementById('glpDevBanner');
    expect(banner).toBeDefined();
    expect(banner.textContent).toBe('⚠ UNSTABLE DEV BUILD');
  });

  it('uses a yellow background with black text', () => {
    showDevBuildBanner();
    const banner = doc.getElementById('glpDevBanner');
    expect(banner.style.background).toBe('#f5c518');
    expect(banner.style.color).toBe('#000');
  });

  it('is idempotent -- calling it twice does not create a second banner', () => {
    showDevBuildBanner();
    const first = doc.getElementById('glpDevBanner');
    showDevBuildBanner();
    expect(doc.getElementById('glpDevBanner')).toBe(first);
  });

  it('devBannerHeight() reads the banner\'s offsetHeight once created', () => {
    showDevBuildBanner();
    doc.getElementById('glpDevBanner').offsetHeight = 32;
    expect(devBannerHeight()).toBe(32);
  });

  it('devBannerHeight() is 0 when no banner exists (real installs)', () => {
    expect(devBannerHeight()).toBe(0);
  });
});
