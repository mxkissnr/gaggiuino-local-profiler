// One modal drives both backup flows: choosing which of the six domains
// (see routes/backup.js's BACKUP_SECTIONS) to export, and — for restore —
// previewing exactly what a file would change before anything is written.
// A single shared implementation instead of two separate ones keeps the
// section list and its labels from drifting apart between export and
// restore, the same reasoning `lib/machines/options-adoption.js` documents
// for tracked options.
import { t } from '../i18n.js';
import { apiFetch, initToken } from '../api.js';
import { shareOrDownloadBlob } from '../utils.js';

const SECTION_KEYS = ['shots', 'maintenance', 'orders', 'machines', 'settings', 'secrets'];

// Filename-safe local-time timestamp, e.g. "2026-08-06_08-32-05" -- mirrors
// routes/backup.js's own backupTimestamp() (kept as two copies rather than
// one shared module since one runs in the browser and one in Node, same
// reasoning SECTION_PRESENCE_KEYS/SECTION_PRESENCE_BUNDLE_KEYS already
// accept). A bare date collapsed every backup taken the same day into one
// filename, forcing the browser to append "(1)"/"(2)" or overwrite silently.
function backupTimestamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// Which top-level backup keys prove a given section actually has data in a
// file being restored — mirrors routes/backup.js's SECTION_BUNDLE_KEYS.
// Used only to decide which restore checkboxes to offer; export always
// offers all six regardless of whether the *current* install has data in
// them (an empty section is still a valid, deliberate choice to make).
const SECTION_PRESENCE_KEYS = {
    shots:       ['shots'],
    maintenance: ['maintenance', 'maintenance_log'],
    orders:      ['orders'],
    machines:    ['machines'],
    settings:    ['kv'],
    secrets:     ['secrets'],
};

let mode = null;       // 'export' | 'restore'
let restoreBundle = null;    // legacy .json restore: the parsed bundle
let restoreZipBytes = null;  // .zip restore: the raw file bytes -- mutually exclusive with restoreBundle
let previewDebounce = null;

// Enter in the passphrase/confirm-passphrase input has no default browser
// behavior to fall back on here -- the modal is deliberately not a <form>
// (the section checkboxes/preview wiring below assumes plain buttons, and
// turning it into one would submit-navigate on Enter from *any* focused
// field, not just these two) so Enter is otherwise a silent no-op. Wired
// once at import time since #backupModal is static markup in index.html,
// not created/destroyed per open like the section checkboxes are.
document.getElementById('backupModal')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    document.getElementById('backupModalConfirmBtn')?.click();
});

function els() {
    return {
        modal:        document.getElementById('backupModal'),
        title:        document.getElementById('backupModalTitle'),
        desc:         document.getElementById('backupModalDesc'),
        sectionsBox:  document.getElementById('backupModalSections'),
        secretsRow:   document.getElementById('backupSecretsRow'),
        secretsCb:    document.getElementById('backupSecretsCb'),
        passRow:      document.getElementById('backupPassphraseRow'),
        passInput:    document.getElementById('backupPassphraseInput'),
        passConfirm:  document.getElementById('backupPassphraseConfirm'),
        passConfirmRow: document.getElementById('backupPassphraseConfirmRow'),
        preview:      document.getElementById('backupPreview'),
        error:        document.getElementById('backupModalError'),
        confirmBtn:   document.getElementById('backupModalConfirmBtn'),
        cancelBtn:    document.getElementById('backupModalCancelBtn'),
    };
}

function checkedSections() {
    return [...document.querySelectorAll('.backup-section-cb')]
        .filter(cb => !cb.disabled && cb.checked)
        .map(cb => cb.value);
}

function setError(msg) {
    const { error } = els();
    error.textContent = msg || '';
    error.style.display = msg ? '' : 'none';
}

function closeBackupModal() {
    const { modal, passInput, passConfirm } = els();
    modal.classList.remove('open');
    mode = null;
    restoreBundle = null;
    restoreZipBytes = null;
    clearTimeout(previewDebounce);
    // A passphrase typed in one open of the modal must never survive into
    // the next -- otherwise a cancelled/completed export leaves its
    // passphrase sitting in the field (visible as dots, easy to miss and
    // reuse by accident) the next time the export or restore modal opens.
    // autocomplete="new-password" on these inputs only discourages browser
    // password-manager autofill; it does nothing about this module's own
    // stale in-DOM value.
    passInput.value = '';
    passConfirm.value = '';
}

function renderSectionCheckboxes(presentSections) {
    const { sectionsBox } = els();
    sectionsBox.innerHTML = '';
    for (const key of SECTION_KEYS) {
        if (key === 'secrets') continue; // rendered separately below, it needs the passphrase row next to it
        const present = !presentSections || presentSections.has(key);
        const label = document.createElement('label');
        label.className = 'backup-section-row';
        label.innerHTML = `<input type="checkbox" class="backup-section-cb" value="${key}" ${present ? 'checked' : 'disabled'}>`
            + `<span>${t(`backup_section_${key}`)}</span>`
            + (present ? '' : `<span class="backup-section-empty">${t('backup_section_empty')}</span>`);
        sectionsBox.appendChild(label);
    }
}

// Restore accepts either an already-parsed legacy .json bundle
// (restoreBundle) or raw .zip bytes (restoreZipBytes) -- exactly one of the
// two is ever set (see openBackupRestoreModal()). The zip path sends
// sections/passphrase/dryRun as headers instead of inside the (binary) body
// -- never as a URL query parameter, matching the reasoning
// routes/backup.js documents above POST /api/backup for why a passphrase
// can't go in a URL. `sections === undefined` omits the header entirely,
// which the backend reads as "fall back to the bundle's own recorded
// `sections` field" -- used once, by openBackupRestoreModal()'s initial
// "what's in this file" probe, before the user has touched any checkbox.
function postRestore({ sections, passphrase, dryRun }) {
    if (restoreZipBytes) {
        const headers = { 'Content-Type': 'application/zip' };
        if (sections !== undefined) headers['X-GLP-Sections'] = JSON.stringify(sections);
        if (passphrase !== undefined) headers['X-GLP-Passphrase'] = passphrase;
        if (dryRun) headers['X-GLP-Dry-Run'] = 'true';
        return apiFetch('api/restore', { method: 'POST', headers, body: restoreZipBytes });
    }
    return apiFetch('api/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...restoreBundle, dryRun, sections, passphrase }),
    });
}

// Only meaningful for restore: calls the dry-run path so the preview shown
// to the user is computed by the exact same sanitizers/schemas the real
// restore uses, instead of a second hand-rolled estimate that could drift
// out of sync with what actually gets applied.
async function refreshRestorePreview() {
    if (mode !== 'restore' || (!restoreBundle && !restoreZipBytes)) return;
    const { preview } = els();
    const sections = checkedSections();
    const passphrase = els().secretsCb.checked ? els().passInput.value : undefined;
    try {
        const r = await postRestore({ sections, passphrase, dryRun: true });
        const body = await r.json();
        if (!r.ok || !body.preview) { preview.textContent = ''; return; }
        const p = body.preview;
        const lines = [];
        if (sections.includes('shots'))       lines.push(t('backup_preview_shots', p.shots) + (p.library ? ` · ${t('backup_preview_library')}` : ''));
        if (sections.includes('maintenance')) lines.push(t('backup_preview_maintenance', p.maintenance, p.maintenanceTotal) + ', ' + t('backup_preview_maintenance_log', p.maintenanceLog, p.maintenanceLogTotal));
        if (sections.includes('orders'))      lines.push(t('backup_preview_orders', p.orders, p.ordersTotal));
        if (sections.includes('machines'))    lines.push(t('backup_preview_machines', p.machines));
        if (sections.includes('settings') && p.settings) lines.push(t('backup_preview_settings'));
        if (p.images) lines.push(t('backup_preview_images', p.images));
        if (els().secretsCb.checked) {
            lines.push(p.secretsPresent
                ? (p.secretsRestored ? t('backup_preview_secrets_ok') : t('backup_preview_secrets_wrong'))
                : t('backup_preview_secrets_none'));
        }
        preview.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
    } catch { preview.textContent = ''; }
}

function scheduleRestorePreview() {
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(refreshRestorePreview, 250);
}

export function openBackupExportModal() {
    mode = 'export';
    const { modal, title, desc, secretsRow, passRow, passConfirmRow, preview, confirmBtn, cancelBtn } = els();
    title.textContent = t('backup_modal_export_title');
    desc.textContent  = t('backup_modal_export_desc');
    renderSectionCheckboxes(null);
    secretsRow.style.display = '';
    els().secretsCb.checked = false;
    passRow.style.display = 'none';
    passConfirmRow.style.display = 'none';
    preview.style.display = 'none';
    preview.innerHTML = '';
    setError('');
    confirmBtn.textContent = t('backup_modal_export_confirm');
    modal.classList.add('open');

    els().secretsCb.onchange = () => { passRow.style.display = els().secretsCb.checked ? '' : 'none'; passConfirmRow.style.display = els().secretsCb.checked ? '' : 'none'; };
    cancelBtn.onclick = closeBackupModal;
    confirmBtn.onclick = async () => {
        const sections = checkedSections();
        if (!sections.length) { setError(t('backup_error_no_sections')); return; }
        const wantsSecrets = els().secretsCb.checked;
        const passphrase = els().passInput.value;
        if (wantsSecrets && !passphrase) { setError(t('backup_error_passphrase_required')); return; }
        if (wantsSecrets && passphrase !== els().passConfirm.value) { setError(t('backup_error_passphrase_mismatch')); return; }
        setError('');
        try {
            const r = await apiFetch('api/backup', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sections, passphrase: wantsSecrets ? passphrase : undefined }),
            });
            if (!r.ok) { const err = await r.json().catch(() => ({})); setError(t('backup_error', err.error || r.status)); return; }
            // The response is already the zip binary (backup.json + real
            // image files, see routes/backup.js's buildBackupZip()) -- no
            // re-serialization needed, unlike the old JSON.stringify(bundle) here.
            const blob     = await r.blob();
            const filename = `glp-backup-${backupTimestamp()}.zip`;
            await shareOrDownloadBlob(blob, filename, { title: filename });
            closeBackupModal();
        } catch (e) { setError(t('backup_error', e.message)); }
    };
}

// Zip files always start with this 4-byte local-file-header signature (see
// lib/zip.js) -- sniffed instead of trusting the file's extension/MIME type,
// which a rename or a picky OS file picker can't be relied on for.
function looksLikeZip(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// `input` is the file <input> element restoreFromFile() was originally
// wired to, so this can reset it (input.value = '') the same way the old
// direct-restore flow always did, on every exit path.
export async function openBackupRestoreModal(input) {
    const file = input.files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());

    let present;
    if (looksLikeZip(bytes)) {
        // A zip's backup.json can't be inspected locally the way a plain
        // .json file's contents can (no zip reader on the frontend --
        // deliberately, see lib/zip.js's module doc comment: keeping zip
        // parsing in exactly one place, Node-only, was the whole point).
        // One dry-run round trip against the full file (no sections header,
        // so the backend falls back to "everything the file itself has")
        // gets the same section-presence information the legacy .json path
        // computes instantly and locally -- see routes/backup.js's
        // `sectionsPresent` field on the dry-run preview.
        restoreZipBytes = bytes;
        restoreBundle = null;
        try {
            const r = await postRestore({ sections: undefined, passphrase: undefined, dryRun: true });
            const body = await r.json();
            if (!r.ok || !body.preview) {
                alert(t('backup_invalid'));
                restoreZipBytes = null;
                // eslint-disable-next-line require-atomic-updates -- `input` is the caller's DOM element, not shared module state; nothing else writes input.value concurrently
                input.value = '';
                return;
            }
            present = new Set(body.preview.sectionsPresent);
        } catch (e) {
            alert(t('backup_error', e.message));
            restoreZipBytes = null;
            // eslint-disable-next-line require-atomic-updates -- see above
            input.value = '';
            return;
        }
    } else {
        try {
            const bundle = JSON.parse(new TextDecoder('utf-8').decode(bytes));
            if (!bundle.glp_backup) {
                alert(t('backup_invalid'));
                // eslint-disable-next-line require-atomic-updates -- `input` is the caller's DOM element, not shared module state; nothing else writes input.value concurrently
                input.value = '';
                return;
            }
            restoreBundle = bundle;
            restoreZipBytes = null;
        } catch (e) {
            alert(t('backup_error', e.message));
            // eslint-disable-next-line require-atomic-updates -- see above
            input.value = '';
            return;
        }
        present = new Set(SECTION_KEYS.filter(key => SECTION_PRESENCE_KEYS[key].some(k => k in restoreBundle)));
    }

    mode = 'restore';
    const { modal, title, desc, secretsRow, passRow, passConfirmRow, preview, confirmBtn, cancelBtn } = els();
    title.textContent = t('backup_modal_restore_title');
    desc.textContent  = t('backup_modal_restore_desc');
    renderSectionCheckboxes(present);
    const hasSecrets = present.has('secrets');
    secretsRow.style.display = hasSecrets ? '' : 'none';
    els().secretsCb.checked = hasSecrets;
    passRow.style.display = hasSecrets ? '' : 'none';
    passConfirmRow.style.display = 'none'; // restore only needs the passphrase once, no confirm field
    preview.style.display = '';
    preview.innerHTML = '';
    setError('');
    confirmBtn.textContent = t('backup_modal_restore_confirm');
    modal.classList.add('open');

    for (const cb of document.querySelectorAll('.backup-section-cb')) cb.onchange = scheduleRestorePreview;
    els().secretsCb.onchange = () => { passRow.style.display = els().secretsCb.checked ? '' : 'none'; scheduleRestorePreview(); };
    els().passInput.oninput = scheduleRestorePreview;
    cancelBtn.onclick = () => { input.value = ''; closeBackupModal(); };
    confirmBtn.onclick = async () => {
        const sections = checkedSections();
        if (!sections.length) { setError(t('backup_error_no_sections')); return; }
        const passphrase = els().secretsCb.checked ? els().passInput.value : undefined;
        setError('');
        try {
            const r = await postRestore({ sections, passphrase, dryRun: undefined });
            const res = await r.json();
            if (!res.ok) { setError(t('backup_error', res.error)); return; }
            // The restore may have just replaced the API token this session is
            // using -- /api/token serves any caller that can reach the port
            // (see routes/system.js), so re-fetching it is always safe and,
            // if it changed, required before any further apiFetch() call.
            if (res.secretsPresent && res.secretsRestored) await initToken();
            input.value = '';
            closeBackupModal();
            alert(res.secretsPresent
                ? (res.secretsRestored ? t('backup_restored_with_secrets', res.shots) : t('backup_restored_secrets_failed', res.shots))
                : t('backup_restored', res.shots));
            // #684: a restore can touch library/machines/settings/menu/etc,
            // not just shots -- window.loadData() only ever refreshed shots,
            // leaving everything else stale until a manual reload. A full
            // reload after the result alert is dismissed is simpler and more
            // complete than growing a bespoke per-section refresh here.
            location.reload();
        } catch (e) { setError(t('backup_error', e.message)); }
    };

    refreshRestorePreview();
}

export { closeBackupModal };
