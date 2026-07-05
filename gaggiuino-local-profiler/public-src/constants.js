import de from './i18n/de.js';
import en from './i18n/en.js';
import it from './i18n/it.js';
import fr from './i18n/fr.js';
import es from './i18n/es.js';
import nl from './i18n/nl.js';

export const LOCALE_MAP = { de: 'de-DE', en: 'en-US', it: 'it-IT', fr: 'fr-FR', es: 'es-ES' };

export const TRANSLATIONS = { de, en, it, fr, es, nl };

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

export const VARIETY_SUGGESTIONS = ['Arabica', 'Robusta', 'Blend', 'Bourbon', 'Geisha',
  'Typica', 'Caturra', 'Catuai', 'SL28', 'SL34', 'Pacamara', 'Maragogype'];

export const PROCESS_SUGGESTIONS = ['Washed', 'Natural', 'Honey', 'Anaerobic'];

const _isCountryCode = c => typeof c === 'string' && /^[A-Z]{2}$/.test(c);

export function countryName(code, lang) {
  if (!_isCountryCode(code)) return code || '';
  try { return new Intl.DisplayNames([lang || 'en'], { type: 'region' }).of(code) || code; }
  catch { return code; }
}

export function flagEmoji(code) {
  if (!_isCountryCode(code)) return '';
  return String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

export const MAINT_META = {
  descaling:   { icon: '🧪', key: 'maint_descaling'   },
  backflush:   { icon: '🔄', key: 'maint_backflush'   },
  grouphead:   { icon: '🔧', key: 'maint_grouphead'   },
  gaskets:     { icon: '⭕', key: 'maint_gaskets'     },
  waterfilter: { icon: '💧', key: 'maint_waterfilter' },
};

// ── Phase background plugin ───────────────────────────────────────────────
export const phasePlugin = {
  id: 'phases',
  beforeDatasetsDraw(chart, _args, opts) {
    if (!opts?.preinfusion) return;
    const { ctx, chartArea: { top, bottom, left, right }, scales: { x } } = chart;
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
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
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
      ctx.fillStyle = 'rgba(147,197,253,0.9)';
      ctx.textAlign = 'left'; ctx.fillText(lbl, left + 12, labelY);
    }
    if (totalEnd - preEnd > 60) {
      const lbl = window.t ? window.t('phase_extraction') : 'Extraktion';
      const w   = ctx.measureText(lbl).width;
      ctx.fillStyle = 'rgba(243,156,18,0.22)';
      ctx.beginPath(); ctx.roundRect(preEnd + 6, labelY - 12, w + 12, 16, 4); ctx.fill();
      ctx.fillStyle = 'rgba(251,191,36,0.9)';
      ctx.textAlign = 'left'; ctx.fillText(lbl, preEnd + 12, labelY);
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
