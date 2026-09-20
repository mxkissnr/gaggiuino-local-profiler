// #683: persistent yellow "UNSTABLE DEV BUILD" banner, shown only on the
// dev-channel image (driven by s.devBuild from GET /api/status).
import { describe, it, expect, beforeEach } from 'vitest';

const { showDevBuildBanner, devBannerHeight } = await import('../public-src/components/dev-banner.js');

function makeFakeDocument() {
  const registry = new Map();
  const body = {
    style: {},
    insertAdjacentElement: (_pos, el) => { registry.set(el.id, el); },
  };
  return {
    body,
    getElementById: id => registry.get(id),
    createElement: () => ({ style: {}, textContent: '', innerHTML: '', offsetHeight: 34 }),
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
    // #811: the ⚠ text glyph is now the drawn warning icon, so the banner
    // is built with innerHTML. Assert on both parts rather than one string:
    // an icon that silently stops rendering should fail this test.
    expect(banner.innerHTML).toContain('UNSTABLE DEV BUILD');
    expect(banner.innerHTML).toContain('<svg');
    expect(banner.innerHTML).not.toContain('⚠');
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

  // Reported by Max on GLP DEV: the banner sat on top of (not above) the
  // topbar/menus, hiding them entirely instead of just occupying its own
  // strip at the top of the page.
  it('pushes page content down by the banner height instead of overlaying it', () => {
    showDevBuildBanner();
    expect(doc.body.style.paddingTop).toBe('34px');
  });

  it('devBannerHeight() is 0 when no banner exists (real installs)', () => {
    expect(devBannerHeight()).toBe(0);
  });

  // #704 follow-up: shows which dev build is actually running, so it's
  // immediately visible from the banner alone (previously only in the
  // small version-badge suffix).
  it('appends the devBuild string to the banner text when given', () => {
    showDevBuildBanner('dev-20260809_0800');
    const banner = doc.getElementById('glpDevBanner');
    expect(banner.innerHTML).toContain('UNSTABLE DEV BUILD (dev-20260809_0800)');
    expect(banner.innerHTML).toContain('<svg');
  });
});
