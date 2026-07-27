#!/usr/bin/env node
// Read-only, no-network release gate — run manually before cutting a release
// (`npm run release:check`), not wired into CI. Writes nothing to disk.
//
// Fails (non-zero exit, one message per failed check) if any of:
//  1. lib/constants.js's GLP_VERSION doesn't match config.yaml's version
//  2. CHANGELOG.md's topmost released heading (after skipping an optional
//     "## [Unreleased]") doesn't equal the current version
//  3. any docs/screenshots/*.png is older (by last commit) than the newest
//     commit touching public-src/ that could plausibly change what's
//     rendered — a commit whose public-src/ diff is entirely comment/blank
//     lines doesn't count (#537). When in doubt (merge commits, binary
//     diffs, unrecognized file types, anything not confidently a whole-line
//     comment) it's treated as visually relevant — false positives (an
//     unneeded screenshot re-run) are cheap, false negatives (stale
//     screenshots shipped) are not.
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

function fmtTime(unixSeconds) {
    return new Date(unixSeconds * 1000).toISOString();
}

export function gitLastCommitTime(gitRoot, relPathFromRoot) {
    try {
        const out = execFileSync(
            'git', ['log', '-1', '--format=%ct', '--', relPathFromRoot],
            { cwd: gitRoot, encoding: 'utf8' }
        ).trim();
        return out ? parseInt(out, 10) : null;
    } catch {
        return null;
    }
}

// Git's well-known empty-tree object — diffing a root commit (no parent)
// against it yields a normal "everything added" diff instead of a special case.
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Only file types where "the whole line is a comment" can be recognized with
// a simple, confident regex get an entry here. Anything else (json, images,
// fonts, ...) falls through to "always counts as a real change" in
// isCommentOrBlankLine — there's no safe comment syntax to detect, and for
// something like an i18n JSON file every line change is visually relevant
// anyway.
const COMMENT_PATTERNS = {
    '.js':  [/^\/\/.*$/, /^\/\*.*\*\/$/],
    '.mjs': [/^\/\/.*$/, /^\/\*.*\*\/$/],
    '.cjs': [/^\/\/.*$/, /^\/\*.*\*\/$/],
    '.html': [/^<!--.*-->$/],
    '.htm':  [/^<!--.*-->$/],
    '.css':  [/^\/\*.*\*\/$/],
};

// Deliberately conservative: only a line that is *entirely* a single-line
// comment (or blank) is treated as non-visual. A continuation line inside a
// multi-line /* ... */ or <!-- ... --> block won't match its file type's
// pattern (it doesn't start with the opening token and end with the closing
// one on the same line) and falls through to "real change" — per spec, an
// ambiguous line must count as code, not as a comment.
export function isCommentOrBlankLine(content, ext) {
    const trimmed = content.trim();
    if (trimmed === '') return true;
    const patterns = COMMENT_PATTERNS[ext];
    if (!patterns) return false;
    return patterns.some((re) => re.test(trimmed));
}

function commitsTouching(gitRoot, pathSpec) {
    let out;
    try {
        out = execFileSync(
            'git', ['log', '--format=%H %ct', '--', pathSpec],
            { cwd: gitRoot, encoding: 'utf8' }
        ).trim();
    } catch {
        return [];
    }
    if (!out) return [];
    return out.split('\n').map((line) => {
        const sep = line.indexOf(' ');
        return { hash: line.slice(0, sep), time: parseInt(line.slice(sep + 1), 10) };
    });
}

// True if this commit's diff on pathSpec could plausibly change what's
// rendered. Merge commits and anything git/fs refuses to hand back a clean
// diff for are treated as relevant without inspection — combined merge
// diffs aren't line-addressable the same way, and "can't tell" must resolve
// to "assume relevant" (see the module doc comment on check 3).
export function isVisuallyRelevantCommit(gitRoot, hash, pathSpec) {
    let parents;
    try {
        parents = execFileSync(
            'git', ['rev-list', '--parents', '-1', hash],
            { cwd: gitRoot, encoding: 'utf8' }
        ).trim().split(/\s+/);
    } catch {
        return true;
    }
    if (parents.length > 2) return true; // merge commit (2+ parents)

    const parentHash = parents.length === 2 ? parents[1] : EMPTY_TREE_HASH;
    let diff;
    try {
        diff = execFileSync(
            'git', ['diff', '--no-color', '--unified=0', parentHash, hash, '--', pathSpec],
            { cwd: gitRoot, encoding: 'utf8' }
        );
    } catch {
        return true;
    }

    let currentExt = null;
    for (const line of diff.split('\n')) {
        if (line.startsWith('diff --git')) {
            const m = line.match(/ b\/(.+)$/);
            currentExt = m ? path.extname(m[1]).toLowerCase() : null;
            continue;
        }
        if (line.startsWith('Binary files ') && line.endsWith('differ')) return true;
        if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
        if (line[0] === '+' || line[0] === '-') {
            if (!isCommentOrBlankLine(line.slice(1), currentExt)) return true;
        }
    }
    return false;
}

// Check 3 as its own exported function so it can be exercised against real
// temporary git repos in tests without running the rest of this script
// (which assumes it's sitting inside the actual gaggiuino-local-profiler
// checkout). gitRoot is the repo root; publicSrcRel/screenshotsDirRel are
// paths relative to it.
export function checkScreenshotFreshness(gitRoot, publicSrcRel, screenshotsDirRel) {
    const failures = [];
    const screenshotsDirAbs = path.join(gitRoot, screenshotsDirRel);

    if (!existsSync(screenshotsDirAbs)) {
        failures.push(`Check 3 (screenshot freshness): ${screenshotsDirAbs} does not exist`);
        return failures;
    }

    const publicSrcCommits = commitsTouching(gitRoot, publicSrcRel);
    if (publicSrcCommits.length === 0) {
        failures.push('Check 3 (screenshot freshness): could not determine last commit touching public-src/');
        return failures;
    }

    const relevanceCache = new Map();
    const isRelevant = (hash) => {
        if (!relevanceCache.has(hash)) {
            relevanceCache.set(hash, isVisuallyRelevantCommit(gitRoot, hash, publicSrcRel));
        }
        return relevanceCache.get(hash);
    };

    const pngFiles = readdirSync(screenshotsDirAbs).filter((f) => f.endsWith('.png'));
    for (const f of pngFiles) {
        const screenshotRel = path.join(screenshotsDirRel, f);
        const fileTime = gitLastCommitTime(gitRoot, screenshotRel);
        if (fileTime == null) continue;

        const newerRelevant = publicSrcCommits
            .filter((c) => c.time > fileTime && isRelevant(c.hash))
            .sort((a, b) => b.time - a.time)[0];

        if (newerRelevant) {
            failures.push(
                `Check 3 (screenshot freshness): ${screenshotRel} last committed ${fmtTime(fileTime)}, ` +
                `older than a visually-relevant public-src/ commit ${newerRelevant.hash.slice(0, 7)} (${fmtTime(newerRelevant.time)})`
            );
        }
    }
    return failures;
}

function main() {
    const failures = [];

    // ── Check 1: version consistency ────────────────────────────────────
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

    // ── Check 2: CHANGELOG heading ───────────────────────────────────────
    const changelogPath = path.join(packageRoot, 'CHANGELOG.md');
    const changelogSrc  = readFileSync(changelogPath, 'utf8');
    const headings      = [...changelogSrc.matchAll(/^##\s*\[([^\]]+)\]/gm)].map((m) => m[1]);
    const releasedHeadings = headings.filter((h) => h.toLowerCase() !== 'unreleased');
    const topHeading = releasedHeadings[0] || null;

    if (!topHeading) {
        failures.push(`Check 2 (CHANGELOG heading): no released version heading found in ${changelogPath}`);
    } else if (glpVersion && topHeading !== glpVersion) {
        failures.push(`Check 2 (CHANGELOG heading): topmost released heading is "${topHeading}", expected "${glpVersion}" (from lib/constants.js)`);
    }

    // ── Check 3: screenshot freshness vs public-src/ ────────────────────
    failures.push(...checkScreenshotFreshness(
        repoRoot,
        path.join(pkgRelDir, 'public-src'),
        path.join(pkgRelDir, 'docs', 'screenshots')
    ));

    // ── Check 4: dev-stats (DEVELOPMENT.md) freshness vs feature commits ─
    const devStatsPathRel = 'DEVELOPMENT.md';
    const devStatsPathAbs = path.join(repoRoot, devStatsPathRel);
    const featureDirs      = ['lib', 'routes', 'public-src', 'server.js'].map((p) => path.join(pkgRelDir, p));
    let latestFeatureTime  = null;
    let latestFeaturePath  = null;
    for (const p of featureDirs) {
        const t = gitLastCommitTime(repoRoot, p);
        if (t != null && (latestFeatureTime == null || t > latestFeatureTime)) {
            latestFeatureTime = t;
            latestFeaturePath = p;
        }
    }

    if (!existsSync(devStatsPathAbs)) {
        failures.push(`Check 4 (dev-stats freshness): ${devStatsPathAbs} does not exist — run scripts/dev-stats.mjs`);
    } else {
        const devStatsTime = gitLastCommitTime(repoRoot, devStatsPathRel);
        if (devStatsTime != null && latestFeatureTime != null && devStatsTime < latestFeatureTime) {
            failures.push(`Check 4 (dev-stats freshness): DEVELOPMENT.md last committed ${fmtTime(devStatsTime)}, older than the most recent feature commit (${latestFeaturePath}, ${fmtTime(latestFeatureTime)}) — run scripts/dev-stats.mjs`);
        }
    }

    // ── Check 5: DOCS.md / DOCS.de.md heading-structure parity ─────────
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

    // ── Report ───────────────────────────────────────────────────────────
    if (failures.length) {
        console.error(`release-check: ${failures.length} check(s) FAILED\n`);
        for (const f of failures) console.error(`  - ${f}`);
        process.exit(1);
    } else {
        console.log('release-check: all checks passed.');
        process.exit(0);
    }
}

// Only run the full gate when invoked as a script. Without this guard, just
// importing checkScreenshotFreshness/isVisuallyRelevantCommit for a unit
// test would also run checks 1/2/4/5 against this repo and call
// process.exit() as an import side effect.
const invokedDirectly = process.argv[1] &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) main();
