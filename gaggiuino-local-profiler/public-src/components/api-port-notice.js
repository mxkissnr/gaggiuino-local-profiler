// #807: explaining the "expose_api_port is off and this session isn't
// Ingress" state wherever it is actually noticed, instead of only in the
// Settings API-token card (#803). Two surfaces, one message:
//   - apiPortClosedHtml(): the in-view replacement for a raw "HTTP 401",
//     used by the Shots view (the landing view, so it is where the failure
//     is seen first).
//   - updateApiPortClosedBanner(): an app-wide, dismissible banner, because
//     most other views don't render an error at all in this state — they
//     just come up empty (library, orders, maintenance, analytics all
//     `return` on a failed fetch), which is just as unexplained.
import { t } from '../i18n.js';
import { isApiPortBlocked } from '../api.js';
import { devBannerHeight } from './dev-banner.js';

const DISMISS_KEY = 'glp_api_port_closed_banner_dismissed';

export function apiPortClosedHtml() {
  return `<div class="loading-state" style="max-width:520px;margin:0 auto;text-align:center">
    <div style="font-weight:600;margin-bottom:6px">${t('api_port_closed_title')}</div>
    <div style="font-size:.85rem;line-height:1.45">${t('api_port_closed_desc')}</div>
    <button data-action="goto-settings" style="margin-top:12px;padding:4px 12px;cursor:pointer;
      background:rgba(63,63,70,.5);color:#a1a1aa;border:1px solid #3f3f46;border-radius:6px;
      font-family:Figtree,sans-serif;font-size:.8rem">${t('api_port_closed_settings_btn')}</button>
  </div>`;
}

// Same shape/stacking convention as the machine-unreachable and legacy-
// machine-options banners in components/onboarding.js. Called from the
// status poll, right after S.apiPortExposed is refreshed, so it appears as
// soon as /api/status (which stays public precisely for this) answers.
export function updateApiPortClosedBanner() {
  const existing = document.getElementById('glpApiPortClosedBanner');
  const shouldShow = isApiPortBlocked() && !sessionStorage.getItem(DISMISS_KEY);

  if (!shouldShow) {
    existing?.remove();
    return;
  }
  if (existing) return; // already shown this session

  const banner = document.createElement('div');
  banner.id = 'glpApiPortClosedBanner';
  Object.assign(banner.style, {
    position: 'fixed', left: '0', right: '0', zIndex: '9995',
    top: `${devBannerHeight()
      + (document.getElementById('glpUpdateBanner')?.offsetHeight || 0)
      + (document.getElementById('glpOnboardingBanner')?.offsetHeight || 0)
      + (document.getElementById('glpLegacyMachineOptionsBanner')?.offsetHeight || 0)}px`,
    background: '#3f3f46', color: '#e4e4e7',
    padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '12px',
    fontSize: '.875rem', fontWeight: '500', boxShadow: '0 2px 8px rgba(0,0,0,.35)',
  });

  const msg = document.createElement('span');
  msg.style.flex = '1';
  msg.textContent = t('api_port_closed_desc');

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.dataset.action = 'goto-settings';
  settingsBtn.textContent = t('api_port_closed_settings_btn');
  Object.assign(settingsBtn.style, {
    background: 'rgba(0,0,0,.25)', color: '#e4e4e7', border: '1px solid #52525b',
    borderRadius: '6px', padding: '3px 10px', cursor: 'pointer',
    fontSize: '.8rem', whiteSpace: 'nowrap',
  });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, { background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: '#e4e4e7', padding: '0 2px' });
  closeBtn.addEventListener('click', () => {
    sessionStorage.setItem(DISMISS_KEY, '1');
    banner.remove();
  });

  banner.append(msg, settingsBtn, closeBtn);
  document.body.insertAdjacentElement('afterbegin', banner);
}
