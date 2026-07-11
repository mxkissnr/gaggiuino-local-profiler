#!/usr/bin/env node
// Regenerates docs/screenshots/*.png for the README/wiki. Boots a throwaway
// instance of the app (its own tmp DATA_DIR and port — never touches /data
// or 8099), seeds a few demo beans/grinder/shots so the Library, Analytics
// world map and flavor wheel aren't empty, then drives a headless Chromium
// (Playwright) through each view. Run on demand: `node scripts/screenshots.mjs`.
// Requires `npx playwright install chromium` once beforehand.

import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const require    = createRequire(import.meta.url);
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const appRoot    = path.join(__dirname, '..');
const outDir     = path.join(appRoot, 'docs', 'screenshots');
const PORT       = 8199;

// ── Throwaway data dir — redirect lib/constants.js before anything requires it ──
const tmpDataDir = mkdtempSync(path.join(tmpdir(), 'glp-screenshots-'));
const constantsPath = require.resolve('../lib/constants.js');
const realConstants = require(constantsPath);
// Every *_FILE/*_DIR constant is a hardcoded '/data/...' literal, not derived
// from DATA_DIR at runtime — each one needs its own override here, or the
// server silently keeps writing into the real /data.
require.cache[constantsPath].exports = {
    ...realConstants,
    DATA_DIR: tmpDataDir,
    DEFAULT_PORT: PORT,
    TOKEN_FILE: path.join(tmpDataDir, 'api_token.txt'),
    PREHEAT_STATE_FILE: path.join(tmpDataDir, 'preheat_state.json'),
    OPTIONS_FILE: path.join(tmpDataDir, 'options.json'),
    PROFILES_CACHE_FILE: path.join(tmpDataDir, 'profiles_cache.json'),
    BEAN_IMAGE_DIR: path.join(tmpDataDir, 'bean-images'),
};

// ── Minimal PNG encoder (no extra dependency) for a placeholder bean/grinder photo ──
function crc32(buf) {
    if (!crc32.table) {
        crc32.table = new Array(256).fill(0).map((_, n) => {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            return c >>> 0;
        });
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = crc32.table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData), 0);
    return Buffer.concat([len, typeData, crc]);
}

function makeSolidColorPng(w, h, [r, g, b]) {
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(w, 0);
    ihdrData.writeUInt32BE(h, 4);
    ihdrData[8] = 8; // bit depth
    ihdrData[9] = 2; // color type: RGB truecolor
    const ihdr = pngChunk('IHDR', ihdrData);

    const rowSize = 1 + w * 3;
    const raw = Buffer.alloc(rowSize * h);
    for (let y = 0; y < h; y++) {
        raw[y * rowSize] = 0; // filter: none
        for (let x = 0; x < w; x++) {
            const px = y * rowSize + 1 + x * 3;
            raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
        }
    }
    const idat = pngChunk('IDAT', zlib.deflateSync(raw));
    const iend = pngChunk('IEND', Buffer.alloc(0));
    return Buffer.concat([sig, ihdr, idat, iend]);
}

// ── Synthetic espresso curve (28s, 0.1s resolution, ×10-scaled like real datapoints) ──
function makeShotDatapoints() {
    const timeInShot = [], pressure = [], pumpFlow = [], shotWeight = [], temperature = [];
    for (let i = 0; i <= 280; i++) {
        const t = i / 10; // seconds
        timeInShot.push(i * 10);
        const p = t < 5 ? (t / 5) * 3 : t < 8 ? 3 + ((t - 5) / 3) * 6 : 9 - Math.max(0, (t - 20)) * 0.15;
        pressure.push(Math.round(p * 10));
        pumpFlow.push(Math.round((t < 8 ? 1.5 : 2.2 + Math.sin(t) * 0.2) * 10));
        shotWeight.push(Math.round(Math.max(0, (t - 8) / 20 * 36) * 10));
        temperature.push(Math.round((93 + Math.sin(t / 3)) * 10));
    }
    return { timeInShot, pressure, pumpFlow, shotWeight, temperature };
}

async function waitForServer(url, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(url);
            if (r.ok) return;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`);
}

async function seed(baseUrl) {
    const libraryService = require('../lib/services/LibraryService');
    const { imagePath }   = require('../lib/services/ImageService');
    const shotRepo        = require('../lib/repositories/ShotRepository');

    // /api/library/* requires the x-glp-token header; /api/token hands it out
    // without one since this request originates from a private/local IP.
    const { apiToken } = await fetch(`${baseUrl}/api/token`).then(r => r.json());
    const post = (p, body) => fetch(`${baseUrl}${p}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-glp-token': apiToken }, body: JSON.stringify(body),
    }).then(r => r.json());

    const bean1 = await post('/api/library/bean', {
        name: 'Yirgacheffe Chelelektu', roaster: 'Kaffee Braun', roastDate: '15.06.2026', stock_g: 250,
        origin: 'ET', variety: 'Heirloom', process: 'Washed', roastType: 'filter',
        flavors: ['Jasmin', 'Zitrone', 'Bergamotte', 'Schwarzer Tee'], region: 'Yirgacheffe, Gedeo Zone',
        altitude_m: 1950, importer: 'Rehm Coffee', harvest: '11-12.25', price_eur: 16.5,
        producer: 'Chelelektu Washing Station', certification: 'Bio',
        brewTempC: 94, brewRatio: '1:16', brewTimeS: 180, brewNotes: 'V60, langsam angiessen',
    });
    const bean2 = await post('/api/library/bean', {
        name: 'Bombe', roaster: 'Elbgold', roastDate: '20.06.2026', stock_g: 500,
        origin: 'BR', variety: 'Bourbon, Catuai', process: 'Natural', roastType: 'espresso',
        flavors: ['Schokolade', 'Nougat', 'Karamell', 'Rote Kirsche'], region: 'Sul de Minas',
        altitude_m: 1200, importer: 'Elbgold Kaffeerösterei', harvest: '05-07.25', price_eur: 12.9,
        producer: 'Fazenda Sertaozinho', certification: '',
        brewTempC: 93, brewRatio: '1:2.2', brewTimeS: 28, brewNotes: '',
    });

    // Direct file write + DB patch for a demo photo — no network fetch needed,
    // fully offline/deterministic (real imports go through ImageService.fetchBeanImage).
    mkdirSync(tmpDataDir + '/bean-images', { recursive: true });
    for (const [bean, color] of [[bean1, [0xC8, 0xA0, 0x6E]], [bean2, [0x5A, 0x35, 0x22]]]) {
        writeFileSync(imagePath(bean.id, 'png'), makeSolidColorPng(200, 200, color));
        const lib = libraryService.getLibrary();
        lib.beans.find(b => b.id === bean.id).image = 'png';
        libraryService.saveLibrary(lib);
    }

    const grinder = await post('/api/library/grinder', {
        name: 'Niche Zero', notes: 'Espresso: 23 Klicks · Filter: 32 Klicks',
        burrType: 'Konisch Stahl', purchaseDate: '01.03.2025',
    });
    writeFileSync(imagePath(grinder.id, 'png', 'grinder-'), makeSolidColorPng(200, 200, [0x33, 0x33, 0x38]));
    { const lib = libraryService.getLibrary(); lib.grinders.find(g => g.id === grinder.id).image = 'png'; libraryService.saveLibrary(lib); }

    const now = Math.floor(Date.now() / 1000);
    const datapoints = makeShotDatapoints();
    // The frontend reads shot.profile.name (nested) / shot.profileName, not
    // the flat profile_name DB column — see public-src/views/shots/index.js.
    const shots = [
        { id: 1, timestamp: now - 3 * 86400, duration: 280, profile: { name: 'Blooming Shot' }, datapoints },
        { id: 2, timestamp: now - 2 * 86400, duration: 280, profile: { name: 'Standard Espresso' }, datapoints },
        { id: 3, timestamp: now - 86400,     duration: 280, profile: { name: 'Standard Espresso' }, datapoints },
        { id: 4, timestamp: now,             duration: 280, profile: { name: 'Standard Espresso' }, datapoints },
    ];
    shotRepo.upsertMany(shots);
    shotRepo.saveAnnotation(1, { coffee: bean1.name, dose: 15, rating: 5, grinder: grinder.name, notes: 'Blumig, sehr sauber' });
    shotRepo.saveAnnotation(2, { coffee: bean2.name, dose: 18, rating: 4, grinder: grinder.name, drinkType: null });
    shotRepo.saveAnnotation(3, { coffee: bean2.name, dose: 18, rating: 5, grinder: grinder.name });
    shotRepo.saveAnnotation(4, { coffee: bean2.name, dose: 18, rating: 4, grinder: grinder.name });
}

async function main() {
    mkdirSync(outDir, { recursive: true });

    process.chdir(appRoot);
    require('../server.js'); // starts listening on PORT against tmpDataDir
    const baseUrl = `http://127.0.0.1:${PORT}`;
    await waitForServer(`${baseUrl}/api/status`);
    await seed(baseUrl);

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    // The update-check banner does a real GitHub API call and renders whenever
    // the checked-out version is ahead of the latest published release (the
    // normal case mid-release, before this version's own tag exists yet) —
    // it overlays the top of the page and intercepts clicks on the nav bar.
    await page.addStyleTag({ content: '#glpUpdateBanner{display:none!important}' });
    await page.waitForTimeout(500); // let async post-load renders (thumbnails, charts) settle

    await page.click('#btnShots');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'shots.png') });

    await page.click('#btnLibrary');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'library.png') });

    const wheelBtn = page.locator('[data-action="open-flavor-wheel"]').first();
    if (await wheelBtn.count()) {
        await wheelBtn.click();
        await page.waitForTimeout(600); // sunburst render
        await page.screenshot({ path: path.join(outDir, 'flavor-wheel.png') });
        const closeBtn = page.locator('#flavorWheelModal .fw-close, #flavorWheelModal [data-action="close-flavor-wheel"]').first();
        if (await closeBtn.count()) await closeBtn.click();
    }

    await page.click('#btnAnalytics');
    await page.waitForTimeout(400);
    await page.locator('#worldMapWrap').scrollIntoViewIfNeeded();
    await page.waitForTimeout(800); // ECharts map render
    await page.screenshot({ path: path.join(outDir, 'analytics.png') });

    await page.click('#btnMaintenance');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'maintenance.png') });

    await page.click('#btnDialin');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'dialin.png') });

    await browser.close();
    console.log(`Screenshots written to ${outDir}`);

    const wikiDir = process.argv[2];
    if (wikiDir && existsSync(wikiDir)) {
        const wikiImages = path.join(wikiDir, 'images');
        mkdirSync(wikiImages, { recursive: true });
        cpSync(outDir, wikiImages, { recursive: true });
        console.log(`Copied screenshots into wiki repo at ${wikiImages}`);
    }

    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
