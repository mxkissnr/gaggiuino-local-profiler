import { apiFetch } from '../api.js';
import { t } from '../i18n.js';

export async function checkForUpdate() {
    try {
        const r = await apiFetch('api/version');
        if (!r.ok) return;
        const data = await r.json();
        if (data.update_available) showUpdateBanner(data);
    } catch (_) {}
}

function showUpdateBanner({ current, latest, release_url }) {
    if (document.getElementById('glpUpdateBanner')) return;

    const banner = document.createElement('div');
    banner.id = 'glpUpdateBanner';
    Object.assign(banner.style, {
        position: 'fixed', top: '0', left: '0', right: '0', zIndex: '9998',
        background: 'var(--accent-color, #f59e0b)', color: '#1c1917',
        padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '12px',
        fontSize: '.875rem', fontWeight: '500', boxShadow: '0 2px 8px rgba(0,0,0,.35)',
    });

    const msg = document.createElement('span');
    msg.style.flex = '1';
    msg.textContent = t('update_banner', current, latest);

    const installBtn = document.createElement('button');
    installBtn.textContent = t('update_install');
    Object.assign(installBtn.style, {
        background: '#1c1917', color: '#fef3c7', border: 'none', borderRadius: '6px',
        padding: '4px 14px', cursor: 'pointer', fontSize: '.85rem', fontWeight: '600',
    });

    const changelogLink = document.createElement('a');
    changelogLink.href = release_url;
    changelogLink.target = '_blank';
    changelogLink.rel = 'noopener';
    changelogLink.textContent = t('update_changelog');
    Object.assign(changelogLink.style, {
        color: '#1c1917', fontSize: '.8rem', textDecoration: 'underline', whiteSpace: 'nowrap',
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
        background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: '#1c1917', padding: '0 2px',
    });
    closeBtn.addEventListener('click', () => banner.remove());

    installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        installBtn.textContent = t('update_installing');
        try {
            const r = await apiFetch('api/update', { method: 'POST' });
            if (r.ok) {
                installBtn.textContent = t('update_success');
                banner.style.background = '#22c55e';
            } else {
                installBtn.textContent = t('update_error');
                installBtn.disabled = false;
            }
        } catch (_) {
            installBtn.textContent = t('update_error');
            installBtn.disabled = false;
        }
    });

    banner.append(msg, installBtn, changelogLink, closeBtn);
    document.body.insertAdjacentElement('afterbegin', banner);
}
