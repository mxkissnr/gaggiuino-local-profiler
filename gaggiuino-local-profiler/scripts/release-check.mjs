#!/usr/bin/env node
// Read-only, no-network release gate — run manually before cutting a release
// (`npm run release:check`), not wired into CI. Writes nothing to disk.
//
// Fails (non-zero exit, one message per failed check) if any of:
//  1. lib/constants.js's GLP_VERSION doesn't match config.yaml's version
//  2. CHANGELOG.md's topmost released heading (after skipping an optional
//     "## [Unreleased]") doesn't equal the current version
//  3. any docs/screenshots/*.png is older (by last commit) than the most
//     recent commit touching public-src/
//  4. DEVELOPMENT.md is older (by last commit) than the most recent commit
//     touching lib/, routes/, public-src/, or server.js
//  5. DOCS.md and DOCS.de.md have different heading level+order sequences
//     (a translation-parity proxy — heading text itself is not compared)

import { existsSync, readFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');          // .../gaggiuino-local-profiler
const repoRoot     = path.join(packageRoot, '..');        // git checkout root
const pkgRelDir    = path.relative(repoRoot, packageRoot);

const failures = [];

function gitLastCommitTime(relPathFromRepoRoot) {
    try {
        const out = execFileSync(
            'git', ['log', '-1', '--format=%ct', '--', relPathFromRepoRoot],
            { cwd: repoRoot, encoding: 'utf8' }
        ).trim();
        return out ? parseInt(out, 10) : null;
    } catch {
        return null;
    }
}

function fmtTime(unixSeconds) {
    return new Date(unixSeconds * 1000).toISOString();
}

// ── Check 1: version consistency ────────────────────────────────────────
const constantsPath = path.join(packageRoot, 'lib', 'constants.js');
const constantsSrc  = readFileSync(constantsPath, 'utf8');
const versionMatch  = constantsSrc.match(/const\s+GLP_VERSION\s*=\s*'([^']+)'/);
const glpVersion    = versionMatch ? versionMatch[1] : null;

const configPath        = path.join(packageRoot, 'config.yaml');
const configSrc         = readFileSync(configPath, 'utf8');
const configVersionMatch = configSrc.match(/^version:\s*"?([^"\n]+?)"?\s*$/m);
const configVersion     = configVersionMatch ? configVersionMatch[1] : null;

if (!glpVersion) {
    failures.push(`Check 1 (version match): could not find GLP_VERSION in ${constantsPath}`);
} else if (!configVersion) {
    failures.push(`Check 1 (version match): could not find version: field in ${configPath}`);
} else if (glpVersion !== configVersion) {
    failures.push(`Check 1 (version match): lib/constants.js GLP_VERSION="${glpVersion}" does not match config.yaml version="${configVersion}"`);
}

// ── Check 2: CHANGELOG heading ───────────────────────────────────────────
const changelogPath = path.join(packageRoot, 'CHANGELOG.md');
const changelogSrc  = readFileSync(changelogPath, 'utf8');
const headings      = [...changelogSrc.matchAll(/^##\s*\[([^\]]+)\]/gm)].map(m => m[1]);
const releasedHeadings = headings.filter(h => h.toLowerCase() !== 'unreleased');
const topHeading = releasedHeadings[0] || null;

if (!topHeading) {
    failures.push(`Check 2 (CHANGELOG heading): no released version heading found in ${changelogPath}`);
} else if (glpVersion && topHeading !== glpVersion) {
    failures.push(`Check 2 (CHANGELOG heading): topmost released heading is "${topHeading}", expected "${glpVersion}" (from lib/constants.js)`);
}

// ── Check 3: screenshot freshness vs public-src/ ────────────────────────
const screenshotsDirRel = path.join(pkgRelDir, 'docs', 'screenshots');
const screenshotsDirAbs = path.join(repoRoot, screenshotsDirRel);
const publicSrcTime     = gitLastCommitTime(path.join(pkgRelDir, 'public-src'));

if (!existsSync(screenshotsDirAbs)) {
    failures.push(`Check 3 (screenshot freshness): ${screenshotsDirAbs} does not exist`);
} else if (publicSrcTime == null) {
    failures.push('Check 3 (screenshot freshness): could not determine last commit touching public-src/');
} else {
    const pngFiles = readdirSync(screenshotsDirAbs).filter(f => f.endsWith('.png'));
    for (const f of pngFiles) {
        const fileTime = gitLastCommitTime(path.join(screenshotsDirRel, f));
        if (fileTime != null && fileTime < publicSrcTime) {
            failures.push(`Check 3 (screenshot freshness): docs/screenshots/${f} last committed ${fmtTime(fileTime)}, older than the most recent public-src/ commit (${fmtTime(publicSrcTime)})`);
        }
    }
}

// ── Check 4: dev-stats (DEVELOPMENT.md) freshness vs feature commits ───
const devStatsPathRel = 'DEVELOPMENT.md';
const devStatsPathAbs = path.join(repoRoot, devStatsPathRel);
const featureDirs      = ['lib', 'routes', 'public-src', 'server.js'].map(p => path.join(pkgRelDir, p));
let latestFeatureTime  = null;
let latestFeaturePath  = null;
for (const p of featureDirs) {
    const t = gitLastCommitTime(p);
    if (t != null && (latestFeatureTime == null || t > latestFeatureTime)) {
        latestFeatureTime = t;
        latestFeaturePath = p;
    }
}

if (!existsSync(devStatsPathAbs)) {
    failures.push(`Check 4 (dev-stats freshness): ${devStatsPathAbs} does not exist — run scripts/dev-stats.mjs`);
} else {
    const devStatsTime = gitLastCommitTime(devStatsPathRel);
    if (devStatsTime != null && latestFeatureTime != null && devStatsTime < latestFeatureTime) {
        failures.push(`Check 4 (dev-stats freshness): DEVELOPMENT.md last committed ${fmtTime(devStatsTime)}, older than the most recent feature commit (${latestFeaturePath}, ${fmtTime(latestFeatureTime)}) — run scripts/dev-stats.mjs`);
    }
}

// ── Check 5: DOCS.md / DOCS.de.md heading-structure parity ─────────────
function headingSequence(filePath) {
    const src = readFileSync(filePath, 'utf8');
    const seq = [];
    for (const line of src.split('\n')) {
        const m = line.match(/^(#{1,6})\s+/);
        if (m) seq.push(m[1].length);
    }
    return seq;
}

const docsEnPath = path.join(packageRoot, 'DOCS.md');
const docsDePath = path.join(packageRoot, 'DOCS.de.md');
const seqEn = headingSequence(docsEnPath);
const seqDe = headingSequence(docsDePath);
const sameLength = seqEn.length === seqDe.length;
const sameOrder  = sameLength && seqEn.every((v, i) => v === seqDe[i]);

if (!sameOrder) {
    failures.push(`Check 5 (docs heading parity): DOCS.md heading sequence [${seqEn.join(',')}] does not match DOCS.de.md [${seqDe.join(',')}]`);
}

// ── Report ───────────────────────────────────────────────────────────────
if (failures.length) {
    console.error(`release-check: ${failures.length} check(s) FAILED\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
} else {
    console.log('release-check: all checks passed.');
    process.exit(0);
}
