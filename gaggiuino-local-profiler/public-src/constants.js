import de from './i18n/de.js';
import en from './i18n/en.js';
import it from './i18n/it.js';
import fr from './i18n/fr.js';
import es from './i18n/es.js';
import nl from './i18n/nl.js';

export const LOCALE_MAP = { de: 'de-DE', en: 'en-US', it: 'it-IT', fr: 'fr-FR', es: 'es-ES', nl: 'nl-NL' };

export const TRANSLATIONS = { de, en, it, fr, es, nl };

// Single source of truth for "which BCP-47 locale does Intl/toLocale*()
// get for the active UI language" — every call site used to inline its own
// `LOCALE_MAP[S.currentLang] || 'de-DE'`, which meant an unsupported/unknown
// S.currentLang silently rendered dates/numbers in German for every user,
// not just German ones. Falls back to English instead, matching the same
// fallback fix applied to S.currentLang itself (state.js) and t() (i18n.js).
export function localeFor(lang) {
  return LOCALE_MAP[lang] || LOCALE_MAP.en;
}

// ── Coffee origin countries (ISO 3166-1 alpha-2 + numeric for topojson) ───
export const COFFEE_COUNTRIES = [
  { code: 'AO', num: '024' }, { code: 'BI', num: '108' }, { code: 'BO', num: '068' },
  { code: 'BR', num: '076' }, { code: 'CD', num: '180' }, { code: 'CI', num: '384' },
  { code: 'CM', num: '120' }, { code: 'CN', num: '156' }, { code: 'CO', num: '170' },
  { code: 'CR', num: '188' }, { code: 'CU', num: '192' }, { code: 'DO', num: '214' },
  { code: 'EC', num: '218' }, { code: 'ET', num: '231' }, { code: 'GH', num: '288' },
  { code: 'GT', num: '320' }, { code: 'HN', num: '340' }, { code: 'HT', num: '332' },
  { code: 'ID', num: '360' }, { code: 'IN', num: '356' }, { code: 'JM', num: '388' },
  { code: 'KE', num: '404' }, { code: 'KH', num: '116' }, { code: 'LA', num: '418' },
  { code: 'LK', num: '144' }, { code: 'MM', num: '104' }, { code: 'MW', num: '454' },
  { code: 'MX', num: '484' }, { code: 'MZ', num: '508' }, { code: 'NI', num: '558' },
  { code: 'NP', num: '524' }, { code: 'PA', num: '591' }, { code: 'PE', num: '604' },
  { code: 'PG', num: '598' }, { code: 'PH', num: '608' }, { code: 'RW', num: '646' },
  { code: 'SV', num: '222' }, { code: 'TH', num: '764' }, { code: 'TL', num: '626' },
  { code: 'TZ', num: '834' }, { code: 'UG', num: '800' }, { code: 'US', num: '840' },
  { code: 'VE', num: '862' }, { code: 'VN', num: '704' }, { code: 'YE', num: '887' },
  { code: 'ZM', num: '894' }, { code: 'ZW', num: '716' },
];

// Fallback map point per origin country [lon, lat] — used when a bean has no
// geocoded region yet. Hand-picked toward the coffee-growing area rather than
// the capital where it matters (US → Hawaii/Kona, not Washington DC).
export const COUNTRY_CENTROIDS = {
  AO: [17.87, -11.20], BI: [29.92, -3.37],  BO: [-63.59, -16.29], BR: [-51.93, -14.24],
  CD: [21.76, -4.04],  CI: [-5.55, 7.54],   CM: [12.35, 7.37],    CN: [101.5, 24.5],
  CO: [-74.30, 4.57],  CR: [-83.75, 9.75],  CU: [-77.78, 21.52],  DO: [-70.16, 18.74],
  EC: [-78.18, -1.83], ET: [40.49, 9.15],   GH: [-1.02, 7.95],    GT: [-90.23, 15.78],
  HN: [-86.24, 15.20], HT: [-72.29, 18.97], ID: [113.92, -0.79],  IN: [78.96, 20.59],
  JM: [-77.30, 18.11], KE: [37.91, -0.02],  KH: [104.99, 12.57],  LA: [102.50, 19.86],
  LK: [80.77, 7.87],   MM: [95.96, 21.91],  MW: [34.30, -13.25],  MX: [-96.7, 17.1],
  MZ: [35.53, -18.67], NI: [-85.21, 12.87], NP: [84.12, 28.39],   PA: [-80.78, 8.54],
  PE: [-75.02, -9.19], PG: [143.96, -6.31], PH: [121.77, 12.88],  RW: [29.87, -1.94],
  SV: [-88.90, 13.79], TH: [100.99, 15.87], TL: [125.73, -8.87],  TZ: [34.89, -6.37],
  UG: [32.29, 1.37],   US: [-155.5, 19.6],  VE: [-66.59, 6.42],   VN: [108.28, 14.06],
  YE: [48.52, 15.55],  ZM: [27.85, -13.13], ZW: [29.15, -19.02],
};

export const VARIETY_SUGGESTIONS = ['Bourbon', 'Geisha',
  'Typica', 'Caturra', 'Catuai', 'SL28', 'SL34', 'Pacamara', 'Maragogype'];

// Coffee species — botanical, distinct from the cultivars/varieties above
// (e.g. Red Bourbon is a cultivar within Arabica, not a separate species).
export const SPECIES_OPTIONS = ['Arabica', 'Robusta', 'Liberica', 'Blend'];

export const PROCESS_SUGGESTIONS = ['Washed', 'Natural', 'Honey', 'Anaerobic'];

const _isCountryCode = c => typeof c === 'string' && /^[A-Z]{2}$/.test(c);

export function countryName(code, lang) {
  if (!_isCountryCode(code)) return code || '';
  try { return new Intl.DisplayNames([lang || 'en'], { type: 'region' }).of(code) || code; }
  catch { return code; }
}

// #811: flagEmoji() removed. It assembled a regional-indicator flag from the
// country code at render time, so no source-level emoji scan ever saw it — not
// the one that scoped this issue, and not the one in either card repo, where
// the same helper was removed for the same reasons. It rendered in the OS font
// (a different visual language from every drawn icon beside it), degrades to a
// bare two-letter box on Windows, and is politically loaded for several
// coffee-growing regions in a way a plain country name is not. Every call site
// rendered countryName() immediately after it, so nothing is lost.

// #417 sweep: the `icon` emoji fields these entries used to carry were dead
// data — no consumer ever read MAINT_META[task].icon, since maintenance.js's
// own taskIconSvg()/TASK_ICON_PATHS (#393) already renders the real stroke-SVG
// task icons. Dropped rather than replaced.
export const MAINT_META = {
  descaling:   { key: 'maint_descaling'   },
  backflush:   { key: 'maint_backflush'   },
  grouphead:   { key: 'maint_grouphead'   },
  gaskets:     { key: 'maint_gaskets'     },
  waterfilter: { key: 'maint_waterfilter' },
};

// Guided maintenance walkthroughs: i18n keys per step. Tasks without an entry
// have no guide button.
export const GUIDED_MAINT_STEPS = {
  backflush: ['guided_backflush_1', 'guided_backflush_2', 'guided_backflush_3', 'guided_backflush_4', 'guided_backflush_5'],
  descaling: ['guided_descaling_1', 'guided_descaling_2', 'guided_descaling_3', 'guided_descaling_4', 'guided_descaling_5', 'guided_descaling_6'],
};

// phases[] -> {name, phaseType, t0, t1} ranges for phasePlugin's
// gaggimatePhases option. Shared by the profile editor and shot chart.
export function buildGmPhaseRanges(phases) {
  const ranges = [];
  let t = 0;
  (phases || []).forEach((ph, i) => {
    const dur = ph.duration || 5;
    ranges.push({ name: ph.name || `Phase ${i + 1}`, phaseType: ph.phase || 'brew', t0: t, t1: t + dur });
    t += dur;
  });
  return ranges;
}

// ── Phase background plugin ───────────────────────────────────────────────
// #814: the phase shading draws straight onto the canvas, so it cannot inherit
// anything from CSS. Its label text and divider were fixed light-on-dark values
// (rgba(147,197,253,.9) / rgba(251,191,36,.9) text, rgba(255,255,255,.35)
// divider) which disappeared against a light chart area. The translucent fills
// are fine either way — a 10-13% tint reads as a tint on any ground — so only
// the text and the divider switch.
const PHASE_INK = {
  dark:  { pre: 'rgba(147,197,253,0.9)',  ext: 'rgba(251,191,36,0.9)',  divider: 'rgba(255,255,255,0.35)' },
  light: { pre: 'rgba(21,79,138,0.95)',   ext: 'rgba(124,72,4,0.95)',   divider: 'rgba(0,0,0,0.35)' },
};
const _currentInk = () => PHASE_INK[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];

export const phasePlugin = {
  id: 'phases',
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea: { top, bottom, left, right }, scales: { x } } = chart;

    // GaggiMate: shade one region per named phase, before the datasets draw.
    const gmPhases = opts?.gaggimatePhases;
    if (gmPhases && Array.isArray(gmPhases) && gmPhases.length > 0) {
      ctx.save();
      for (const ph of gmPhases) {
        const px0 = Math.min(Math.max(x.getPixelForValue(ph.t0), left), right);
        const px1 = Math.min(Math.max(x.getPixelForValue(ph.t1), left), right);
        const w   = px1 - px0;
        if (w <= 0) continue;
        ctx.fillStyle = ph.phaseType === 'preinfusion' ? 'rgba(52,152,219,0.13)' : 'rgba(243,156,18,0.10)';
        ctx.fillRect(px0, top, w, bottom - top);
      }
      ctx.restore();
      return;
    }

    // Gaggiuino: two-region preinfusion/extraction shading.
    if (!opts?.preinfusion) return;
    const ink = _currentInk();
    const preEnd   = Math.min(Math.max(x.getPixelForValue(opts.preinfusion), left), right);
    const totalEnd = Math.min(Math.max(x.getPixelForValue(opts.preinfusion + opts.extraction), left), right);

    ctx.save();

    if (preEnd > left) {
      ctx.fillStyle = 'rgba(52,152,219,0.13)';
      ctx.fillRect(left, top, preEnd - left, bottom - top);
    }
    if (totalEnd > preEnd) {
      ctx.fillStyle = 'rgba(243,156,18,0.10)';
      ctx.fillRect(preEnd, top, totalEnd - preEnd, bottom - top);
    }

    ctx.beginPath();
    ctx.strokeStyle = ink.divider;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.moveTo(preEnd, top);
    ctx.lineTo(preEnd, bottom);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.font = '600 11px Figtree, sans-serif';
    const labelY = top + 34;
    if (preEnd - left > 40) {
      const lbl = window.t ? window.t('phase_preinfusion') : 'Preinfusion';
      const w   = ctx.measureText(lbl).width;
      ctx.fillStyle = 'rgba(52,152,219,0.22)';
      ctx.beginPath(); ctx.roundRect(left + 6, labelY - 12, w + 12, 16, 4); ctx.fill();
      ctx.fillStyle = ink.pre;
      ctx.textAlign = 'left'; ctx.fillText(lbl, left + 12, labelY);
    }
    if (totalEnd - preEnd > 60) {
      const lbl = window.t ? window.t('phase_extraction') : 'Extraktion';
      const w   = ctx.measureText(lbl).width;
      ctx.fillStyle = 'rgba(243,156,18,0.22)';
      ctx.beginPath(); ctx.roundRect(preEnd + 6, labelY - 12, w + 12, 16, 4); ctx.fill();
      ctx.fillStyle = ink.ext;
      ctx.textAlign = 'left'; ctx.fillText(lbl, preEnd + 12, labelY);
    }

    ctx.restore();
  },
  afterDatasetsDraw(chart, _args, opts) {
    const gmPhases = opts?.gaggimatePhases;
    if (!gmPhases || !Array.isArray(gmPhases) || gmPhases.length === 0) return;

    const { ctx, chartArea: { top, bottom, left, right }, scales: { x } } = chart;
    const ink = _currentInk();

    // Dividers + labels, drawn after the lines so they sit on top.
    ctx.save();
    ctx.font = '600 10px Figtree, sans-serif';

    for (let i = 0; i < gmPhases.length; i++) {
      const ph  = gmPhases[i];
      const px0 = Math.min(Math.max(x.getPixelForValue(ph.t0), left), right);
      const px1 = Math.min(Math.max(x.getPixelForValue(ph.t1), left), right);
      const w   = px1 - px0;
      if (w <= 0) continue;

      const isPreinf = ph.phaseType === 'preinfusion';

      if (i > 0) {
        ctx.beginPath();
        ctx.strokeStyle = ink.divider;
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1;
        ctx.moveTo(px0, top);
        ctx.lineTo(px0, bottom);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Rotated label fits narrower columns than a horizontal pill would.
      if (w > 10 && ph.name) {
        const maxLen = bottom - top - 16;
        let lbl = ph.name;
        while (lbl.length > 1 && ctx.measureText(lbl).width > maxLen) lbl = lbl.slice(0, -1);
        if (ctx.measureText(lbl).width <= maxLen) {
          const text = lbl.length < ph.name.length && lbl.length > 1 ? lbl.slice(0, -1) + '…' : lbl;
          const textWidth = ctx.measureText(text).width;
          ctx.save();
          // Anchor `textWidth` below the top edge, text grows upward from
          // there (rotate(-90) convention) — keeps it flush against the top.
          ctx.translate(px0 + Math.min(10, w / 2), top + 8 + textWidth);
          ctx.rotate(-Math.PI / 2);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = isPreinf ? ink.pre : ink.ext;
          ctx.fillText(text, 0, 0);
          ctx.restore();
        }
      }
    }

    ctx.restore();
  }
};

// ── Mobile: clear tooltip + crosshair on touchend ─────────────────────────
export function clearChartOnTouchEnd(chart) {
  chart.canvas.addEventListener('touchend', () => {
    if (chart.corsair) chart.corsair = { draw: false };
    chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    chart.update('none');
  }, { passive: true });
}

// ── Corsair crosshair ─────────────────────────────────────────────────────
export const corsairPlugin = {
  id: 'corsair',
  defaults: { width: 1, color: 'rgba(255,255,255,0.35)', dash: [4,4] },
  afterInit:  c => { c.corsair = { x: 0, y: 0 }; },
  afterEvent: (c, args) => { c.corsair = { x: args.event.x, y: args.event.y, draw: args.inChartArea }; c.draw(); },
  beforeDatasetsDraw: (c, _a, opts) => {
    if (!c.corsair) return;
    const { ctx } = c;
    const { top, bottom } = c.chartArea;
    const { x, draw } = c.corsair;
    if (!draw) return;
    ctx.save();
    ctx.beginPath();
    ctx.lineWidth = opts.width; ctx.strokeStyle = opts.color; ctx.setLineDash(opts.dash);
    ctx.moveTo(x, bottom); ctx.lineTo(x, top); ctx.stroke();
    ctx.restore();
  }
};
