// One modal drives both backup flows: choosing which of the six domains
// (see go/internal/backup's section list) to export, and — for restore —
// previewing exactly what a file would change before anything is written.
// A single shared implementation instead of two separate ones keeps the
// section list and its labels from drifting apart between export and
// restore, the same reasoning `lib/machines/options-adoption.js` documents
// for tracked options.
import { t } from '../i18n.js';
import { initToken } from '../api/transport.js';
import { requestBackup, postRestore } from '../api/system.js';
import { shareOrDownloadBlob } from '../utils.js';

const SECTION_KEYS = ['shots', 'maintenance', 'orders', 'machines', 'settings', 'secrets'];

// Filename-safe local-time timestamp, e.g. "2026-08-06_08-32-05" -- mirrors
// go/internal/backup's timestamp helper (kept as two copies rather than
// one shared module since one runs in the browser and one in Node, same
// reasoning SECTION_PRESENCE_KEYS/SECTION_PRESENCE_BUNDLE_KEYS already
// accept). A bare date collapsed every backup taken the same day into one
// filename, forcing the browser to append "(1)"/"(2)" or overwrite silently.
function backupTimestamp(): string {
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// Which top-level backup keys prove a given section actually has data in a
// file being restored — mirrors go/internal/backup's section-bundle keys.
// Used only to decide which restore checkboxes to offer; export always
// offers all six regardless of whether the *current* install has data in
// them (an empty section is still a valid, deliberate choice to make).
const SECTION_PRESENCE_KEYS: Record<string, string[]> = {
    shots:       ['shots'],
    maintenance: ['maintenance', 'maintenance_log'],
    orders:      ['orders'],
    machines:    ['machines'],
    settings:    ['kv'],
    secrets:     ['secrets'],
};

interface BackupPreview {
    shots?: number;
    library?: unknown;
    maintenance?: number;
    maintenanceTotal?: number;
    maintenanceLog?: number;
    maintenanceLogTotal?: number;
    orders?: number;
    ordersTotal?: number;
    machines?: number;
    settings?: boolean;
    images?: number;
    secretsPresent?: boolean;
    secretsRestored?: boolean;
    sectionsPresent?: string[];
}

interface BackupRestoreResult {
    ok?: boolean;
    error?: string;
    secretsPresent?: boolean;
    secretsRestored?: boolean;
    shots?: number;
}

let mode: 'export' | 'restore' | null = null;
let restoreBundle: Record<string, unknown> | null = null;    // legacy .json restore: the parsed bundle
let restoreZipBytes: ArrayBuffer | null = null;  // .zip restore: the raw file bytes -- mutually exclusive with restoreBundle
let previewDebounce: ReturnType<typeof setTimeout> | null = null;

// Enter in the passphrase/confirm-passphrase input has no default browser
// behavior to fall back on here -- the modal is deliberately not a <form>
// (the section checkboxes/preview wiring below assumes plain buttons, and
// turning it into one would submit-navigate on Enter from *any* focused
// field, not just these two) so Enter is otherwise a silent no-op. Wired
// once at import time since #backupModal is static markup in index.html,
// not created/destroyed per open like the section checkboxes are.
document.getElementById('backupModal')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement | null;
    if (target?.tagName !== 'INPUT') return;
    e.preventDefault();
    document.getElementById('backupModalConfirmBtn')?.click();
});

interface BackupEls {
    modal: HTMLElement;
    title: HTMLElement;
    desc: HTMLElement;
    sectionsBox: HTMLElement;
    secretsRow: HTMLElement;
    secretsCb: HTMLInputElement;
    passRow: HTMLElement;
    passInput: HTMLInputElement;
    passConfirm: HTMLInputElement;
    passConfirmRow: HTMLElement;
    preview: HTMLElement;
    error: HTMLElement;
    progress: HTMLElement;
    progressFill: HTMLElement;
    progressLabel: HTMLElement;
    confirmBtn: HTMLButtonElement;
    cancelBtn: HTMLButtonElement;
}

function els(): BackupEls {
    return {
        modal:        document.getElementById('backupModal') as HTMLElement,
        title:        document.getElementById('backupModalTitle') as HTMLElement,
        desc:         document.getElementById('backupModalDesc') as HTMLElement,
        sectionsBox:  document.getElementById('backupModalSections') as HTMLElement,
        secretsRow:   document.getElementById('backupSecretsRow') as HTMLElement,
        secretsCb:    document.getElementById('backupSecretsCb') as HTMLInputElement,
        passRow:      document.getElementById('backupPassphraseRow') as HTMLElement,
        passInput:    document.getElementById('backupPassphraseInput') as HTMLInputElement,
        passConfirm:  document.getElementById('backupPassphraseConfirm') as HTMLInputElement,
        passConfirmRow: document.getElementById('backupPassphraseConfirmRow') as HTMLElement,
        preview:      document.getElementById('backupPreview') as HTMLElement,
        error:        document.getElementById('backupModalError') as HTMLElement,
        progress:     document.getElementById('backupModalProgress') as HTMLElement,
        progressFill: document.getElementById('backupModalProgressFill') as HTMLElement,
        progressLabel: document.getElementById('backupModalProgressLabel') as HTMLElement,
        confirmBtn:   document.getElementById('backupModalConfirmBtn') as HTMLButtonElement,
        cancelBtn:    document.getElementById('backupModalCancelBtn') as HTMLButtonElement,
    };
}

// Progress row (#960). A null `pct` means "size unknown" — an indeterminate
// bar (Node backend sends no X-GLP-Backup-Estimate; or the server-side
// restore phase after the upload bytes are all sent). Both the confirm and
// the cancel button are disabled for the whole transfer (setBusy) so an
// in-flight stream/XHR is never orphaned — there is no abort path.
function showProgress(labelText: string, pct: number | null): void {
    const { progress, progressFill, progressLabel } = els();
    const track = progress.querySelector('.sync-progress-track') as HTMLElement;
    progress.style.display = '';
    if (pct == null) {
        track.classList.add('indeterminate');
    } else {
        track.classList.remove('indeterminate');
        progressFill.style.width = pct + '%';
    }
    progressLabel.textContent = labelText;
}

function hideProgress(): void {
    const { progress, progressFill } = els();
    progress.style.display = 'none';
    progressFill.style.width = '0%';
    (progress.querySelector('.sync-progress-track') as HTMLElement).classList.remove('indeterminate');
}

function setBusy(on: boolean): void {
    const { confirmBtn, cancelBtn } = els();
    confirmBtn.disabled = on;
    cancelBtn.disabled = on;
}

// Clamped whole-percent for a determinate bar — never shows 100% before the
// transfer has actually finished (the export estimate header is only
// approximate; see routes' X-GLP-Backup-Estimate spec).
function clampPct(done: number, total: number): number {
    return Math.min(99, Math.floor((done / total) * 100));
}

function checkedSections(): string[] {
    return [...document.querySelectorAll<HTMLInputElement>('.backup-section-cb')]
        .filter(cb => !cb.disabled && cb.checked)
        .map(cb => cb.value);
}

function setError(msg: string): void {
    const { error } = els();
    error.textContent = msg || '';
    error.style.display = msg ? '' : 'none';
}

function closeBackupModal(): void {
    const { modal, passInput, passConfirm } = els();
    modal.classList.remove('open');
    hideProgress();
    setBusy(false);
    mode = null;
    restoreBundle = null;
    restoreZipBytes = null;
    if (previewDebounce != null) clearTimeout(previewDebounce);
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

function renderSectionCheckboxes(presentSections: Set<string> | null): void {
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

// The restore request itself (URL, zip headers, JSON/zip body, upload
// progress) is built by api/system.ts's postRestore(); this module only owns
// the modal state (which of restoreBundle/restoreZipBytes is set) and passes
// it in.

// Only meaningful for restore: calls the dry-run path so the preview shown
// to the user is computed by the exact same sanitizers/schemas the real
// restore uses, instead of a second hand-rolled estimate that could drift
// out of sync with what actually gets applied.
async function refreshRestorePreview(): Promise<void> {
    if (mode !== 'restore' || (!restoreBundle && !restoreZipBytes)) return;
    const { preview } = els();
    const sections = checkedSections();
    const passphrase = els().secretsCb.checked ? els().passInput.value : undefined;
    try {
        const r = await postRestore({ bundle: restoreBundle ?? undefined, zipBytes: restoreZipBytes, sections, passphrase, dryRun: true });
        const body = await r.json() as { preview?: BackupPreview };
        if (!r.ok || !body.preview) { preview.textContent = ''; return; }
        const p = body.preview;
        const lines: string[] = [];
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

function scheduleRestorePreview(): void {
    if (previewDebounce != null) clearTimeout(previewDebounce);
    previewDebounce = setTimeout(refreshRestorePreview, 250);
}

export function openBackupExportModal(): void {
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
        setBusy(true);
        showProgress(t('backup_progress_preparing'), null);
        try {
            // The response is already the zip binary (backup.json + real
            // image files, see go/internal/backup's bundle builder) -- no
            // re-serialization needed, unlike the old JSON.stringify(bundle).
            // X-GLP-Backup-Estimate is an approximate size for the bar; the
            // Go backend sends it, the Node backend doesn't (then the bar
            // stays indeterminate). requestBackup() buffers the whole zip in
            // memory before the download — fine for these file sizes.
            const res = await requestBackup({
                sections,
                passphrase: wantsSecrets ? passphrase : undefined,
                onProgress: (received, total) => {
                    if (total) showProgress(t('backup_progress_download', clampPct(received, total)), clampPct(received, total));
                    else showProgress(t('backup_progress_preparing'), null);
                },
            });
            if (!res.ok) {
                setBusy(false);
                hideProgress();
                let detail: string | number = res.status;
                try { detail = (JSON.parse(res.errorText) as { error?: string }).error || res.status; } catch { /* non-JSON error body */ }
                setError(t('backup_error', detail));
                return;
            }
            showProgress(t('backup_progress_download', 100), 100);
            const filename = `glp-backup-${backupTimestamp()}.zip`;
            await shareOrDownloadBlob(res.blob, filename, { title: filename });
            if (window.showToast) window.showToast(t('backup_progress_done'));
            closeBackupModal();
        } catch (e) { setBusy(false); hideProgress(); setError(t('backup_error', (e as Error).message)); }
    };
}

// Zip files always start with this 4-byte local-file-header signature (see
// lib/zip.js) -- sniffed instead of trusting the file's extension/MIME type,
// which a rename or a picky OS file picker can't be relied on for.
function looksLikeZip(bytes: Uint8Array): boolean {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// `input` is the file <input> element restoreFromFile() was originally
// wired to, so this can reset it (input.value = '') the same way the old
// direct-restore flow always did, on every exit path.
export async function openBackupRestoreModal(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    let present: Set<string>;
    if (looksLikeZip(bytes)) {
        // A zip's backup.json can't be inspected locally the way a plain
        // .json file's contents can (no zip reader on the frontend --
        // deliberately, see lib/zip.js's module doc comment: keeping zip
        // parsing in exactly one place, Node-only, was the whole point).
        // One dry-run round trip against the full file (no sections header,
        // so the backend falls back to "everything the file itself has")
        // gets the same section-presence information the legacy .json path
        // computes instantly and locally -- see go/internal/backup's
        // `sectionsPresent` field on the dry-run preview.
        restoreZipBytes = arrayBuffer;
        restoreBundle = null;
        try {
            const r = await postRestore({ bundle: restoreBundle ?? undefined, zipBytes: restoreZipBytes, sections: undefined, passphrase: undefined, dryRun: true });
            const body = await r.json() as { preview?: BackupPreview };
            if (!r.ok || !body.preview) {
                alert(t('backup_invalid'));
                restoreZipBytes = null;
                input.value = '';
                return;
            }
            present = new Set(body.preview.sectionsPresent ?? []);
        } catch (e) {
            alert(t('backup_error', (e as Error).message));
            restoreZipBytes = null;
            input.value = '';
            return;
        }
    } else {
        try {
            const bundle = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as Record<string, unknown>;
            if (!bundle.glp_backup) {
                alert(t('backup_invalid'));
                input.value = '';
                return;
            }
            restoreBundle = bundle;
            restoreZipBytes = null;
            present = new Set(SECTION_KEYS.filter(key => SECTION_PRESENCE_KEYS[key].some(k => k in bundle)));
        } catch (e) {
            alert(t('backup_error', (e as Error).message));
            input.value = '';
            return;
        }
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

    for (const cb of document.querySelectorAll<HTMLInputElement>('.backup-section-cb')) cb.onchange = scheduleRestorePreview;
    els().secretsCb.onchange = () => { passRow.style.display = els().secretsCb.checked ? '' : 'none'; scheduleRestorePreview(); };
    els().passInput.oninput = scheduleRestorePreview;
    cancelBtn.onclick = () => { input.value = ''; closeBackupModal(); };
    confirmBtn.onclick = async () => {
        const sections = checkedSections();
        if (!sections.length) { setError(t('backup_error_no_sections')); return; }
        const passphrase = els().secretsCb.checked ? els().passInput.value : undefined;
        setError('');
        setBusy(true);
        showProgress(t('backup_progress_upload', 0), 0);
        try {
            // Legacy JSON-bundle restore is already fully in memory — no
            // upload phase to report, just the indeterminate server phase.
            const onProgress = restoreZipBytes
                ? (sent: number, total: number) => {
                    if (sent >= total) showProgress(t('backup_progress_restoring'), null);
                    else showProgress(t('backup_progress_upload', clampPct(sent, total)), clampPct(sent, total));
                }
                : undefined;
            if (!restoreZipBytes) showProgress(t('backup_progress_restoring'), null);
            const r = await postRestore({ bundle: restoreBundle ?? undefined, zipBytes: restoreZipBytes, sections, passphrase, dryRun: undefined, onProgress });
            // Upload bytes are all sent by the time the promise resolves;
            // the server-side apply is genuinely unbounded from here.
            showProgress(t('backup_progress_restoring'), null);
            const res = await r.json() as BackupRestoreResult;
            if (!res.ok) { setBusy(false); hideProgress(); setError(t('backup_error', res.error)); return; }
            // The restore may have just replaced the API token this session is
            // using -- /api/token serves any caller that can reach the port
            // (see go/internal/system), so re-fetching it is always safe and,
            // if it changed, required before any further apiFetch() call.
            if (res.secretsPresent && res.secretsRestored) await initToken();
            if (window.showToast) window.showToast(t('backup_progress_done'));
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
        } catch (e) { setBusy(false); hideProgress(); setError(t('backup_error', (e as Error).message)); }
    };

    void refreshRestorePreview();
}

export { closeBackupModal };
