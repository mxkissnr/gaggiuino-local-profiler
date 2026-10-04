// Coffee history (#1351): the hidden topbar machine panel's spiral of every
// shot ever pulled, with the emptied bags standing on a little shelf. Built
// entirely from data already in memory (S.allShots, S.coffeeLibrary) — nothing
// is computed or fetched until openEasterEggPanel() calls renderCoffeeHistory().
import { S } from '../state/index.js';
import { t } from '../i18n.js';
import { localeFor } from '../constants.js';
import { loadBeanImageBlobUrl, loadShotThumbBlobUrl } from '../bean-image.js';
import { scoreColor } from '../utils.js';

/** A shot row as S.allShots carries it (metadata-only, plus the annotation). */
export interface HistoryShot {
  id: number;
  timestamp: number;
  score?: number | null;
  image?: string | null;
  annotation?: {
    coffee?: string | null;
    dose?: number | null;
    score?: number | null;
  } | null;
}

export interface HistoryTile {
  id: number;
  hasPhoto: boolean;
  score: number | null;
  /** Unix ms (timestamp is stored in seconds). */
  date: number;
  beanName: string;
}

export interface HistoryStats {
  shots: number;
  bags: number;
  kg: number;
}

/** The library bean/bag fields the history reads (via S.coffeeLibrary). */
export interface HistoryBag {
  remainingG?: number | null;
  current?: boolean | null;
}
export interface HistoryBean {
  id?: number;
  name?: string;
  bags?: readonly HistoryBag[] | null;
}

// views/library/bags.ts's classifyBeanBags() owns this rule ("past" + the
// server's remainingG marks a tracked bag), but importing it would pull the
// whole library view — and its module-load `document` listener — into the
// topbar/panel import graph and break the DOM-free tests that import status.js
// or live.js. The rule is small, so state it here directly.
function isEmptiedBag(bag: HistoryBag): boolean {
  return !bag.current && bag.remainingG != null && bag.remainingG <= 0;
}

// Only the newest photo shots get a thumbnail — an old history keeps its
// crema tiles instead of firing hundreds of image requests at once.
const PHOTO_CAP = 120;

// Phyllotaxis constant: 360° × (1 − 1/φ) ≈ 137.508°.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Layout: outermost tile sits STAGE_SCALE% of the half-stage from the centre;
// CENTER_HOLE keeps the inner fraction free for the machine icon.
const STAGE_SCALE = 46;
const CENTER_HOLE = 0.34;
const TILE_ANIM_TOTAL_MS = 2000;
const BAG_ANIM_TOTAL_MS = 600;
const COUNTER_DURATION_MS = 1200;

/** Golden-angle phyllotaxis around (0,0): point `i` at radius `spacing·√(i+1)`. */
export function spiralPositions(n: number, spacing: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const radius = spacing * Math.sqrt(i + 1);
    const angle = i * GOLDEN_ANGLE;
    out.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return out;
}

/**
 * Shot count, the number of emptied bags across every bean (only bags the
 * server tracks stock for), and the summed dose in kg rounded to 0.1. Shots
 * without a dose count 0.
 */
export function historyStats(shots: readonly HistoryShot[], beans: readonly HistoryBean[]): HistoryStats {
  let bags = 0;
  for (const bean of beans) {
    for (const bag of bean.bags ?? []) {
      if (isEmptiedBag(bag)) bags++;
    }
  }
  let grams = 0;
  for (const shot of shots) {
    const dose = shot.annotation?.dose;
    if (typeof dose === 'number' && Number.isFinite(dose)) grams += dose;
  }
  return { shots: shots.length, bags, kg: Math.round(grams / 100) / 10 };
}

/**
 * Oldest first. Only the newest `cap` shots with a photo keep `hasPhoto` true;
 * older photo shots fall back to the crema tile so large histories stay fast.
 */
export function historyTiles(shots: readonly HistoryShot[], cap: number = PHOTO_CAP): HistoryTile[] {
  const ordered = [...shots].sort((a, b) => a.timestamp - b.timestamp);
  const withPhoto = ordered.filter(shot => !!shot.image);
  const photoIds = new Set(withPhoto.slice(Math.max(0, withPhoto.length - cap)).map(shot => shot.id));
  return ordered.map(shot => ({
    id: shot.id,
    hasPhoto: photoIds.has(shot.id),
    score: shot.score ?? shot.annotation?.score ?? null,
    date: shot.timestamp * 1000,
    beanName: shot.annotation?.coffee?.trim() ?? '',
  }));
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function formatCount(key: string, value: number, decimals: number): string {
  // Pass a real number for the integer counters so the formatters' n!==1
  // plural check works; kg stays a fixed-decimal string.
  return decimals > 0 ? t(key, value.toFixed(decimals)) : t(key, Math.round(value));
}

function tileDelay(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round((index / (count - 1)) * TILE_ANIM_TOTAL_MS);
}

function bagDelay(index: number, count: number): number {
  const span = count > 1 ? (index / (count - 1)) * BAG_ANIM_TOTAL_MS : 0;
  return TILE_ANIM_TOTAL_MS + 120 + Math.round(span);
}

function tileLabel(tile: HistoryTile): string {
  const parts = [new Date(tile.date).toLocaleDateString(localeFor(S.currentLang))];
  if (tile.beanName) parts.push(tile.beanName);
  if (tile.score != null) parts.push(String(tile.score));
  return parts.join(' · ');
}

interface EmptiedBag {
  beanId: number | null;
  name: string;
}

function emptiedBags(beans: readonly HistoryBean[]): EmptiedBag[] {
  const out: EmptiedBag[] = [];
  for (const bean of beans) {
    for (const bag of bean.bags ?? []) {
      if (isEmptiedBag(bag)) out.push({ beanId: bean.id ?? null, name: bean.name ?? '' });
    }
  }
  return out;
}

let _activeStop: (() => void) | null = null;

/**
 * Builds the spiral, shelf and counters into `host` and returns a stop handle
 * that cancels pending frames and frees the photo blob URLs from the DOM.
 */
export function renderCoffeeHistory(host: HTMLElement): () => void {
  _activeStop?.();
  _activeStop = null;

  const icon = document.getElementById('easterEggPanelIcon');
  const clear = (): void => {
    if (icon) host.replaceChildren(icon);
    else host.replaceChildren();
  };
  clear();

  const shots = S.allShots as unknown as HistoryShot[];
  const beans = S.coffeeLibrary.beans as unknown as HistoryBean[];
  const stats = historyStats(shots, beans);
  const tiles = historyTiles(shots, PHOTO_CAP);
  const bags = emptiedBags(beans);
  const reduced = prefersReducedMotion();

  let stopped = false;
  let raf = 0;

  const stage = document.createElement('div');
  stage.className = 'coffee-history-stage';
  if (icon) stage.appendChild(icon);

  const caption = document.createElement('p');
  caption.className = 'coffee-history-caption';
  caption.setAttribute('aria-live', 'polite');

  const showLabel = (event: Event): void => {
    const target = event.target as Element | null;
    const tile = target?.closest('.coffee-history-tile') as HTMLElement | null;
    const label = tile?.dataset.label;
    if (label) caption.textContent = label;
  };
  stage.addEventListener('focusin', showLabel);
  stage.addEventListener('click', showLabel);

  const spiral = spiralPositions(tiles.length, 1);
  const denom = Math.sqrt(Math.max(1, tiles.length));
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const pos = spiral[i];
    if (!tile || !pos) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `coffee-history-tile${tile.hasPhoto ? ' coffee-history-tile-photo' : ''}`;
    button.style.borderColor = scoreColor(tile.score);
    button.style.zIndex = String(i + 1);
    button.style.animationDelay = `${tileDelay(i, tiles.length)}ms`;
    const label = tileLabel(tile);
    button.setAttribute('aria-label', label);
    button.dataset.label = label;
    button.dataset.id = String(tile.id);
    const radius = Math.hypot(pos.x, pos.y) || 1;
    const fraction = CENTER_HOLE + (1 - CENTER_HOLE) * (radius / denom);
    button.style.left = `${50 + (pos.x / radius) * fraction * STAGE_SCALE}%`;
    button.style.top = `${50 + (pos.y / radius) * fraction * STAGE_SCALE}%`;
    if (tile.hasPhoto) {
      const img = document.createElement('img');
      img.className = 'coffee-history-photo';
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'lazy';
      button.appendChild(img);
      void loadShotThumbBlobUrl(tile.id).then(url => {
        if (stopped || !url) return;
        img.src = url;
        button.classList.add('coffee-history-tile-ready');
      });
    }
    stage.appendChild(button);
  }
  if (tiles.length === 0) caption.textContent = t('easter_egg_hist_empty');

  const shelf = document.createElement('div');
  shelf.className = 'coffee-history-shelf';
  for (let j = 0; j < bags.length; j++) {
    const bag = bags[j];
    if (!bag) continue;
    const bagEl = document.createElement('span');
    bagEl.className = 'coffee-history-bag';
    bagEl.title = bag.name;
    bagEl.style.animationDelay = `${bagDelay(j, bags.length)}ms`;
    if (bag.beanId != null) {
      const img = document.createElement('img');
      img.className = 'coffee-history-bag-img';
      img.alt = '';
      img.decoding = 'async';
      bagEl.appendChild(img);
      void loadBeanImageBlobUrl(bag.beanId).then(url => {
        if (stopped || !url) return;
        img.src = url;
        bagEl.classList.add('coffee-history-bag-ready');
      });
    }
    shelf.appendChild(bagEl);
  }

  const counters = document.createElement('div');
  counters.className = 'coffee-history-counters';
  const specs = [
    { key: 'easter_egg_hist_shots', final: stats.shots, decimals: 0 },
    { key: 'easter_egg_hist_bags', final: stats.bags, decimals: 0 },
    { key: 'easter_egg_hist_kg', final: stats.kg, decimals: 1 },
  ];
  const counterEls = specs.map(spec => {
    const el = document.createElement('span');
    el.className = 'coffee-history-counter';
    el.textContent = formatCount(spec.key, reduced ? spec.final : 0, spec.decimals);
    counters.appendChild(el);
    return { el, spec };
  });
  if (!reduced && specs.some(spec => spec.final > 0)) {
    const start = performance.now();
    const tick = (now: number): void => {
      if (stopped) return;
      const progress = Math.min(1, (now - start) / COUNTER_DURATION_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      for (const { el, spec } of counterEls) {
        el.textContent = formatCount(spec.key, spec.final * eased, spec.decimals);
      }
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
        for (const { el, spec } of counterEls) el.textContent = formatCount(spec.key, spec.final, spec.decimals);
      }
    };
    raf = requestAnimationFrame(tick);
  }

  host.append(stage, caption, shelf, counters);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    stage.removeEventListener('focusin', showLabel);
    stage.removeEventListener('click', showLabel);
    clear();
    if (_activeStop === stop) _activeStop = null;
  };
  _activeStop = stop;
  return stop;
}
