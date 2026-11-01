import { S } from '../../state/index.js';
import { t } from '../../i18n.js';
import { getShotCard } from '../../api/shots.js';
import { localeFor } from '../../constants.js';
import { avg, avgActive, max, shareOrDownloadBlob, mapShotDatapoints } from '../../utils.js';
import { getShotCurve, ensureCurves, getCachedShotData, evictCurve } from '../../shot-curves.js';
import type { ShotSeries } from '../../utils.js';
import { beanLabel } from '../../shared/bean-mix.js';
import { _equipmentName, _libCollection, _shots } from './shared.js';
import type { ShotRow } from './shared.js';

// ── CSV Export ────────────────────────────────────────────────────────────

// #1626: a text cell that starts with one of these is read as a formula by
// spreadsheet apps, so a name typed or imported elsewhere could run as one.
// Such a cell gets a leading apostrophe, which makes the app keep it as text.
// A plain number (a negative grind setting, say) cannot be a formula and is
// left as it is.
const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;
const CSV_PLAIN_NUMBER = /^[+-]?\d+(?:[.,]\d+)?$/;

export function neutraliseCsvText(value: string | number | null | undefined): string {
  const s = value == null ? '' : String(value);
  return CSV_FORMULA_PREFIX.test(s) && !CSV_PLAIN_NUMBER.test(s) ? `'${s}` : s;
}

// d is the mapped XY curve bundle for this shot (from the curve cache) — the
// caller fetches it via getShotCurve() first, since list rows no longer carry
// datapoints (#957).
function shotToCSVRow(shot: ShotRow, d: ShotSeries): string {
  const ann    = shot.annotation || {};
  // #1837: a mixed shot's coffee cell lists every bean and its grams.
  const coffee = beanLabel(ann, true);
  const avgP   = avgActive(d.pressure.map(p => p.y), 1.5);
  const finalW = max(d.weight.map(p => p.y));
  const avgT   = avg(d.temp.map(p => p.y));
  const secs   = ((shot.duration || 0) / 10).toFixed(1);
  const ratio  = (ann.dose && finalW) ? `1:${(finalW / ann.dose).toFixed(1)}` : '';
  const date   = new Date(shot.timestamp * 1000).toLocaleString(localeFor(S.currentLang));
  return [
    shot.id, date,
    neutraliseCsvText(shot.profile?.name || shot.profileName || ''),
    secs,
    avgP   != null ? avgP.toFixed(2)   : '',
    finalW != null ? finalW.toFixed(1) : '',
    ann.dose || '', ratio,
    avgT   != null ? avgT.toFixed(1)   : '',
    ann.rating || '', neutraliseCsvText(coffee), neutraliseCsvText(ann.grinder || ''),
    neutraliseCsvText(ann.grindSetting || ''),
    neutraliseCsvText(_equipmentName(_libCollection('baskets'), ann.basketId) || ''),
    neutraliseCsvText(_equipmentName(_libCollection('puckScreens'), ann.puckScreenId) || ''),
    neutraliseCsvText((ann.notes || '').replace(/\n/g, ' '))
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
}

async function downloadCSV(rows: string[], filename: string): Promise<void> {
  const header = ['Shot ID','Date','Profile','Duration (s)','Avg Pressure (bar)','Max Weight (g)',
                  'Dose (g)','Ratio','Avg Temp (C)','Rating','Coffee','Grinder','Grind Setting',
                  'Basket','Puck Screen','Notes'];
  const csv  = [header.join(','), ...rows].join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  await shareOrDownloadBlob(blob, filename, { title: t('export_csv_title') });
}

export async function exportCSV(): Promise<void> {
  const shot = _shots().find(s => s.id === S.primaryShotId);
  if (!shot) return;
  await getShotCurve(shot.id);
  const date    = new Date(shot.timestamp * 1000).toISOString().slice(0, 10);
  const profile = (shot.profile?.name || shot.profileName || 'shot').replace(/[^a-z0-9]/gi, '_');
  await downloadCSV([shotToCSVRow(shot, getCachedShotData(shot.id) || mapShotDatapoints({}))], `glp_shot_${date}_${profile}.csv`);
}

export async function exportAllCSV(): Promise<void> {
  // Rare, explicit user action. Curves are pulled in bounded chunks (bounded
  // concurrency inside ensureCurves too) so a long history never holds every
  // curve in memory at once; the curves loaded just for this export are
  // evicted again, the ones already cached before it started stay.
  const list = _shots();
  const previouslyCached = new Set(list.filter(s => getCachedShotData(s.id)).map(s => s.id));
  const rows: string[] = [];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    await ensureCurves(chunk.map(s => s.id));
    rows.push(...chunk.map(s => shotToCSVRow(s, getCachedShotData(s.id) || mapShotDatapoints({}))));
    for (const s of chunk) if (!previouslyCached.has(s.id)) evictCurve(s.id);
  }
  await downloadCSV(rows, 'glp_all_shots.csv');
}

// ── .shot export ──────────────────────────────────────────────────────────

export async function exportShot(): Promise<void> {
  const shot = _shots().find(s => s.id === S.primaryShotId);
  if (!shot) return;
  const d   = await getShotCurve(shot.id);
  const ann = shot.annotation || {};
  // #1837: a mixed shot's Visualizer description names every bean and grams.
  const coffeeLabel = beanLabel(ann, true);
  const timeArr = d.timeInShot || [];

  const tcl = (arr: unknown[] | null | undefined): string => arr?.length ? `{${arr.map(v => ((v as number) / 10).toFixed(2)).join(' ')}}` : '{}';

  const finalWeight = d.shotWeight || d.weight || [];
  const lastW = finalWeight.length ? ((finalWeight.at(-1) ?? 0) / 10).toFixed(1) : '0.0';
  const date  = new Date(shot.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const basketName     = _equipmentName(_libCollection('baskets'), ann.basketId);
  const puckScreenName = _equipmentName(_libCollection('puckScreens'), ann.puckScreenId);

  const lines = [
    `clock ${shot.timestamp}`,
    `date ${date}`,
    `profile_title {${(shot.profile?.name || shot.profileName || 'Unknown').replace(/[{}]/g, '')}}`,
    coffeeLabel      ? `bean_desc {${coffeeLabel.replace(/[{}]/g, '')}}` : '',
    ann.grinder      ? `grinder_model {${ann.grinder.replace(/[{}]/g, '')}}` : '',
    ann.grindSetting != null && ann.grindSetting !== '' ? `grinder_setting {${String(ann.grindSetting).replace(/[{}]/g, '')}}` : '',
    basketName       ? `basket {${basketName.replace(/[{}]/g, '')}}` : '',
    puckScreenName   ? `puck_screen {${puckScreenName.replace(/[{}]/g, '')}}` : '',
    ann.dose         ? `bean_weight ${ann.dose}` : '',
    ann.notes        ? `espresso_notes {${ann.notes.replace(/[{}]/g, '')}}` : '',
    `espresso_elapsed ${tcl(timeArr)}`,
    `espresso_pressure ${tcl(d.pressure)}`,
    `espresso_flow ${tcl(d.pumpFlow)}`,
    `espresso_weight ${tcl(d.shotWeight || d.weight)}`,
    `espresso_flow_weight ${tcl(d.weightFlow)}`,
    `espresso_temperature_goal ${tcl(d.targetTemperature)}`,
    `espresso_temperature_mix ${tcl(d.temperature)}`,
    `espresso_water_dispensed ${lastW}`,
  ].filter(Boolean).join('\n');

  await _downloadJSON_blob(lines, `shot_${shot.id}_${date.slice(0, 10)}.shot`, 'text/plain;charset=utf-8;');
}

// ── Profile export ────────────────────────────────────────────────────────

export async function exportProfile(): Promise<void> {
  const shot = _shots().find(s => s.id === S.primaryShotId);
  if (!shot) return;

  const profile = shot.profile;
  if (profile && Array.isArray(profile.phases) && profile.phases.length > 0) {
    const out = JSON.parse(JSON.stringify(profile)) as { recipe?: Record<string, number>; name?: string } & Record<string, unknown>;
    const ann = shot.annotation || {};
    if (!out.recipe) out.recipe = {};
    if (ann.dose) out.recipe.coffeeIn = parseFloat(String(ann.dose));
    if (!out.recipe.coffeeOut && ann.dose) out.recipe.coffeeOut = parseFloat(String(ann.dose)) * 2;
    if (out.recipe.coffeeIn && out.recipe.coffeeOut)
      out.recipe.ratio = Math.round(Number(out.recipe.coffeeOut) / Number(out.recipe.coffeeIn) * 100) / 100;
    await _downloadJSON(out, (out.name || shot.profileName || `shot_${shot.id}`).replace(/[^a-z0-9_-]/gi, '_') + '.json');
    return;
  }

  const d    = await getShotCurve(shot.id);
  const rawT = d.timeInShot     || [];
  const rawTP = d.targetPressure || [];

  if (rawT.length === 0 || rawTP.length === 0) {
    alert(t('profile_export_no_data'));
    return;
  }

  const times  = rawT.map(v => v / 10);
  const tPress = rawTP.map(v => v / 10);
  const totalMs = Math.round((times.at(-1) ?? NaN) * 1000);
  const ann     = shot.annotation || {};

  const PREINF_THRESHOLD = 6;
  let preinfEndIdx = tPress.findIndex(p => p >= PREINF_THRESHOLD);
  if (preinfEndIdx < 0) preinfEndIdx = 0;
  const preinfMs = preinfEndIdx > 0 ? Math.round((times[preinfEndIdx] ?? NaN) * 1000) : 0;

  const phases = [];
  if (preinfMs > 500) {
    const preinfTarget = Math.round(Math.max(...tPress.slice(0, preinfEndIdx)) * 10) / 10 || 4;
    phases.push({
      type: 0,
      target: { start: 0, end: preinfTarget, curve: 1, time: preinfMs },
      restriction: 0,
      stopConditions: { time: preinfMs, pressureAbove: 0, pressureBelow: 0, flowAbove: 0, flowBelow: 0, weight: 0 }
    });
  }

  const extractionSlice = tPress.slice(preinfEndIdx || 0);
  const avgExtraction   = extractionSlice.length
    ? Math.round(extractionSlice.reduce((a, b) => a + b, 0) / extractionSlice.length * 10) / 10
    : 9;
  const extractionMs = totalMs - preinfMs;
  const yieldG = ann.dose ? parseFloat(String(ann.dose)) * 2 : 36;

  phases.push({
    type: 0,
    target: { start: avgExtraction, end: avgExtraction, curve: 0, time: extractionMs },
    restriction: 0,
    stopConditions: { time: extractionMs, pressureAbove: 0, pressureBelow: 0, flowAbove: 0, flowBelow: 0, weight: yieldG }
  });

  const out = {
    id: shot.id,
    name: shot.profileName || `Shot ${shot.id}`,
    phases,
    globalStopConditions: { time: 0, weight: yieldG, waterPumped: 0 },
    recipe: {
      coffeeIn:  ann.dose ? parseFloat(String(ann.dose)) : 18,
      coffeeOut: yieldG,
      ratio:     ann.dose ? Math.round(yieldG / parseFloat(String(ann.dose)) * 100) / 100 : 2
    }
  };
  await _downloadJSON(out, (out.name).replace(/[^a-z0-9_-]/gi, '_') + '.json');
}

async function _downloadJSON(obj: unknown, filename: string): Promise<void> {
  await _downloadJSON_blob(JSON.stringify(obj, null, 2), filename, 'application/json');
}

async function _downloadJSON_blob(content: string, filename: string, mime: string): Promise<void> {
  const blob = new Blob([content], { type: mime });
  await shareOrDownloadBlob(blob, filename, { title: filename });
}

// ── Share card ────────────────────────────────────────────────────────────

export async function shareCard(format = 'square'): Promise<void> {
  const shotId = S.primaryShotId;
  if (!shotId) return;
  try {
    // #462: the card should visually match whatever accent/theme the user
    // is actually looking at, not a hardcoded snapshot — same attributes
    // main.ts applies to <html> (dataset.accent/dataset.theme), same
    // defaults ('amber-americano'/'dark', see applyTheme()/_savedAccent in
    // main.ts). #1019: dataset.accent no longer drives any CSS itself (the
    // [data-accent] rules it used to key are retired), but is still set on
    // every setAccentTheme() call purely so this stays in sync with the
    // user's actual Farbschema pick.
    const accent = document.documentElement.dataset.accent || 'amber-americano';
    const theme  = document.documentElement.dataset.theme  || 'dark';
    const r = await getShotCard(shotId, { format, accent, theme, lang: S.currentLang });
    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error || r.statusText);
    }
    const blob     = await r.blob();
    const filename = `glp-shot-${shotId}-${format}.png`;
    await shareOrDownloadBlob(blob, filename, { title: t('share_card_title'), fallbackOnError: false });
  } catch (e) {
    if ((e as Error).name !== 'AbortError') alert(t('error_generic', (e as Error).message));
  }
}

// ── Backup / Restore ──────────────────────────────────────────────────────

// Backup export/restore is a modal flow (section picker, passphrase for the
// encrypted API-token/MQTT block, a dry-run preview before anything is
// written) — see public-src/components/backup-modal.ts, wired directly from
// boot/settings.ts's event listeners rather than through this file.
