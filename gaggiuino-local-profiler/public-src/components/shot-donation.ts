// The shot donation dialog (#2220): Settings → Data → "Donate shots …".
// It fetches the anonymised donation file for the chosen range, shows how
// many shots it holds, and saves exactly those bytes only when the user
// confirms, so the count shown and the file saved can never disagree. GLP
// uploads nothing; the user posts the file on the Discord themselves. The
// panel markup and all its strings live in index.html (#donationPanel) and
// are moved into the shared detail sheet while it is open.
import { t } from '../i18n.js';
import { getShotDonation } from '../api/system.js';
import { openDetailSheet, requestCloseDetailSheet } from './detail-sheet.js';
import { html, shareOrDownloadBlob, todayIsoDate } from '../utils.js';

let _seq = 0;
let _blob: Blob | null = null;
let _wired = false;
let _since = false;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** Number of shots in a donation file, or null when body is not one. */
export function donationShotCount(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const file = body as { format?: unknown; shots?: unknown };
  if (file.format !== 'glp-shot-donation' || !Array.isArray(file.shots)) return null;
  return file.shots.length;
}

/** Download name for the donation file saved on the given local date. */
export function donationFilename(today: string): string {
  return `glp-shot-donation-${today}.json`;
}

function setRange(since: boolean): void {
  _since = since;
  el('donationRangeAll')?.setAttribute('aria-pressed', since ? 'false' : 'true');
  el('donationRangeSince')?.setAttribute('aria-pressed', since ? 'true' : 'false');
  const wrap = el('donationSinceWrap');
  if (wrap) wrap.hidden = !since;
}

function setDownloadEnabled(enabled: boolean): void {
  const btn = el<HTMLButtonElement>('donationDownloadBtn');
  if (btn) btn.disabled = !enabled;
}

function showError(detail: string | number): void {
  const count = el('donationCount');
  if (count) count.textContent = '–';
  const error = el('donationError');
  if (error) {
    error.textContent = t('error_generic', detail);
    error.hidden = false;
  }
  setDownloadEnabled(false);
}

async function refresh(): Promise<void> {
  const seq = ++_seq;
  _blob = null;
  setDownloadEnabled(false);
  const count = el('donationCount');
  const empty = el('donationEmpty');
  const error = el('donationError');
  if (error) error.hidden = true;
  if (empty) empty.hidden = true;
  const since = _since ? (el<HTMLInputElement>('donationSinceDate')?.value ?? '') : null;
  if (_since && !since) {
    if (count) count.textContent = '–';
    return;
  }
  if (count) count.textContent = '…';
  try {
    const r = await getShotDonation(since);
    if (seq !== _seq) return;
    if (!r.ok) { showError(r.status); return; }
    const text = await r.text();
    if (seq !== _seq) return;
    const n = donationShotCount(JSON.parse(text));
    if (n === null) { showError(r.status); return; }
    if (count) count.textContent = String(n);
    if (empty) empty.hidden = n !== 0;
    _blob = new Blob([text], { type: 'application/json' });
    setDownloadEnabled(n > 0);
  } catch (e) {
    if (seq === _seq) showError((e as Error).message);
  }
}

async function download(): Promise<void> {
  if (!_blob) return;
  await shareOrDownloadBlob(_blob, donationFilename(todayIsoDate()), { title: t('donation_title') });
  requestCloseDetailSheet();
}

function wireOnce(): void {
  if (_wired) return;
  _wired = true;
  el('donationRangeAll')?.addEventListener('click', () => { setRange(false); void refresh(); });
  el('donationRangeSince')?.addEventListener('click', () => { setRange(true); void refresh(); });
  el('donationSinceDate')?.addEventListener('change', () => { void refresh(); });
  el('donationCancelBtn')?.addEventListener('click', () => { requestCloseDetailSheet(); });
  el('donationDownloadBtn')?.addEventListener('click', () => { void download(); });
}

/** Opens the donation dialog with "All rated shots" selected and loads its count. */
export function openShotDonation(): void {
  const panel = el('donationPanel');
  if (!panel) return;
  setRange(false);
  const date = el<HTMLInputElement>('donationSinceDate');
  if (date) {
    date.value = '';
    date.max = todayIsoDate();
  }
  const count = el('donationCount');
  if (count) count.textContent = '–';
  const empty = el('donationEmpty');
  if (empty) empty.hidden = true;
  const error = el('donationError');
  if (error) error.hidden = true;
  setDownloadEnabled(false);
  _blob = null;
  wireOnce();
  openDetailSheet({
    title: t('donation_title'),
    dialog: true,
    body: html``,
    content: panel,
    onClose: () => { _seq++; _blob = null; },
  });
  void refresh();
}
