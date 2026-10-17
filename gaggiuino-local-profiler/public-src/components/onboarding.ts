// First-run onboarding + demo mode UI (#274).
import { S } from '../state/index.js';
import { t } from '../i18n.js';
import { seedDemoData, endDemoData } from '../api/system.js';
import { devBannerHeight } from './dev-banner.js';
import { themeColor } from '../utils.js';
import { CLOSE_ICON_SVG } from '../icons.js';
import { safeSessionStorage } from '../storage.js';

const DISMISS_KEY = 'glp_onboarding_banner_dismissed';

interface StatusLike {
  machineReachable?: boolean | null;
  machineHostname?: string | null;
}

// ── "Machine unreachable" banner ────────────────────────────────────────
// Dismissible per session (sessionStorage), styled the same way as the
// update-available banner (components/update-check.ts) so both can coexist
// stacked at the top of the page.
export function updateMachineBanner(status: StatusLike | null = null): void {
  // status is optional: callers that just want to re-evaluate the banner after
  // S.shots changed (e.g. loadData() once shots finish loading) can call this
  // with no argument to reuse the last known machineReachable/hostname state,
  // instead of waiting for the next status poll.
  if (status) S.machineReachable = status.machineReachable ?? null;

  const existing = document.getElementById('glpOnboardingBanner');
  const shouldShow = S.shots.length === 0 && S.machineReachable === false && !safeSessionStorage.getItem(DISMISS_KEY);

  if (!shouldShow) {
    existing?.remove();
    return;
  }
  if (existing) return; // already shown this session

  const banner = document.createElement('div');
  banner.id = 'glpOnboardingBanner';
  Object.assign(banner.style, {
    position: 'fixed', left: '0', right: '0', zIndex: '9997',
    top: `${devBannerHeight() + (document.getElementById('glpUpdateBanner')?.offsetHeight || 0)}px`,
    // #814: was a hardcoded dark surface + light text, so these banners
  // stayed dark-on-dark chips on a light page. --raised/--gray-200 are the
  // themed equivalents of exactly those two values.
  background: themeColor('--raised', '#3f3f46'), color: themeColor('--gray-200', '#e4e4e7'),
    padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '12px',
    fontSize: '.875rem', fontWeight: '500', boxShadow: '0 2px 8px rgba(0,0,0,.35)',
  });

  const host = status?.machineHostname || t('onboarding_banner_host_fallback');
  const msg = document.createElement('span');
  msg.style.flex = '1';
  msg.textContent = t('onboarding_banner_msg', host);

  const wikiLink = document.createElement('a');
  wikiLink.href = 'https://github.com/mxkissnr/gaggiuino-local-profiler/wiki';
  wikiLink.target = '_blank';
  wikiLink.rel = 'noopener';
  wikiLink.textContent = t('onboarding_wiki_link');
  Object.assign(wikiLink.style, { color: themeColor('--gray-200', '#e4e4e7'), fontSize: '.8rem', textDecoration: 'underline', whiteSpace: 'nowrap' });

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = CLOSE_ICON_SVG;
  Object.assign(closeBtn.style, { background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: themeColor('--gray-200', '#e4e4e7'), padding: '0 2px' });
  closeBtn.addEventListener('click', () => {
    safeSessionStorage.setItem(DISMISS_KEY, '1');
    banner.remove();
  });

  banner.append(msg, wikiLink, closeBtn);
  document.body.insertAdjacentElement('afterbegin', banner);
}

// ── First-run onboarding panel (shown inside #empty-state) ─────────────
// Shown when there are zero shots AND the machine has never been reachable.
export function updateOnboardingPanel(): void {
  const panel = document.getElementById('onboarding-panel');
  if (!panel) return;
  const show = S.shots.length === 0 && S.machineReachable === false;
  panel.style.display = show ? 'flex' : 'none';
}

export async function loadDemoData(): Promise<void> {
  const btn = document.getElementById('onboardingDemoBtn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = t('onboarding_demo_loading'); }
  try {
    const r = await seedDemoData();
    if (r.ok) {
      if (window.loadData) await window.loadData();
      if (window.loadLibrary) await window.loadLibrary();
      updateDemoBadge(true);
    } else if (btn) {
      btn.disabled = false; btn.textContent = t('onboarding_demo_btn');
    }
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = t('onboarding_demo_btn'); }
  }
}

export async function endDemo(): Promise<void> {
  if (!confirm(t('demo_mode_end_confirm'))) return;
  try {
    const r = await endDemoData();
    if (r.ok) {
      updateDemoBadge(false);
      if (window.loadData) await window.loadData();
      if (window.loadLibrary) await window.loadLibrary();
    }
  } catch { /* ignore */ }
}

// ── "Demo mode" badge ────────────────────────────────────────────────────
export function updateDemoBadge(isDemo: unknown): void {
  S.isDemo = !!isDemo;
  const badge = document.getElementById('glpDemoBadge');
  if (badge) badge.style.display = S.isDemo ? 'flex' : 'none';
}
