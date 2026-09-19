import { getVersion } from '../api/system.js';
import { t } from '../i18n.js';
import { devBannerHeight } from './dev-banner.js';
import { CLOSE_ICON_SVG } from '../icons.js';

interface UpdateAvailablePayload {
    update_available?: boolean;
    current?: string;
    latest?: string;
    release_url?: string;
}

export async function checkForUpdate(): Promise<void> {
    try {
        const r = await getVersion();
        if (!r.ok) return;
        const data = await r.json() as UpdateAvailablePayload;
        if (data.update_available) {
            showUpdateBanner({
                current: data.current ?? '',
                latest: data.latest ?? '',
                release_url: data.release_url ?? '',
            });
        }
    } catch { /* ignore */ }
}

function showUpdateBanner({ current, latest, release_url }: { current: string; latest: string; release_url: string }): void {
    if (document.getElementById('glpUpdateBanner')) return;

    const banner = document.createElement('div');
    banner.id = 'glpUpdateBanner';
    Object.assign(banner.style, {
        position: 'fixed', top: `${devBannerHeight()}px`, left: '0', right: '0', zIndex: '9998',
        background: 'var(--accent)', color: 'var(--accent-text)',
        padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '12px',
        fontSize: '.875rem', fontWeight: '500', boxShadow: '0 2px 8px rgba(0,0,0,.35)',
    });

    const msg = document.createElement('span');
    msg.style.flex = '1';
    msg.textContent = `${t('update_banner', current, latest)} ${t('update_via_store')}`;

    const changelogLink = document.createElement('a');
    changelogLink.href = release_url;
    changelogLink.target = '_blank';
    changelogLink.rel = 'noopener';
    changelogLink.textContent = t('update_changelog');
    Object.assign(changelogLink.style, {
        color: '#1c1917', fontSize: '.8rem', textDecoration: 'underline', whiteSpace: 'nowrap',
    });

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = CLOSE_ICON_SVG;
    Object.assign(closeBtn.style, {
        background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: '#1c1917', padding: '0 2px',
    });
    closeBtn.addEventListener('click', () => banner.remove());

    banner.append(msg, changelogLink, closeBtn);
    document.body.insertAdjacentElement('afterbegin', banner);
}
