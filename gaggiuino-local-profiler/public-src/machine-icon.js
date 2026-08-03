// Detailed Gaggia Classic machine icon (#594), rendered in the machine's own
// theme colour. Ported faithfully from Max's approved Theme Lab mockup —
// geometry and comments below are the mockup's own measurements, kept as-is;
// do not redesign.
//
// Body colour comes from the machine's theme (lib/machines/theme-presets.js
// resolveTheme()); the dark/chrome parts are fixed neutral greys (not pure
// black) by design, so the icon stays legible on both the app's light and
// dark backgrounds regardless of theme.
import { resolveTheme } from '../lib/machines/theme-presets.js';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Multiple machines (list rows, switcher, ...) can render this icon in the
// same document at once — SVG gradient ids are global to the page, so a
// shared id across instances would make every icon pick up whichever
// gradient happened to be defined last. Give every call a fresh id.
let _instanceCounter = 0;
function nextGradientId() {
    _instanceCounter += 1;
    return `glp-machine-icon-${_instanceCounter}`;
}

// Falls back to the app's own accent gradient (see style.css [data-accent]
// vars) when the machine has no theme set — matches the app's existing
// default look rather than an arbitrary hardcoded colour.
function stopsFor(theme) {
    const resolved = resolveTheme(theme);
    if (resolved && HEX_RE.test(resolved.a) && HEX_RE.test(resolved.b)) return resolved;
    return { a: 'var(--accent-from)', b: 'var(--accent-to)' };
}

/* Gaggia Classic, 3/4-Ansicht. Geometrie aus dem 3/4-Referenzfoto vermessen
   (ASCII-Klassifikationskarte, 454x653), normalisiert auf viewBox 0 0 100 162:
     Frontflaeche  nx 10.2 .. 72.2, ny 2.3 .. 71.9
     Seitenwand    nx 72.2 .. 93.2  (dunkler)   Kantenlicht nx 93.2 .. 100
     Tasten        ny 13.6 .. 28.4, nx 20.5/33.0/45.5 (je 9 breit), LEDs ny 31.8
     Dampfknopf    Zylinder nx 80.7 .. 97.7, ny 20.5 .. 34.1 (liegend, nicht rund)
     Mittelblock   nx 26 .. 93, ny 72 .. 131, mit offener Tassennische links
     Bruehgruppe   nx 42 .. 58, ny 72 .. 82;  Siebtraeger ragt nach links ins Freie
     Dampflanze    nx 83 .. 85 RECHTS (nicht mittig), ny 72 .. 131
     Tropfschale   breiter als der Korpus: ny 122 .. 134, nx 17 .. 93 -> 0 .. 80
     Sockelfront   nx 0 .. 81.8, ny 134 .. 155 (senkrecht, nicht keilfoermig)
   Plastizitaet aus EINEM Verlauf + Schwarz/Weiss-Overlays, damit jedes Preset und
   jeder Custom-Verlauf ohne eigene Schattenfarben funktioniert. Neutrale sind
   mittleres Dunkelgrau (nicht Schwarz), damit das Icon auch auf dunklem Grund steht. */
function machineBody(id, mini) {
    return `
      <!-- Seitenwand rechts inkl. Kantenlicht, volle Hoehe -->
      <path d="M72.2 2.3 L100 11 L100 130 L88 153 L72.2 153 Z" fill="url(#${id})"/>
      <path d="M72.2 2.3 L100 11 L100 130 L88 153 L72.2 153 Z" fill="#000" opacity=".26"/>
      <path d="M93.2 8.6 L100 11 L100 130 L90 149 L93.2 142 Z" fill="#fff" opacity=".13"/>

      <!-- Frontflaeche Korpus -->
      <path d="M13 2.4 L72.2 2.3 L72.2 71.9 L10.2 71.9 L10.2 5.2 A2.8 2.8 0 0 1 13 2.4 Z" fill="url(#${id})"/>
      <path d="M72.2 3 L72.2 71" stroke="#fff" opacity=".22" stroke-width="3"/>

      <!-- Mittelblock: Korpus kragt links darueber, dort ragt der Siebtraeger ins Freie -->
      <path d="M20 72 L94 72 L94 122 L24 122 Z" fill="#2b2b31"/>
      <path d="M20 72 L94 72 L94 77 L20.6 77 Z" fill="#000" opacity=".3"/>

      <!-- Bruehgruppe + Siebtraeger (ragt nach links ins Freie) -->
      <rect x="42" y="71.5" width="16" height="10.5" rx="2.2" fill="#b9bec5"/>
      ${mini ? '' : '<path d="M47 82 L53 82 L52 87.5 L48 87.5 Z" fill="#8f959d"/>'}
      <path d="M20.5 91 L45 84" stroke="#26262c" stroke-width="6.6" stroke-linecap="round"/>
      <circle cx="18.6" cy="91.6" r="5.9" fill="#ded8ca" stroke="#26262c" stroke-width="1.2"/>

      <!-- Dampflanze RECHTS: Gummimanschette oben, Chromrohr nach unten -->
      <path d="M84.2 72 C85.2 78 84.6 82 84 88" stroke="#26262c" stroke-width="5" stroke-linecap="round"/>
      <path d="M84 88 C83.5 101 83 115 83.5 130" stroke="#a3a9b1" stroke-width="2.6" stroke-linecap="round"/>
      ${mini ? '' : '<path d="M21.5 97 L21.5 130" stroke="#9aa0a8" stroke-width="2" stroke-linecap="round"/>'}

      <!-- Tropfschale: silbernes Lochblech in dunklem Rahmen -->
      <path d="M17 122 L93 122 L80 134 L0 134 Z" fill="#25252b"/>
      <path d="M20.5 123.4 L88.5 123.4 L77 132.6 L4 132.6 Z" fill="url(#${id}-steel)"/>
      ${mini ? '' : `
      <circle cx="28" cy="126" r="1.5" fill="#4a4a52"/>
      <circle cx="39" cy="126" r="1.5" fill="#4a4a52"/>
      <circle cx="50" cy="126" r="1.5" fill="#4a4a52"/>
      <circle cx="61" cy="126" r="1.5" fill="#4a4a52"/>
      <circle cx="72" cy="126" r="1.5" fill="#4a4a52"/>
      <circle cx="21" cy="130.4" r="1.5" fill="#4a4a52"/>
      <circle cx="32" cy="130.4" r="1.5" fill="#4a4a52"/>
      <circle cx="43" cy="130.4" r="1.5" fill="#4a4a52"/>
      <circle cx="54" cy="130.4" r="1.5" fill="#4a4a52"/>
      <circle cx="65" cy="130.4" r="1.5" fill="#4a4a52"/>`}

      <!-- Sockelfront: senkrecht -->
      <path d="M0 134 L80 134 L84 155 L0 155 Z" fill="#2b2b31"/>
      <path d="M0 134 L80 134 L80.8 138 L0 138 Z" fill="#fff" opacity=".07"/>

      <!-- Fuesse -->
      <rect x="4.5" y="155" width="7.5" height="4.4" rx="1.5" fill="#26262c"/>
      <rect x="66" y="155" width="7.5" height="4.4" rx="1.5" fill="#26262c"/>

      <!-- Bedienfeld: 3 Wipptasten -->
      <rect x="20.5" y="13.6" width="9" height="14.8" rx="2.1" fill="#26262c"/>
      <rect x="33" y="13.6" width="9" height="14.8" rx="2.1" fill="#26262c"/>
      <rect x="45.5" y="13.6" width="9" height="14.8" rx="2.1" fill="#26262c"/>
      ${mini ? '' : `
      <rect x="21.6" y="14.9" width="6.8" height="5.4" rx="1.4" fill="#fff" opacity=".13"/>
      <rect x="34.1" y="14.9" width="6.8" height="5.4" rx="1.4" fill="#fff" opacity=".13"/>
      <rect x="46.6" y="14.9" width="6.8" height="5.4" rx="1.4" fill="#fff" opacity=".13"/>
      <rect x="23.7" y="31.8" width="2.6" height="2.2" rx=".8" fill="#d9422e"/>
      <rect x="36.2" y="31.8" width="2.6" height="2.2" rx=".8" fill="#d9422e"/>
      <rect x="48.7" y="31.8" width="2.6" height="2.2" rx=".8" fill="#d9422e"/>`}

      <!-- Dampfknopf: liegender Zylinder auf der Seitenwand -->
      <rect x="74" y="23.4" width="9" height="8" fill="#26262c"/>
      <rect x="80.7" y="20.5" width="17" height="13.6" rx="6.8" fill="#212126"/>
      <ellipse cx="82.6" cy="27.3" rx="2.4" ry="6.8" fill="#3b3b43"/>
      ${mini ? '' : '<rect x="81.4" y="23.4" width="1.7" height="7.8" rx=".85" fill="#fff" opacity=".2"/>'}`;
}

function machineIconMarkup(theme, mini) {
    const id = nextGradientId();
    const { a, b } = stopsFor(theme);
    return `
    <svg viewBox="0 0 100 162" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="${id}" x1="6" y1="0" x2="92" y2="145" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="${a}"/>
          <stop offset="1" stop-color="${b}"/>
        </linearGradient>
        <linearGradient id="${id}-steel" x1="0" y1="123" x2="0" y2="133" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#d3d6db"/>
          <stop offset="1" stop-color="#9ba1a9"/>
        </linearGradient>
      </defs>
      ${machineBody(id, mini)}
    </svg>`;
}

// Detail variant — full geometry, for anywhere the icon renders at a
// reasonable size (machine form, larger list rows).
export function machineIconSvg(theme) {
    return machineIconMarkup(theme, false);
}

// Mini variant — drops sub-2px detail (portafilter handle, steam wand
// bracket, button highlights/LEDs, drip tray perforations). Use at <=24px.
export function machineIconMiniSvg(theme) {
    return machineIconMarkup(theme, true);
}
