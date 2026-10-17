import { S } from '../../state/index.js';
import { t, tHtml } from '../../i18n.js';
import { localeFor, COFFEE_COUNTRIES, COUNTRY_CENTROIDS, countryName, HOME_COUNTRY_NUM } from '../../constants.js';
import { esc, html, joinHtml, scoreClass, themeColor, onThemeChange } from '../../utils.js';
import type { Html } from '../../utils.js';
import { openDetailSheet } from '../../components/detail-sheet.js';
import type { DetailAnchorPoint } from '../../components/detail-sheet.js';
import { _beans, _counterPeriod, _pageShots } from './shared.js';
import type { SharedBean, ShotAnnotation } from './shared.js';

// World map: a bean's origins (a blend carries several), the per-country
// stats the tooltip reads back off a series datum, and the params ECharts
// hands a tooltip formatter.
interface MapOrigin { code: string; weight: number }
interface MapEntry { bean: SharedBean; origins: MapOrigin[] }
interface MapStats {
  shots: number;
  beans: Set<string>;
  beanShots: Map<string, number>;
  scoreSum: number;
  scoreCount: number;
  beanScoreSum: Map<string, number>;
  beanScoreCount: Map<string, number>;
}

interface MapTooltipParams {
  seriesType?: string;
  name?: string;
  data?: { _stats?: MapStats; _region?: string | null } | null;
}

// GeoJSON pieces the antimeridian splitting touches: topojson.feature()
// returns a FeatureCollection whose rings may cross the ±180° seam.
type Ring = number[][];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface GeoJsonGeometry {
  type: string;
  coordinates?: Polygon | MultiPolygon;
}

interface GeoJsonFeature {
  geometry: GeoJsonGeometry;
  properties: Record<string, unknown>;
  id?: string | number;
}

interface GeoJsonFeatureCollection { features: GeoJsonFeature[] }

interface WorldTopo { objects: { countries: unknown } }

// topojson-client ships no type declarations (see the dynamic import in
// buildWorldMap()); feature() is the only entry point used here.
interface TopojsonModule {
  feature(topology: WorldTopo, object: unknown): GeoJsonFeatureCollection;
}

// ── Origin world map ──────────────────────────────────────────────────────
// Choropleth + region points of coffee origins: shots are joined to library
// beans by name (case-insensitive, same precedent as the stock math) and
// colored by shot count; beans with an origin but no shots yet are still
// highlighted. Rendered with Apache ECharts (roam/zoom + scatter points),
// registered from countries-110m.json via topojson-client — both bundled
// as real npm deps (no CDN), the topojson data file itself is served
// locally (CSP connect-src 'self') and cached after the first Analytics visit.
let _worldTopo: WorldTopo | null = null;
let _worldMapRegistered = false;
let _echartsInstance: ReturnType<(typeof import('echarts'))['init']> | null = null;
let _resizeBound = false;
let _worldMapThemeListenerRegistered = false;
// #797: echarts + topojson-client (~380 kB gzip combined) are dynamic
// imports now, only fetched once the map actually has data to draw — cached
// as a promise (not the resolved modules) so a second buildWorldMap() call
// racing the first one's still-in-flight import reuses the same request
// instead of firing a duplicate one.
let _mapLibsPromise: Promise<[typeof import('echarts'), TopojsonModule]> | null = null;

// #648: buildWorldMap() is fired unawaited from initAnalytics(), which can
// itself run again (re-navigating to Analytics) before a prior call's
// countries-110m.json fetch has resolved. A monotonic token guard, same
// pattern shots/index.js's loadData() uses (#644), makes sure only the
// still-latest call writes _worldTopo / touches the DOM after the await.
let _worldMapReqToken = 0;

// #1467: the home point ([lon, lat]) resolved once from the registered world
// geometry for the locale's country — null when the locale has no region or
// it isn't a HOME_COUNTRY_NUM entry, which just means no routes are drawn.
let _worldMapHome: [number, number] | null = null;
// #1467: the map click handler is bound once per echarts instance, so it
// reads the latest aggregation/home from here instead of closing over one
// build's locals.
let _mapClickData: { byCode: Record<string, MapStats>; home: [number, number] | null } | null = null;
// #1467: ECharts names a map region from its GeoJSON properties.name (the
// full country name), while the map data and detail sheet key countries by
// ISO code — this maps the former to the latter for click-through.
let _mapNameToCode: Map<string, string> | null = null;
// #1543: each origin country's [minLon, minLat, maxLon, maxLat] from the
// registered world geometry, so the initial map frame can cover a country's
// full extent and not just its centre.
let _mapCodeBounds: Map<string, [number, number, number, number]> | null = null;

// Converts a #rrggbb (or #rgb) hex color to an rgba() string at the given
// alpha; falls back to the raw input unchanged if it isn't hex (e.g. an
// already-rgba CSS custom property value).
function _hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{3}|[a-f\d]{6})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  let h = m[1] ?? '';
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16);
  const r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

// #1024: every color ECharts needs for the map was a hardcoded dark-theme
// literal (backgroundColor, geo/land fill+borders) except accentTo/mutedText,
// which already resolved live from CSS custom properties — the same class of
// bug #814 fixed for Chart.js charts (chartColors()/themeColor(), both in
// utils.js). Resolved here the same way, via themeColor() + _hexToRgba(),
// and factored into its own function so both the initial setOption() below
// and the onThemeChange repaint further down build the exact same colors.
// MUST be called at paint time, not cached — see themeColor()'s own comment.
//
// Token choices: background from --gray-900 (page-background role; dark
// theme's #131416 keeps this visually close to the old rgba(9,9,11,.55)
// literal, light theme's #f7f7f6 gives a light wash instead of a dark box),
// land fill from --gray-600 and borders from --gray-500 (the app's two
// "muted chrome" roles elsewhere, e.g. chartColors()'s own tick color) —
// alphas (.55/.4/.7/.6) kept identical to the original literals.
export function resolveWorldMapColors() {
  const bg     = themeColor('--gray-900', '#131416');
  const land   = themeColor('--gray-600', '#93989c');
  const border = themeColor('--gray-500', '#a4a9ad');
  return {
    accentTo:          themeColor('--accent-to', '#f97316'),
    mutedText:         themeColor('--gray-500', '#71717a'),
    backgroundColor:   _hexToRgba(bg, .55),
    areaColor:         _hexToRgba(land, .4),
    emphasisAreaColor: _hexToRgba(land, .6),
    borderColor:       _hexToRgba(border, .7),
    // Text-outline halo behind a bean's map label, meant to keep it legible
    // over the (accent-colored) land/scatter point beneath it regardless of
    // theme — same background role as `bg` above, not a separate token.
    textBorderColor:   _hexToRgba(bg, .7),
  };
}

// #1024: unlike the Chart.js charts (which re-theme in place via
// applyChartTheme(), see main.js's onThemeChange() registration), the map
// never repainted on a theme switch at all — switching Dark/Light/Auto while
// Statistics was already open left it on whatever colors it was built with.
// Partial setOption() (no notMerge flag) only touches the color-bearing keys
// below — no need to refetch topojson or redo the beans/shots aggregation.
function _repaintWorldMapTheme() {
  if (!_echartsInstance) return; // map not built yet (view closed / no data)
  const c = resolveWorldMapColors();
  _echartsInstance.setOption({
    backgroundColor: c.backgroundColor,
    geo: {
      itemStyle: { areaColor: c.areaColor, borderColor: c.borderColor },
      emphasis: { itemStyle: { areaColor: c.emphasisAreaColor } },
    },
    series: [
      { itemStyle: { areaColor: c.accentTo, borderColor: c.borderColor } },
      { itemStyle: { color: c.accentTo, shadowColor: _hexToRgba(c.accentTo, .6) }, label: { color: c.mutedText, textBorderColor: c.textBorderColor } },
      { lineStyle: { color: _hexToRgba(c.accentTo, .35) } },
      { itemStyle: { color: themeColor('--gray-300', '#d4d4d8') } },
    ],
  });
}

// Pure helper (unit-testable): given a list of [lon, lat] coordinates with
// data on the map, returns ECharts `geo.boundingCoords` ([[west, north],
// [east, south]]) that frames them instead of defaulting to the whole globe.
// The box is padded, clamped to valid lon/lat and widened symmetrically to a
// minimum span so a single origin still gets context.
export function computeMapBoundingCoords(coords: (number[] | null | undefined)[] | null): [[number, number], [number, number]] | undefined {
  const valid = (coords || []).filter((c): c is [number, number] => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  if (!valid.length) return undefined;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of valid) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  let west = minLon - 8, east = maxLon + 8, south = minLat - 6, north = maxLat + 6;
  // Widen symmetrically so a single origin still shows neighbouring context.
  const MIN_LON_SPAN = 30, MIN_LAT_SPAN = 20;
  if (east - west < MIN_LON_SPAN) { const pad = (MIN_LON_SPAN - (east - west)) / 2; west -= pad; east += pad; }
  if (north - south < MIN_LAT_SPAN) { const pad = (MIN_LAT_SPAN - (north - south)) / 2; south -= pad; north += pad; }
  west = Math.max(-180, west); east = Math.min(180, east);
  south = Math.max(-85, south); north = Math.min(85, north);
  return [[west, north], [east, south]];
}

// Pure helper (unit-testable): the [lon, lat] corners to feed the map frame so
// each origin country's full extent — not just its centroid — sits inside the
// initial view. A country wider than the padding (India) would otherwise be
// cut off at the edge. Countries with no known bounds are skipped (#1543).
export function originFrameCoords(codes: string[], bounds: Map<string, [number, number, number, number]>): [number, number][] {
  const out: [number, number][] = [];
  for (const code of codes) {
    const b = bounds.get(code);
    if (!b) continue;
    out.push([b[0], b[1]], [b[2], b[3]]);
  }
  return out;
}

// Pure helper (unit-testable): splits a ring's [lon, lat] coordinate array
// wherever two consecutive points jump by more than 180° of longitude — the
// signature of a landmass crossing the antimeridian in raw topojson→GeoJSON
// output. topojson.feature() does not cut rings at the seam, so ECharts ends
// up drawing a straight line across the whole map connecting e.g. lon=178.7
// to lon=-180. This inserts an interpolated point at lon=±180 at the split
// and returns each side as its own closed ring, so the caller can promote
// each into a separate polygon instead of one ring drawing a seam-spanning
// line. Pragmatic, not geodetically exact — good enough to kill the artifact.
// Closes a ring piece (appends its own first point) so first === last. If a
// direct close would itself cross the seam (the piece's start and end sit on
// opposite ±180 sides — this happens for a piece that both entered and exited
// through the antimeridian, e.g. a circumpolar coastline like Antarctica's),
// route the closing edge along the map border via the nearest pole instead
// of drawing straight across the map.
function _closeRingPiece(seg: Ring): Ring {
  const first = seg[0], lastPt = seg[seg.length - 1];
  if (!first || !lastPt) return seg;
  const [fx = 0, fy = 0] = first;
  const [lx = 0, ly = 0] = lastPt;
  if (fx === lx && fy === ly) return seg;
  if (Math.abs(fx - lx) > 180) {
    const pole = ly < 0 ? -90 : 90;
    const sideOut = lx > 0 ? 180 : -180;
    const sideIn  = fx > 0 ? 180 : -180;
    seg.push([sideOut, pole], [sideIn, pole], first);
  } else {
    seg.push(first);
  }
  return seg;
}

export function splitAntimeridianRing(ring: Ring): Ring[] {
  if (!Array.isArray(ring) || ring.length < 2) return [ring];
  // A ring's own closing edge (last point deep-equal to the first) can be
  // the one that jumps the seam — a circumpolar coastline (e.g. Antarctica's
  // 110m outline) that sweeps through every longitude and happens to be
  // encoded starting/ending exactly at the antimeridian. That's not two
  // separate landmasses either side of the date line (unlike Russia/Fiji),
  // so it isn't split into pieces — instead _closeRingPiece() below routes
  // that closing edge along the map border (nearest pole) instead of cutting
  // straight across, the standard way flat equirectangular maps render a
  // polygon that touches both the left and right edges.
  const firstPt = ring[0];
  const last = ring[ring.length - 1];
  if (!firstPt || !last) return [ring];
  const closesAtStart = last[0] === firstPt[0] && last[1] === firstPt[1];
  const scanEnd = closesAtStart ? ring.length - 1 : ring.length;
  const segments: Ring[] = [[firstPt]];
  for (let i = 1; i < scanEnd; i++) {
    const prev = ring[i - 1];
    const cur = ring[i];
    const current = segments[segments.length - 1];
    if (!prev || !cur || !current) continue;
    const lon1 = prev[0] ?? 0;
    const lon2 = cur[0] ?? 0;
    const lat2 = cur[1] ?? 0;
    const dLon = lon2 - lon1;
    if (Math.abs(dLon) > 180) {
      // Crossing the seam: close the current segment on this side, start a
      // new one on the other side, both anchored at the same interpolated
      // latitude on their respective edge (+180 or -180).
      const side1 = lon1 > 0 ? 180 : -180;
      const side2 = lon2 > 0 ? 180 : -180;
      current.push([side1, lat2]);
      segments.push([[side2, lat2]]);
    } else {
      current.push([lon2, lat2]);
    }
  }
  if (segments.length === 1) {
    const only = segments[0];
    if (!only) return [ring];
    return [closesAtStart ? _closeRingPiece(only) : only];
  }
  // A jump landing exactly on a closed ring's own closing edge produces a
  // degenerate 1-point trailing segment — not a renderable ring. Drop
  // segments with fewer than 2 distinct points before closing.
  const usable = segments.filter(seg => seg.length >= 2);
  if (usable.length === 0) return [ring];
  // Every surviving piece needs to be independently closed — a piece that
  // both entered and exited through the seam (start and end on opposite
  // ±180 sides) must NOT be closed by a direct chord back to its own start,
  // same fix as the circumpolar single-ring case above.
  return usable.map(_closeRingPiece);
}

// Splits a single polygon's rings (outer + holes) at the antimeridian. If no
// ring in the polygon crosses the seam, returns the polygon unchanged (as a
// single-element array so the caller can flatten uniformly). If any ring
// does cross, every resulting piece — from the outer ring or a hole — is
// promoted to its own independent single-ring polygon; the original
// outer/hole relationship isn't preserved for split pieces, which is a
// deliberate simplification (see buildWorldMap comment) since perfect
// topology at the seam isn't the goal, just killing the line artifact.
function _splitPolygonAtAntimeridian(rings: Polygon): Ring[][] {
  const allPieces: Ring[] = [];
  let anySplit = false;
  for (const ring of rings) {
    const pieces = splitAntimeridianRing(ring);
    if (pieces.length > 1) anySplit = true;
    allPieces.push(...pieces);
  }
  if (!anySplit) return [rings];
  return allPieces.map(piece => [piece]);
}

// Applies antimeridian splitting to an entire GeoJSON geometry (Polygon or
// MultiPolygon), promoting any split-off ring pieces into standalone
// polygons of a MultiPolygon rather than leaving them as extra rings of one
// polygon (which would be misread as holes). Other geometry types pass
// through unchanged.
function _splitGeometryAtAntimeridian(geometry: GeoJsonGeometry): GeoJsonGeometry {
  if (!geometry) return geometry;
  if (geometry.type === 'Polygon') {
    const polys = _splitPolygonAtAntimeridian(geometry.coordinates as Polygon);
    if (polys.length === 1) return geometry;
    return { type: 'MultiPolygon', coordinates: polys };
  }
  if (geometry.type === 'MultiPolygon') {
    const outPolys = [];
    let changed = false;
    for (const rings of geometry.coordinates as MultiPolygon) {
      const polys = _splitPolygonAtAntimeridian(rings);
      if (polys.length !== 1) changed = true;
      outPolys.push(...polys);
    }
    if (!changed) return geometry;
    return { type: 'MultiPolygon', coordinates: outPolys };
  }
  return geometry;
}

// World-map tooltip content, factored out of buildWorldMap()'s setOption()
// call so it can be unit-tested without echarts/DOM (same reasoning as
// computeMapBoundingCoords/splitAntimeridianRing above). Bean names and regions
// reach this from the Library (typed by hand) or the bean importer (scraped
// from a roaster's website), so both branches escape everything that isn't a
// fixed country code or a plain number before it's handed to echarts, which
// renders a formatter's return value as tooltip innerHTML (#1054).
export function worldMapTooltipFormatter(params: MapTooltipParams) {
  if (params.seriesType === 'map') {
    const stats = params.data?._stats;
    if (!stats) return null;
    const name = countryName(params.name, S.currentLang);
    // Annotate a bean's weighted contribution only when it's a blend
    // (non-integer share) — a single-origin bean's full count is
    // already implied by the total, no need to repeat it per-bean.
    const beanList = [...stats.beans].map(beanName => {
      const share = stats.beanShots.get(beanName);
      return Number.isInteger(share) ? esc(beanName) : `${esc(beanName)} (${Math.round(share ?? 0)})`;
    }).join(', ');
    return `${name}: ${Math.round(stats.shots)} ${t('analytics_map_shots')} (${beanList})`;
  }
  const region = params.data?._region;
  return `${esc(params.name)}${region ? ' · ' + esc(region) : ''}`;
}

// ── Origin map: home country, routes, chips and click-through (#1467) ─────
// The country the user brews in, from the browser's UI language. Intl.Locale
// maximize() fills in the likely region ("de" -> DE, "nl" -> NL); null when
// the tag can't be resolved, which simply means the map draws no routes.
// Nothing is stored or sent — a local convenience, not a setting.
export function homeCountryFromLocale(lang: string | undefined): string | null {
  if (typeof lang !== 'string' || !lang.trim()) return null;
  try {
    const region = new Intl.Locale(lang).maximize().region;
    return region ? region.toUpperCase() : null;
  } catch {
    return null;
  }
}

// [lon, lat] centre of the largest polygon's bounding box in a Polygon or
// MultiPolygon. Ranking by area keeps e.g. mainland France from being pulled
// out to its overseas territories.
export function featureLabelPoint(geometry: GeoJsonGeometry | null | undefined): [number, number] | null {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const polygons: Polygon[] = geometry.type === 'Polygon'
    ? [geometry.coordinates as Polygon]
    : geometry.type === 'MultiPolygon' ? (geometry.coordinates as MultiPolygon) : [];
  let best: { area: number; bbox: [number, number, number, number] } | null = null;
  for (const rings of polygons) {
    const outer = rings?.[0];
    if (!Array.isArray(outer) || outer.length < 3) continue;
    const bbox = _ringBbox(outer);
    if (!bbox) continue;
    const area = Math.abs(_ringArea(outer));
    if (!best || area > best.area) best = { area, bbox };
  }
  if (!best) return null;
  const [minLon, minLat, maxLon, maxLat] = best.bbox;
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

// [minLon, minLat, maxLon, maxLat] over every coordinate of a Polygon or
// MultiPolygon. featureLabelPoint() ranks a country's parts by area; this is
// its counterpart for the whole extent, used to frame an origin country
// rather than only its centre (#1543).
export function featureBounds(geometry: GeoJsonGeometry | null | undefined): [number, number, number, number] | null {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const polygons: Polygon[] = geometry.type === 'Polygon'
    ? [geometry.coordinates as Polygon]
    : geometry.type === 'MultiPolygon' ? (geometry.coordinates as MultiPolygon) : [];
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  let any = false;
  for (const rings of polygons) {
    for (const ring of rings) {
      const bbox = _ringBbox(ring);
      if (!bbox) continue;
      any = true;
      if (bbox[0] < minLon) minLon = bbox[0];
      if (bbox[1] < minLat) minLat = bbox[1];
      if (bbox[2] > maxLon) maxLon = bbox[2];
      if (bbox[3] > maxLat) maxLat = bbox[3];
    }
  }
  return any ? [minLon, minLat, maxLon, maxLat] : null;
}

function _ringBbox(ring: number[][]): [number, number, number, number] | null {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  let any = false;
  for (const point of ring) {
    const lon = point?.[0], lat = point?.[1];
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;
    any = true;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return any ? [minLon, minLat, maxLon, maxLat] : null;
}

// Shoelace area (absolute) — only used to rank a MultiPolygon's parts, so raw
// lon/lat units (not km) are fine.
function _ringArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const ax = a?.[0] ?? 0, ay = a?.[1] ?? 0, bx = b?.[0] ?? 0, by = b?.[1] ?? 0;
    sum += ax * by - bx * ay;
  }
  return sum / 2;
}

// Great-circle distance in km (haversine) between two [lon, lat] points.
export function greatCircleKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Chips live just below the fixed-height map wrapper, as a sibling in the
// same analytics card.
function _mapChipsHost(wrap: HTMLElement): HTMLElement | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const card = wrap.parentElement;
  if (!card) return null;
  const existing = typeof card.querySelector === 'function' ? card.querySelector<HTMLElement>('.map-chips') : null;
  if (existing) return existing;
  const chips = document.createElement('div');
  chips.className = 'map-chips';
  if (typeof wrap.insertAdjacentElement === 'function') wrap.insertAdjacentElement('afterend', chips);
  else card.appendChild(chips);
  return chips;
}

function _clearMapExtras(wrap: HTMLElement): void {
  const card = wrap.parentElement;
  if (!card || typeof card.querySelector !== 'function') return;
  const chips = card.querySelector<HTMLElement>('.map-chips');
  if (chips) chips.innerHTML = html``;
  const count = card.querySelector<HTMLElement>('.analytics-map-count');
  if (count) count.remove();
}

function _renderMapChips(wrap: HTMLElement, countries: string[], byCode: Record<string, MapStats>): void {
  const host = _mapChipsHost(wrap);
  if (!host) return;
  host.innerHTML = joinHtml(countries.map(code =>
    html`<button type="button" class="chip analytics-filter-btn" data-code="${esc(code)}">${esc(countryName(code, S.currentLang))} ${esc(Math.round(byCode[code]?.shots ?? 0))}</button>`));
  if (typeof host.querySelectorAll !== 'function') return;
  host.querySelectorAll<HTMLElement>('.chip').forEach(chip => {
    const code = chip.dataset.code;
    if (!code) return;
    chip.addEventListener('click', () => _openCountryDetail(code, chip));
  });
}

function _renderMapHeadingCount(wrap: HTMLElement, n: number): void {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  const card = wrap.parentElement;
  if (!card || typeof card.querySelector !== 'function') return;
  const title = card.querySelector<HTMLElement>('.analytics-section-title');
  if (!title) return;
  const old = title.querySelector<HTMLElement>('.analytics-map-count');
  if (old) old.remove();
  const span = document.createElement('span');
  span.className = 'meta-sub analytics-map-count';
  span.textContent = t('analytics_map_count', n);
  title.appendChild(span);
}

// Detail sheet for one origin country: its beans (shot count + average score)
// and — when a home point exists — the distance to the user's cup.
function _openCountryDetail(code: string, anchor: HTMLElement | DetailAnchorPoint | null): void {
  const stats = _mapClickData?.byCode[code];
  if (!stats) return;
  const locale = localeFor(S.currentLang);
  const avg = stats.scoreCount ? Math.round(stats.scoreSum / stats.scoreCount) : null;
  const rows: Html[] = [...stats.beanShots.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([beanName, share]) => {
      const count = stats.beanScoreCount.get(beanName) ?? 0;
      const sum = stats.beanScoreSum.get(beanName) ?? 0;
      const beanAvg = count ? Math.round(sum / count) : null;
      const scHtml = beanAvg !== null ? html`<span class="${esc(scoreClass(beanAvg))}">${esc(beanAvg)}</span>` : esc('—');
      return html`<div class="bests-row"><span class="bests-lbl">${esc(beanName)}</span><span class="bests-val">${esc(Math.round(share))} · ${scHtml}</span></div>`;
    });
  const centroid = COUNTRY_CENTROIDS[code];
  const home = _mapClickData?.home;
  if (home && centroid) {
    const km = Math.round(greatCircleKm(centroid, home) / 10) * 10;
    rows.push(html`<div class="bests-row"><span class="bests-lbl">${tHtml('analytics_map_distance')}</span><span class="bests-val">${esc(km.toLocaleString(locale))} km</span></div>`);
  }
  openDetailSheet({
    title: countryName(code, S.currentLang),
    sub: t('analytics_map_sub', Math.round(stats.shots), avg),
    body: html`<div class="detail-rows">${joinHtml(rows)}</div>`,
    anchor,
  });
}

interface MapClickParams {
  seriesType?: string;
  name?: string;
  data?: { _code?: string };
  event?: { clientX?: number; clientY?: number; event?: { clientX?: number; clientY?: number } };
}

// Bound once per echarts instance; reads _mapClickData for the latest build.
function _onMapClick(raw: unknown): void {
  const params = raw as MapClickParams;
  let code = params.seriesType === 'map' ? params.name : params.data?._code;
  if (!code) return;
  // Map regions are named by full country name; translate to the ISO code the
  // detail sheet keys on (an already-code name passes through unchanged).
  code = _mapNameToCode?.get(code) ?? code;
  const native = params.event?.event ?? params.event;
  const anchor = native && typeof native.clientX === 'number' && typeof native.clientY === 'number'
    ? { x: native.clientX, y: native.clientY }
    : null;
  _openCountryDetail(code, anchor);
}

export async function buildWorldMap() {
  const token = ++_worldMapReqToken;
  const wrap = document.getElementById('worldMapWrap');
  if (!wrap) return;

  const counterEl = document.getElementById('worldMapCount');
  if (counterEl) counterEl.textContent = _counterPeriod();

  // #1024: register once ever, not once per buildWorldMap() call (mirrors
  // the _worldMapRegistered guard below for echarts.registerMap) -- the
  // listener itself is a no-op via _repaintWorldMapTheme()'s _echartsInstance
  // check whenever the map hasn't been built yet. Guarded on `window` existing
  // since onThemeChange() (utils.js) binds to it unconditionally, and this
  // function is also exercised in headless unit tests with no window global
  // (test/analytics-world-map-race.test.js).
  if (!_worldMapThemeListenerRegistered && typeof window !== 'undefined') {
    onThemeChange(_repaintWorldMapTheme);
    _worldMapThemeListenerRegistered = true;
  }

  // bean name (lowercased) → { bean, origins:[{code, weight}] }, restricted to
  // known coffee countries. A blend's weights come from its per-country
  // percent when set (normalized to sum to 1), else split equally across its
  // origin countries — so one shot of a 2-country blend contributes 0.5 to
  // each by default, or e.g. 0.7/0.3 when weighted.
  const nameToBean = new Map<string, MapEntry>();
  const idToBean   = new Map<number, MapEntry>();
  for (const b of _beans()) {
    const rawOrigins: { code?: string | null; percent?: number | null }[] =
      Array.isArray(b.origins) && b.origins.length ? b.origins : (b.origin ? [{ code: b.origin }] : []);
    const valid = rawOrigins.filter(o => COFFEE_COUNTRIES.some(c => c.code === o.code));
    if (!valid.length) continue;
    const totalPercent = valid.reduce((sum, o) => sum + (o.percent || 0), 0);
    const origins = valid.map(o => ({
      code: o.code as string,
      weight: totalPercent > 0 ? (o.percent || 0) / totalPercent : 1 / valid.length,
    }));
    const entry = { bean: b, origins };
    nameToBean.set(String(b.name || '').toLowerCase(), entry);
    if (b.id != null) idToBean.set(b.id, entry);
  }
  // #456: beanId-first lookup (survives bean renames), falling back to the
  // name key for annotations that predate beanId or a name that no longer
  // resolves to any current bean.
  const resolveMapEntry = (ann: ShotAnnotation | null | undefined): MapEntry | undefined =>
    (ann?.beanId != null && idToBean.get(ann.beanId))
    || nameToBean.get(String(ann?.coffee || '').toLowerCase());

  // code → { shots, beans:Set, beanShots:Map } — beans with an origin count
  // even without shots; beanShots tracks each bean's own weighted
  // contribution to this country (only interesting — i.e. non-integer —
  // for blends), used to annotate the tooltip.
  const byCode: Record<string, MapStats> = {};
  for (const { bean, origins } of nameToBean.values()) {
    for (const o of origins) {
      let codeStats = byCode[o.code];
      if (!codeStats) {
        codeStats = { shots: 0, beans: new Set(), beanShots: new Map(), scoreSum: 0, scoreCount: 0, beanScoreSum: new Map(), beanScoreCount: new Map() };
        byCode[o.code] = codeStats;
      }
      codeStats.beans.add(bean.name);
      if (!codeStats.beanShots.has(bean.name)) codeStats.beanShots.set(bean.name, 0);
    }
  }
  for (const s of _pageShots()) {
    const entry = resolveMapEntry(s.annotation);
    if (!entry) continue;
    const score = window.calcShotScore ? window.calcShotScore(s) : null;
    for (const o of entry.origins) {
      const stats = byCode[o.code];
      if (!stats) continue;
      stats.shots += o.weight;
      stats.beanShots.set(entry.bean.name, (stats.beanShots.get(entry.bean.name) ?? 0) + o.weight);
      if (score !== null) {
        stats.scoreSum += score;
        stats.scoreCount++;
        stats.beanScoreSum.set(entry.bean.name, (stats.beanScoreSum.get(entry.bean.name) ?? 0) + score);
        stats.beanScoreCount.set(entry.bean.name, (stats.beanScoreCount.get(entry.bean.name) ?? 0) + 1);
      }
    }
  }
  for (const stats of Object.values(byCode)) {
    stats.shots = Math.round(stats.shots * 10) / 10;
    for (const [name, val] of stats.beanShots) stats.beanShots.set(name, Math.round(val * 10) / 10);
  }

  if (Object.keys(byCode).length === 0) {
    if (_echartsInstance) { _echartsInstance.dispose(); _echartsInstance = null; }
    wrap.innerHTML = html`<p class="empty-note">${tHtml('analytics_map_empty')}</p>`;
    _clearMapExtras(wrap);
    return;
  }

  // #1467: origin countries that actually have shots, most-brewed first —
  // the chips row, the heading counter and the routes all key off this list.
  const countriesWithShots = Object.keys(byCode)
    .filter(code => (byCode[code]?.shots ?? 0) > 0)
    .sort((a, b) => (byCode[b]?.shots ?? 0) - (byCode[a]?.shots ?? 0));
  if (!wrap.querySelector('.world-map-canvas')) {
    wrap.innerHTML = html`<div class="world-map-canvas" style="width:100%;height:100%"></div>
      <div class="world-map-hint">${tHtml('analytics_map_zoom_hint')}</div>`;
  }
  const container = wrap.querySelector<HTMLElement>('.world-map-canvas')!;

  if (!_worldTopo) {
    let topo: WorldTopo;
    try { topo = await (await fetch('countries-110m.json')).json() as WorldTopo; }
    catch {
      if (token !== _worldMapReqToken) return; // a newer call has since taken over
      wrap.innerHTML = html`<p class="empty-note">${tHtml('analytics_map_empty')}</p>`;
      return;
    }
    if (token !== _worldMapReqToken) return; // a newer call has since taken over
    // Guarded above by the token check — not a real race.
    _worldTopo = topo;
  }

  // #797: echarts + topojson-client only ship once there's actually
  // something to draw (not on every Analytics visit). _mapLibsPromise
  // caches the in-flight import so a second buildWorldMap() call racing
  // this one's chunk download reuses the same request instead of firing a
  // duplicate one.
  let echarts: typeof import('echarts');
  let topojson: TopojsonModule;
  try {
    if (!_mapLibsPromise) {
      // @ts-expect-error -- topojson-client 3.1.0 ships no type declarations
      _mapLibsPromise = Promise.all([import('echarts'), import('topojson-client')]);
      container.innerHTML = html`<p class="empty-note">${tHtml('analytics_map_loading')}</p>`;
    }
    [echarts, topojson] = await _mapLibsPromise;
  } catch {
    // A concurrent call resetting the same promise to null is idempotent, not a real race.
    _mapLibsPromise = null; // don't cache a rejected promise — allow a retry on the next navigation
    if (token !== _worldMapReqToken) return; // a newer call has since taken over
    wrap.innerHTML = html`<p class="empty-note">${tHtml('analytics_map_unavailable')}</p>`;
    return;
  }
  if (token !== _worldMapReqToken) return; // a newer call has since taken over

  if (!_worldMapRegistered) {
    const geo = topojson.feature(_worldTopo, _worldTopo.objects.countries);
    // Some countries' geometries cross the ±180° antimeridian (e.g. Russia,
    // Fiji); topojson.feature() doesn't cut rings there, which makes ECharts
    // draw a straight line across the whole map connecting the two edges.
    // Split those rings before they're used for anything.
    for (const f of geo.features) f.geometry = _splitGeometryAtAntimeridian(f.geometry);
    const numToCode = new Map(COFFEE_COUNTRIES.map(c => [c.num, c.code]));
    for (const f of geo.features) f.properties = { ...f.properties, code: numToCode.get(String(f.id)) || null };
    // #1467: ECharts fires a map click with the region's full name; remember
    // the name -> ISO code relationship so click-through can resolve it.
    _mapNameToCode = new Map<string, string>();
    // #1543: remember each origin's full extent so the frame can cover it.
    _mapCodeBounds = new Map<string, [number, number, number, number]>();
    for (const f of geo.features) {
      const props = f.properties as { name?: string; code?: string | null };
      if (props.name && props.code) _mapNameToCode.set(props.name, props.code);
      if (props.code) {
        const bounds = featureBounds(f.geometry);
        if (bounds) _mapCodeBounds.set(props.code, bounds);
      }
    }
    // #1467: place the home point on the registered geometry once — the
    // bounding-box centre of the home country's largest landmass.
    if (!_worldMapHome) {
      const homeCode = homeCountryFromLocale(typeof navigator !== 'undefined' ? navigator.language : undefined);
      const homeNum = homeCode ? HOME_COUNTRY_NUM[homeCode] : undefined;
      const homeFeature = homeNum ? geo.features.find(f => String(f.id) === homeNum) : undefined;
      _worldMapHome = homeFeature ? featureLabelPoint(homeFeature.geometry) : null;
    }
    // topojson-client ships no types, so its GeoJSON output can't be matched to ECharts' map input.
    echarts.registerMap('world', geo as unknown as Parameters<typeof echarts.registerMap>[1]);
    _worldMapRegistered = true;
  }

  const mapData = Object.entries(byCode).map(([code, d]) => ({
    name: code,
    value: 1, // presence only — fill color is boolean, not shot-count driven
    _stats: d,
  }));

  // Scatter points: bean.location if geocoded, else the country centroid
  // (jittered a few tenths of a degree per extra bean so points don't stack).
  const seenAtCentroid: Record<string, number> = {};
  const points: { name: string; value: number[]; _region: string | null; _code: string }[] = [];
  for (const { bean, origins } of nameToBean.values()) {
    // Even a blend gets exactly one map point — from its geocoded growing
    // region if resolved, else a centroid fallback keyed on its primary
    // (first-listed) origin country.
    const primary = origins[0];
    if (!primary) continue;
    const primaryCode = primary.code;
    let coord: number[] | null = bean.location ? [bean.location.lon, bean.location.lat] : null;
    if (!coord) {
      const centroid = COUNTRY_CENTROIDS[primaryCode];
      if (!centroid) continue;
      const n = (seenAtCentroid[primaryCode] = (seenAtCentroid[primaryCode] || 0) + 1) - 1;
      const jitter = n * 0.35;
      coord = [centroid[0] + (n % 2 === 0 ? jitter : -jitter), centroid[1] + (n % 3) * 0.2];
    }
    const shots = byCode[primaryCode]?.beans.has(bean.name)
      ? _pageShots().filter(s => resolveMapEntry(s.annotation)?.bean === bean).length
      : 0;
    // #1467: the always-visible bean-name labels are gone (the chips below
    // the map replace them); the tooltip still names the bean. _code keys the
    // point back to its primary origin country for click-through.
    points.push({ name: bean.name, value: [...coord, shots], _region: bean.region || null, _code: primaryCode });
  }

  // Brand + chrome colors, read live from the CSS custom properties so the
  // map follows whichever accent/theme the user has picked (#1024: this used
  // to be true only for accentTo/mutedText, with the rest hardcoded dark).
  const c = resolveWorldMapColors();

  if (!_echartsInstance) {
    container.innerHTML = html``; // clear the loading message before echarts takes over this node
    _echartsInstance = echarts.init(container);
    // #1467: one click handler per instance; it reads _mapClickData.
    _echartsInstance.on('click', _onMapClick);
  }

  const home = _worldMapHome;
  const mapPoints = [
    // #1543: frame each origin by its full country extent — a country wider
    // than the padding (India) would otherwise be cut off at the edge — plus
    // the bean points and the home point. computeMapBoundingCoords() adds the
    // small margin; the zoom limits below are unchanged.
    ...originFrameCoords(Object.keys(byCode), _mapCodeBounds ?? new Map<string, [number, number, number, number]>()),
    ...Object.keys(byCode).map(code => COUNTRY_CENTROIDS[code]).filter(Boolean),
    ...points.map(p => [p.value[0] ?? 0, p.value[1] ?? 0]),
    // #1467: include the home point so the routes to it stay fully visible.
    ...(home ? [home] : []),
  ];
  const boundingCoords = computeMapBoundingCoords(mapPoints);

  // #1467: routes ("travelling beans") — one line per origin country with
  // shots, from its centroid to the home point. Animated only when the user
  // hasn't asked for reduced motion.
  const animateRoutes = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  const routeData = home
    ? countriesWithShots
        .map(code => COUNTRY_CENTROIDS[code])
        .filter((centroid): centroid is [number, number] => Array.isArray(centroid))
        .map(centroid => ({ coords: [centroid, home] }))
    : [];
  _mapClickData = { byCode, home };

  _echartsInstance.setOption({
    backgroundColor: c.backgroundColor,
    tooltip: {
      formatter: worldMapTooltipFormatter,
    },
    geo: {
      map: 'world', roam: true, scaleLimit: { min: 1, max: 12 }, boundingCoords,
      itemStyle: { areaColor: c.areaColor, borderColor: c.borderColor, borderWidth: 0.5 },
      emphasis: { itemStyle: { areaColor: c.emphasisAreaColor }, label: { show: false } },
    },
    series: [
      {
        type: 'map', map: 'world', geoIndex: 0,
        data: mapData,
        itemStyle: { areaColor: c.accentTo, borderColor: c.borderColor, borderWidth: 0.5 },
        emphasis: { label: { show: false } },
      },
      {
        type: 'effectScatter', coordinateSystem: 'geo',
        data: points,
        symbolSize: 7,
        itemStyle: { color: c.accentTo, shadowBlur: 8, shadowColor: _hexToRgba(c.accentTo, .6) },
        label: { show: false, color: c.mutedText, textBorderColor: c.textBorderColor, textBorderWidth: 2 },
        labelLayout: { hideOverlap: true },
        rippleEffect: { scale: 2.5 },
      },
      {
        // #1467: routes from each origin country to the user's cup.
        type: 'lines', coordinateSystem: 'geo',
        data: routeData, polyline: false, silent: true,
        lineStyle: { color: _hexToRgba(c.accentTo, .35), width: 1, curveness: 0.25 },
        ...(animateRoutes ? { effect: { show: true, period: 6, trailLength: 0, symbol: 'circle', symbolSize: 3 } } : {}),
      },
      {
        // #1467: a small static dot marking the home point.
        type: 'scatter', coordinateSystem: 'geo',
        name: t('analytics_map_home'),
        data: home ? [{ name: t('analytics_map_home'), value: [home[0], home[1]] }] : [],
        symbolSize: 6,
        itemStyle: { color: themeColor('--gray-300', '#d4d4d8') },
        label: { show: false },
      },
    ],
  }, true);

  // #1467: chips + heading counter live outside the map wrapper.
  _renderMapChips(wrap, countriesWithShots, byCode);
  _renderMapHeadingCount(wrap, countriesWithShots.length);

  if (!_resizeBound) {
    window.addEventListener('resize', () => _echartsInstance?.resize());
    _resizeBound = true;
  }
  _echartsInstance.resize();
}
