// #683: persistent identity marker for the dev-channel image, so it's never
// mistaken for a real release build. Non-dismissible -- unlike the
// update-available (components/update-check.js) and machine-unreachable
// (components/onboarding.js) banners, this describes a fact about the build
// itself for the whole session, not a transient/actionable state the user
// might want to hide. Styled to match the existing yellow update banner
// (same accent color / dark text), positioned above it so it reads as the
// most fundamental of the stacked banners.
// #704 follow-up: takes the same `devBuild` string already shown in the
// small version-badge suffix (e.g. "dev-20260809_0800") and repeats it here
// too -- the badge is easy to miss, this banner isn't, and telling two
// dev builds apart at a glance (did my latest push actually land?) was
// otherwise only possible by digging into the version badge or the
// container tag.
import { WARNING_ICON_SVG } from '../icons.js';

export function showDevBuildBanner(devBuild) {
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
  // #811: the ⚠ glyph becomes the drawn warning icon. innerHTML is safe here
  // -- devBuild comes from the build metadata, and is escaped anyway.
  banner.innerHTML = `${WARNING_ICON_SVG} UNSTABLE DEV BUILD` +
    (devBuild ? ` (${String(devBuild).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))})` : '');
  document.body.insertAdjacentElement('afterbegin', banner);
  // #683 follow-up: body is `height: 100vh; overflow: hidden` with global
  // `box-sizing: border-box` (style.css), so padding-top here shrinks the
  // flex layout's available height by the banner's own height instead of
  // pushing it off-screen -- the fixed banner would otherwise sit on top of
  // (not above) the topbar/sidebar, hiding the nav entirely rather than
  // just visually overlapping a corner of it.
  document.body.style.paddingTop = `${banner.offsetHeight}px`;
  // #861: on mobile, #main and #sidebar switch to `position: fixed; inset:
  // 0` (style.css, full-screen views below the 640px breakpoint), which
  // positions them against the viewport rather than body's content box --
  // body's padding-top above has zero effect on them there, so the banner
  // sits on top of (and hides) the topbar/sidebar header instead of pushing
  // it down. An inline `top` always wins over the mobile media query's
  // `inset: 0` shorthand, so set it directly; on desktop neither element has
  // an explicit `position` (default `static`), so this is a harmless no-op
  // there.
  const mainEl = document.getElementById('main');
  if (mainEl) mainEl.style.top = `${banner.offsetHeight}px`;
  const sidebarEl = document.getElementById('sidebar');
  if (sidebarEl) sidebarEl.style.top = `${banner.offsetHeight}px`;
}

// Other fixed banners (update-available, machine-unreachable) stack off of
// each other's offsetHeight -- this is the topmost one, so callers computing
// their own `top` offset should add this alongside glpUpdateBanner's height.
export function devBannerHeight() {
  return document.getElementById('glpDevBanner')?.offsetHeight || 0;
}
