// #683: persistent identity marker for the dev-channel image, so it's never
// mistaken for a real release build. Non-dismissible -- unlike the
// update-available (components/update-check.js) and machine-unreachable
// (components/onboarding.js) banners, this describes a fact about the build
// itself for the whole session, not a transient/actionable state the user
// might want to hide. Styled to match the existing yellow update banner
// (same accent color / dark text), positioned above it so it reads as the
// most fundamental of the stacked banners.
export function showDevBuildBanner() {
  if (document.getElementById('glpDevBanner')) return;

  const banner = document.createElement('div');
  banner.id = 'glpDevBanner';
  Object.assign(banner.style, {
    position: 'fixed', top: '0', left: '0', right: '0', zIndex: '9999',
    background: '#f5c518', color: '#000',
    padding: '6px 16px', textAlign: 'center',
    fontSize: '.8rem', fontWeight: '700', letterSpacing: '.02em',
    boxShadow: '0 2px 8px rgba(0,0,0,.35)',
  });
  banner.textContent = '⚠ UNSTABLE DEV BUILD';
  document.body.insertAdjacentElement('afterbegin', banner);
}

// Other fixed banners (update-available, machine-unreachable) stack off of
// each other's offsetHeight -- this is the topmost one, so callers computing
// their own `top` offset should add this alongside glpUpdateBanner's height.
export function devBannerHeight() {
  return document.getElementById('glpDevBanner')?.offsetHeight || 0;
}
