// #1615: main.ts used to put ~235 functions on `window` "for HTML onclick
// handlers", but the markup has none left (dynamic content uses data-action
// delegation) and only a few dozen were ever read. What stays is exactly what
// another module reads as `window.X` to stay off a direct import (import
// cycles). This pins that list and checks it against the source, so a new
// export nobody reads, an export something still reads being dropped, or an
// inline handler that would need a global all fail here.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(import.meta.dirname, '..');

const KEEP = [
  'calcShotScore', 'closeBeanSheet', 'closeFlavorWheel', 'connectLiveStream', 'disconnectLiveStream',
  'ensureCurves', 'flushAutoSave', 'getRawCurve', 'getShotCurve', 'getShotDataById', 'goToShot',
  'initAnalytics', 'loadAchievementsView', 'loadData', 'loadLibrary', 'loadMaintenanceView',
  'loadOrdersView', 'populateRefSelector', 'renderBeanList', 'renderDialin', 'renderGrinderList',
  'renderMachinesList', 'renderSidebar', 'selectShot', 'setAccentTheme', 'showToast', 'startOrdersPolling',
  'stopOrdersPolling', 'switchMode', 't', 'trashShot', 'updateView',
];

// Tracked frontend sources (the SPA, kiosk and demo shells), minus the static
// public/ assets copied verbatim into the build.
function sources(): { path: string; text: string }[] {
  const out = execFileSync('git', ['ls-files', '-z', 'public-src', 'demo'], { cwd: APP_ROOT, encoding: 'utf8' });
  return out.split('\0')
    .filter(p => /\.(ts|html)$/.test(p) && !p.startsWith('public-src/public/'))
    .map(path => ({ path, text: readFileSync(resolve(APP_ROOT, path), 'utf8') }));
}

// Comments are prose (they mention window.X freely), so only code counts.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const MAIN = readFileSync(resolve(APP_ROOT, 'public-src/main.ts'), 'utf8');
const BLOCK_START = MAIN.indexOf('Object.assign(window, {');
const BLOCK_END = MAIN.indexOf('\n});', BLOCK_START);

// The top-level keys of main.ts's Object.assign(window, { ... }) block.
function exportedKeys(): string[] {
  const block = stripComments(MAIN.slice(BLOCK_START, BLOCK_END));
  return [...block.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*[,:]/gm)].map(m => m[1] ?? '').sort();
}

// Every name some module reads (or calls) as window.X / window?.X, outside
// main.ts's own export block.
function windowReads(): Set<string> {
  const reads = new Set<string>();
  for (const { path, text } of sources()) {
    const code = path === 'public-src/main.ts'
      ? MAIN.slice(0, BLOCK_START) + MAIN.slice(BLOCK_END)
      : text;
    for (const m of stripComments(code).matchAll(/\bwindow\??\.([A-Za-z_$][\w$]*)/g)) reads.add(m[1] ?? '');
  }
  return reads;
}

describe('window exports (#1615)', () => {
  it('main.ts exposes exactly the pinned keep-list', () => {
    expect(BLOCK_START).toBeGreaterThan(-1);
    expect(exportedKeys()).toEqual([...KEEP].sort());
  });

  it('every pinned export is read as window.X somewhere', () => {
    const reads = windowReads();
    expect(KEEP.filter(name => !reads.has(name))).toEqual([]);
  });

  it('every app global a module reads is exported (or assigned by its own module)', () => {
    // App globals are the members of the `interface Window` augmentations;
    // onAllShotMetaLoaded is a one-shot callback analytics sets itself.
    const declared = new Set<string>();
    for (const { text } of sources()) {
      for (const block of text.matchAll(/interface Window \{([\s\S]*?)\n\s*\}/g)) {
        for (const m of (block[1] ?? '').matchAll(/^\s*([A-Za-z_$][\w$]*)\??:/gm)) declared.add(m[1] ?? '');
      }
    }
    const selfAssigned = new Set(['onAllShotMetaLoaded']);
    const missing = [...windowReads()].filter(n => declared.has(n) && !KEEP.includes(n) && !selfAssigned.has(n));
    expect(missing).toEqual([]);
    // ...and nothing is declared that no longer exists.
    expect([...declared].filter(n => !KEEP.includes(n) && !selfAssigned.has(n))).toEqual([]);
  });

  it('no markup uses an inline on* handler that would need a window global', () => {
    const offenders = sources()
      .filter(({ text }) => /<[a-z][^<>]*\son[a-z]+\s*=\s*["'`$]/i.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
