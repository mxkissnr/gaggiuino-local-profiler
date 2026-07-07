// First-run onboarding + demo mode UI (#274).
import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';

const DISMISS_KEY = 'glp_onboarding_banner_dismissed';

// ── "Machine unreachable" banner ────────────────────────────────────────
// Dismissible per session (sessionStorage), styled the same way as the
// update-available banner (components/update-check.js) so both can coexist
// stacked at the top of the page.
export function updateMachineBanner(status) {
  S.machineReachable = status.machineReachable;

  const existing = document.getElementById('glpOnboardingBanner');
  const shouldShow = status.machineReachable === false && !sessionStorage.getItem(DISMISS_KEY);

  if (!shouldShow) {
    existing?.remove();
    return;
  }
  if (existing) return; // already shown this session

  const banner = document.createElement('div');
  banner.id = 'glpOnboardingBanner';
  Object.assign(banner.style, {
    position: 'fixed', left: '0', right: '0', zIndex: '9997',
    top: `${document.getElementById('glpUpdateBanner')?.offsetHeight || 0}px`,
    background: '#3f3f46', color: '#e4e4e7',
    padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '12px',
    fontSize: '.875rem', fontWeight: '500', boxShadow: '0 2px 8px rgba(0,0,0,.35)',
  });

  const host = status.machineHostname || 'machine_host';
  const msg = document.createElement('span');
  msg.style.flex = '1';
  msg.textContent = t('onboarding_banner_msg', host);

  const wikiLink = document.createElement('a');
  wikiLink.href = 'https://github.com/mxkissnr/gaggiuino-local-profiler/wiki';
  wikiLink.target = '_blank';
  wikiLink.rel = 'noopener';
  wikiLink.textContent = t('onboarding_wiki_link');
  Object.assign(wikiLink.style, { color: '#e4e4e7', fontSize: '.8rem', textDecoration: 'underline', whiteSpace: 'nowrap' });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, { background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: '#e4e4e7', padding: '0 2px' });
  closeBtn.addEventListener('click', () => {
    sessionStorage.setItem(DISMISS_KEY, '1');
    banner.remove();
  });

  banner.append(msg, wikiLink, closeBtn);
  document.body.insertAdjacentElement('afterbegin', banner);
}

// ── First-run onboarding panel (shown inside #empty-state) ─────────────
// Shown when there are zero shots AND the machine has never been reachable.
export function updateOnboardingPanel() {
  const panel = document.getElementById('onboarding-panel');
  if (!panel) return;
  const show = S.shots.length === 0 && S.machineReachable === false;
  panel.style.display = show ? 'flex' : 'none';
}

export async function loadDemoData() {
  const btn = document.getElementById('onboardingDemoBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('onboarding_demo_loading'); }
  try {
    const r = await apiFetch('api/demo/seed', { method: 'POST' });
    if (r.ok) {
      if (window.loadData) await window.loadData();
      if (window.loadLibrary) await window.loadLibrary();
      updateDemoBadge(true);
    } else if (btn) {
      btn.disabled = false; btn.textContent = t('onboarding_demo_btn');
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = t('onboarding_demo_btn'); }
  }
}

export async function endDemo() {
  if (!confirm(t('demo_mode_end_confirm'))) return;
  try {
    const r = await apiFetch('api/demo/end', { method: 'POST' });
    if (r.ok) {
      updateDemoBadge(false);
      if (window.loadData) await window.loadData();
      if (window.loadLibrary) await window.loadLibrary();
    }
  } catch (e) {}
}

// ── "Demo mode" badge ────────────────────────────────────────────────────
export function updateDemoBadge(isDemo) {
  S.isDemo = !!isDemo;
  const badge = document.getElementById('glpDemoBadge');
  if (badge) badge.style.display = S.isDemo ? 'flex' : 'none';
}
