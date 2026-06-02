import de from './i18n/de.js';
import en from './i18n/en.js';
import it from './i18n/it.js';
import fr from './i18n/fr.js';
import es from './i18n/es.js';
import nl from './i18n/nl.js';

export const LOCALE_MAP = { de: 'de-DE', en: 'en-US', it: 'it-IT', fr: 'fr-FR', es: 'es-ES' };

export const TRANSLATIONS = { de, en, it, fr, es, nl };

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
