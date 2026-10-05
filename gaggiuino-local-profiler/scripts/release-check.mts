#!/usr/bin/env node
// Read-only, no-network release gate — run manually before cutting a release
// (`npm run release:check`), not wired into CI. Writes nothing to disk.
//
// Fails (non-zero exit, one message per failed check) if any of:
//  1. package.json, go/internal/system/version.go's glpVersion or
//     go/internal/backup/bundle.go's glpVersion don't match config.yaml's
//     canonical version
//  2. CHANGELOG.md's topmost released heading (after skipping an optional
//     "## [Unreleased]") doesn't equal the current version
//  3. any docs/screenshots/*.png is older (by last commit) than the newest
//     commit touching public-src/ that could plausibly change what's
//     rendered — a commit whose public-src/ changes are, file by file,
//     identical once comments and blank lines are stripped out doesn't
//     count (#537). Comments are stripped from whole file contents (not
//     diff lines), so multi-line /* */ and <!-- --> blocks — the norm in
//     this codebase — are handled, not just single-line comments. When in
//     doubt (merge commits, binary diffs, unrecognized file types, git
//     errors) it's treated as visually relevant — false positives (an
//     unneeded screenshot re-run) are cheap, false negatives (stale
//     screenshots shipped) are not.
//  4. DEVELOPMENT.md is older (by last commit) than the most recent commit
//     touching go/ or public-src/
//  5. DOCS.md and DOCS.de.md have different heading level+order sequences
//     (a translation-parity proxy — heading text itself is not compared)
//  6. the release's acceptance protocol (docs/acceptance/v<version>.md, format
//     in docs/acceptance/README.md) is missing, records a failing or
//     still-pending case, waives a case without a reason, uses an unknown
//     result, or leaks private infrastructure (RFC1918 IPv4, .local/.lan
//     hostnames, JWT-like strings, GitHub token prefixes)
//  7. a changelog fragment (changelog.d/*.md other than README.md) is still
//     on disk — its notes never reached CHANGELOG.md (run
//     `npm run changelog:collect`)

import { existsSync, readFileSync, readdirSync, type Dirent } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');          // .../gaggiuino-local-profiler
const repoRoot     = path.join(packageRoot, '..');        // git checkout root
const pkgRelDir    = path.relative(repoRoot, packageRoot);

function fmtTime(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toISOString();
}

export function gitLastCommitTime(gitRoot: string, relPathFromRoot: string): number | null {
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

// ── Comment stripping ───────────────────────────────────────────────────
//
// #537 follow-up: an earlier version of this check classified individual
// diff lines ("does this added/removed line look like a whole-line
// comment?"). That fails on the exact case the issue was filed for — HTML
// comments in this codebase are routinely multi-line, e.g.
//
//   <!-- Only shown once a valid session token was obtained (ingress or
//        already-authenticated) — the endpoint no longer hands out the
//        token to unauthenticated LAN callers, see #276 -->
//
// None of those three lines opens *and* closes the comment on the same
// line, so a per-line regex has no confident way to call any of them
// "comment" and falls back to "code" for all three — meaning a purely
// comment-only edit to a block like this still gets flagged, which is
// exactly the bug #537 reports.
//
// Fix: compare whole-file content instead of diff lines. For each file a
// commit touches under public-src/, strip comments from both the old and
// new blob and compare what's left. A proper strip needs to track string/
// template-literal state too — otherwise "//" or "/*" inside a string
// literal (a URL, a snippet of markup) would be misread as a comment
// start, and *removing real code* because it looked like a comment is the
// dangerous direction (a hidden code change could then read as
// comment-only). The tokenizers below are deliberately simple state
// machines, not a full parser: they get strings, template literals
// (including nested `${ \`...\` }`), and single/multi-line comments right,
// but do not attempt to disambiguate regex literals from division — a
// regex containing a literal, unescaped "/*" or "//" (only possible inside
// a character class, e.g. /[/*]/) could be misread as a comment start.
// That pattern does not occur anywhere in this repo's public-src today
// (checked by hand); it's called out here as a known, accepted limitation
// rather than silently ignored.
//
// Every stripper leans conservative the same way: when a comment or string
// never finds its closing token before EOF, the scanner just keeps
// consuming to the end rather than guessing — it cannot under-strip past
// that point (nothing after an unclosed opener gets treated as anything
// other than what it already was), so it cannot hide a real change.

// JS/HTML/CSS all guard token boundaries the same way: swallowing a
// comment can't be allowed to glue the token before it to the token after
// it (`x/*c*/y` must not become `xy`), so every comment is replaced with a
// single space rather than nothing, and newlines inside removed comments
// are preserved so blank-line-only differences keep comparing equal.
function stripJsLikeComments(src: string): string {
    let out = '';
    let mode = 'NORMAL'; // NORMAL | LINE_COMMENT | BLOCK_COMMENT | STRING_SINGLE | STRING_DOUBLE | TEMPLATE
    // Each open `${...}` inside a template literal pushes a frame here so
    // we know, once its braces balance back to zero, to return to TEMPLATE
    // mode for the *enclosing* literal rather than falling out to NORMAL.
    // This is what makes nested template literals (`${a.map(x => \`...\`)}`,
    // common in this codebase) work: entering a nested backtick from
    // inside a `${}` just sets mode = TEMPLATE without touching the stack.
    const templateExprStack: { braceDepth: number }[] = [];
    let i = 0;
    const n = src.length;

    while (i < n) {
        const c = src[i]!;
        const c2 = i + 1 < n ? src[i + 1]! : '';

        if (mode === 'LINE_COMMENT') {
            if (c === '\n') { out += '\n'; mode = 'NORMAL'; }
            i++;
            continue;
        }
        if (mode === 'BLOCK_COMMENT') {
            if (c === '\n') { out += '\n'; i++; continue; }
            if (c === '*' && c2 === '/') { out += ' '; mode = 'NORMAL'; i += 2; continue; }
            i++;
            continue;
        }
        if (mode === 'STRING_SINGLE' || mode === 'STRING_DOUBLE') {
            const quote = mode === 'STRING_SINGLE' ? "'" : '"';
            if (c === '\\' && i + 1 < n) { out += c + src[i + 1]!; i += 2; continue; }
            out += c;
            if (c === quote) mode = 'NORMAL';
            i++;
            continue;
        }
        if (mode === 'TEMPLATE') {
            if (c === '\\' && i + 1 < n) { out += c + src[i + 1]!; i += 2; continue; }
            if (c === '`') { out += c; mode = 'NORMAL'; i++; continue; }
            if (c === '$' && c2 === '{') {
                out += '${';
                templateExprStack.push({ braceDepth: 0 });
                mode = 'NORMAL';
                i += 2;
                continue;
            }
            out += c;
            i++;
            continue;
        }

        // NORMAL — also covers "inside a template's ${...} expression",
        // tracked via templateExprStack rather than a distinct mode.
        if (templateExprStack.length) {
            const top = templateExprStack[templateExprStack.length - 1]!;
            if (c === '{') { top.braceDepth++; out += c; i++; continue; }
            if (c === '}') {
                if (top.braceDepth === 0) {
                    templateExprStack.pop();
                    out += c;
                    mode = 'TEMPLATE';
                    i++;
                    continue;
                }
                top.braceDepth--;
                out += c;
                i++;
                continue;
            }
        }
        if (c === '/' && c2 === '/') { mode = 'LINE_COMMENT'; i += 2; continue; }
        if (c === '/' && c2 === '*') { mode = 'BLOCK_COMMENT'; i += 2; continue; }
        if (c === "'") { mode = 'STRING_SINGLE'; out += c; i++; continue; }
        if (c === '"') { mode = 'STRING_DOUBLE'; out += c; i++; continue; }
        if (c === '`') { mode = 'TEMPLATE'; out += c; i++; continue; }
        out += c;
        i++;
    }
    return out;
}

function stripCssComments(src: string): string {
    let out = '';
    let mode = 'NORMAL'; // NORMAL | BLOCK_COMMENT | STRING_SINGLE | STRING_DOUBLE
    let i = 0;
    const n = src.length;

    while (i < n) {
        const c = src[i]!;
        const c2 = i + 1 < n ? src[i + 1]! : '';

        if (mode === 'BLOCK_COMMENT') {
            if (c === '\n') { out += '\n'; i++; continue; }
            if (c === '*' && c2 === '/') { out += ' '; mode = 'NORMAL'; i += 2; continue; }
            i++;
            continue;
        }
        if (mode === 'STRING_SINGLE' || mode === 'STRING_DOUBLE') {
            const quote = mode === 'STRING_SINGLE' ? "'" : '"';
            if (c === '\\' && i + 1 < n) { out += c + src[i + 1]!; i += 2; continue; }
            out += c;
            if (c === quote) mode = 'NORMAL';
            i++;
            continue;
        }

        if (c === '/' && c2 === '*') { mode = 'BLOCK_COMMENT'; i += 2; continue; }
        if (c === "'") { mode = 'STRING_SINGLE'; out += c; i++; continue; }
        if (c === '"') { mode = 'STRING_DOUBLE'; out += c; i++; continue; }
        out += c;
        i++;
    }
    return out;
}

// No string-awareness here: HTML attribute values could in principle
// contain a literal "<!--"/"-->" substring, which this would misread.
// Full tag/attribute parsing to guard against that is out of proportion to
// a risk that doesn't occur anywhere in this repo's public-src HTML today
// — noted as an accepted limitation rather than silently ignored. An
// unterminated "<!--" (no matching "-->" anywhere after it) is left
// exactly as-is rather than treated as an open-ended comment, so a
// malformed/truncated file can't cause real trailing content to vanish
// from the comparison.
function stripHtmlComments(src: string): string {
    let out = '';
    let i = 0;
    const n = src.length;

    while (i < n) {
        if (src.startsWith('<!--', i)) {
            const end = src.indexOf('-->', i + 4);
            if (end === -1) {
                out += src.slice(i);
                break;
            }
            const removed = src.slice(i, end + 3);
            const newlines = (removed.match(/\n/g) || []).length;
            out += '\n'.repeat(newlines) + ' ';
            i = end + 3;
            continue;
        }
        out += src[i]!;
        i++;
    }
    return out;
}

const COMMENT_STRIPPERS: Record<string, (src: string) => string> = {
    '.js':  stripJsLikeComments,
    '.mjs': stripJsLikeComments,
    '.cjs': stripJsLikeComments,
    '.html': stripHtmlComments,
    '.htm':  stripHtmlComments,
    '.css':  stripCssComments,
};

// Drops lines that are empty once comments are stripped, so an edit that
// purely adds/removes blank lines around a comment (very common when a
// comment block is reworded) doesn't register as a difference either — the
// spec for #537 calls out blank lines the same way it does comments. Any
// non-blank line's content, including its internal whitespace, is compared
// as-is: an actual code line was untouched by the comment strip, so if the
// stripped comparison as a whole differs, something other than comments/
// blank lines changed and that's exactly what should count as relevant.
function normalizeForCompare(stripped: string): string {
    return stripped.split('\n').filter((line) => line.trim() !== '').join('\n');
}

export { stripJsLikeComments, stripCssComments, stripHtmlComments };

function commitsTouching(gitRoot: string, pathSpec: string): { hash: string; time: number }[] {
    let out: string;
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

// name-status and numstat for a commit's changes under pathSpec, both with
// --no-renames: a pure rename then shows up as a plain delete-of-old +
// add-of-new rather than an R### record with two paths, which means every
// record here has exactly one path and there's no rename-similarity
// parsing to get wrong. The cost is that a pure rename with no content
// change gets read as "old path deleted (had content), new path added (has
// content)" — i.e. relevant — which is the safe direction (over-flagging,
// never under-flagging), not a correctness bug.
function changedFilesNameStatus(gitRoot: string, parentHash: string, hash: string, pathSpec: string): { status: string; filePath: string }[] | null {
    let raw: string;
    try {
        raw = execFileSync(
            'git', ['diff', '--no-color', '--no-renames', '--name-status', '-z', parentHash, hash, '--', pathSpec],
            { cwd: gitRoot, encoding: 'utf8' }
        );
    } catch {
        return null;
    }
    const tokens = raw.split('\0').filter((t) => t !== '');
    const files: { status: string; filePath: string }[] = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
        files.push({ status: tokens[i]!, filePath: tokens[i + 1]! });
    }
    return files;
}

function binaryPathSet(gitRoot: string, parentHash: string, hash: string, pathSpec: string): Set<string> | null {
    let raw: string;
    try {
        raw = execFileSync(
            'git', ['diff', '--no-color', '--no-renames', '--numstat', '-z', parentHash, hash, '--', pathSpec],
            { cwd: gitRoot, encoding: 'utf8' }
        );
    } catch {
        return null;
    }
    const tokens = raw.split('\0').filter((t) => t !== '');
    const binary = new Set<string>();
    for (let i = 0; i + 2 < tokens.length; i += 3) {
        if (tokens[i] === '-' && tokens[i + 1] === '-') binary.add(tokens[i + 2]!);
    }
    return binary;
}

function blobContent(gitRoot: string, hash: string, filePath: string): string | null {
    try {
        return execFileSync('git', ['show', `${hash}:${filePath}`], { cwd: gitRoot, encoding: 'utf8' });
    } catch {
        return null;
    }
}

// True if one changed file's content, comments/blank-lines aside, actually
// differs between the two sides. status is the --no-renames name-status
// code (A/M/D/T); only A and D legitimately mean "one side doesn't exist"
// — anywhere else, a missing blob is a real error, not an expected
// deletion/addition, so it's treated as relevant rather than as ''.
function isFileChangeVisuallyRelevant(gitRoot: string, parentHash: string, hash: string, filePath: string, status: string): boolean {
    let oldContent: string | null;
    if (status === 'A') {
        oldContent = '';
    } else {
        oldContent = blobContent(gitRoot, parentHash, filePath);
        if (oldContent === null) return true;
    }

    let newContent: string | null;
    if (status === 'D') {
        newContent = '';
    } else {
        newContent = blobContent(gitRoot, hash, filePath);
        if (newContent === null) return true;
    }

    const stripper = COMMENT_STRIPPERS[path.extname(filePath).toLowerCase()];
    if (!stripper) return oldContent !== newContent;

    return normalizeForCompare(stripper(oldContent)) !== normalizeForCompare(stripper(newContent));
}

// True if this commit's changes under pathSpec could plausibly change
// what's rendered. Merge commits and anything git refuses to hand back a
// clean diff for are treated as relevant without inspection — combined
// merge diffs aren't per-file-addressable the same way, and "can't tell"
// must resolve to "assume relevant" (see the module doc comment on check 3).
export function isVisuallyRelevantCommit(gitRoot: string, hash: string, pathSpec: string): boolean {
    let parents: string[];
    try {
        parents = execFileSync(
            'git', ['rev-list', '--parents', '-1', hash],
            { cwd: gitRoot, encoding: 'utf8' }
        ).trim().split(/\s+/);
    } catch {
        return true;
    }
    if (parents.length > 2) return true; // merge commit (2+ parents)

    const parentHash = parents.length === 2 ? parents[1]! : EMPTY_TREE_HASH;

    const files = changedFilesNameStatus(gitRoot, parentHash, hash, pathSpec);
    if (files === null) return true;
    if (files.length === 0) return false;

    const binaryPaths = binaryPathSet(gitRoot, parentHash, hash, pathSpec);
    if (binaryPaths === null) return true;

    for (const { status, filePath } of files) {
        if (binaryPaths.has(filePath)) return true;
        if (isFileChangeVisuallyRelevant(gitRoot, parentHash, hash, filePath, status)) return true;
    }
    return false;
}

// Check 3 as its own exported function so it can be exercised against real
// temporary git repos in tests without running the rest of this script
// (which assumes it's sitting inside the actual gaggiuino-local-profiler
// checkout). gitRoot is the repo root; publicSrcRel/screenshotsDirRel are
// paths relative to it.
export function checkScreenshotFreshness(gitRoot: string, publicSrcRel: string, screenshotsDirRel: string): string[] {
    const failures: string[] = [];
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

    const relevanceCache = new Map<string, boolean>();
    const isRelevant = (hash: string): boolean => {
        if (!relevanceCache.has(hash)) {
            relevanceCache.set(hash, isVisuallyRelevantCommit(gitRoot, hash, publicSrcRel));
        }
        return relevanceCache.get(hash)!;
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

// ── Check 6: acceptance protocol ────────────────────────────────────────
//
// The release's public acceptance protocol lives at
// docs/acceptance/v<version>.md (format: docs/acceptance/README.md). This is
// a shape-only gate: it does not run the acceptance pass, it rejects a
// protocol that recorded a failure or an unfinished case, and it keeps
// private infrastructure out of a public file. Pure — takes the protocol
// Markdown and the release version, returns one message per problem — so it
// can be exercised in tests without touching the file system.
export function checkAcceptanceProtocol(markdown: string, version: string | null): string[] {
    const failures: string[] = [];
    const versionLabel = version ? `v${version}` : 'the release';

    // A table row is a line whose first non-space character is "|". Split on
    // the pipes and trim each cell; the outer pipes drop as empty edge cells.
    const splitRow = (line: string): string[] => {
        let s = line.trim();
        if (s.startsWith('|')) s = s.slice(1);
        if (s.endsWith('|')) s = s.slice(0, -1);
        return s.split('|').map((c) => c.trim());
    };

    // Locate the results table by its header row (the first table row with a
    // "Result" cell) and note which cells hold Result and Case.
    const lines = markdown.split('\n');
    let headerIdx = -1;
    let resultCol = -1;
    let caseCol = -1;
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.trim().startsWith('|')) continue;
        const cells = splitRow(lines[i]!);
        const rIdx = cells.findIndex((c) => /\bresult\b/i.test(c));
        if (rIdx === -1) continue;
        headerIdx = i;
        resultCol = rIdx;
        caseCol = cells.findIndex((c) => /\bcase\b/i.test(c));
        break;
    }

    if (headerIdx === -1) {
        failures.push(`Check 6 (acceptance protocol): no table with a "Result" column found in the ${versionLabel} protocol`);
    } else {
        let dataRows = 0;
        for (let i = headerIdx + 1; i < lines.length; i++) {
            if (!lines[i]!.trim().startsWith('|')) break; // table ends here
            const cells = splitRow(lines[i]!);
            // The header's separator row ("| --- | --- |") is not a case.
            if (cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))) continue;
            if (cells.length <= resultCol) continue;

            dataRows++;
            const id = (cells[0] || '').trim();
            const caseName = caseCol !== -1 ? (cells[caseCol] || '').trim() : '';
            const label = caseName ? `${id} "${caseName}"` : id;
            const raw = cells[resultCol]!.trim();
            const result = raw.toLowerCase();

            if (result === 'pass') {
                // A passing case needs no message.
            } else if (result === 'fail') {
                failures.push(`Check 6 (acceptance protocol): case ${label} failed`);
            } else if (result === 'manual-pending') {
                failures.push(`Check 6 (acceptance protocol): case ${label} is still manual-pending`);
            } else if (result.startsWith('waived:')) {
                if (!raw.slice(raw.indexOf(':') + 1).trim()) {
                    failures.push(`Check 6 (acceptance protocol): case ${label} is waived without a reason`);
                }
            } else {
                failures.push(`Check 6 (acceptance protocol): case ${label} has an unknown result "${raw}"`);
            }
        }
        if (dataRows === 0) {
            failures.push(`Check 6 (acceptance protocol): the table in the ${versionLabel} protocol has no data rows`);
        }
    }

    // Public-content leak check, one failure per finding type, quoting the
    // match. Only the private ranges are listed (a public address is fine),
    // and a bare version number like 3.2.0 matches none of these.
    const leakPatterns = [
        { type: 'private IPv4 address', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/ },
        { type: '.local/.lan hostname', re: /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:local|lan)\b/i },
        { type: 'JWT-like string', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
        { type: 'GitHub token', re: /\b(?:ghp_|gho_|ghs_|ghu_|ghr_|github_pat_)[A-Za-z0-9_]+/ },
    ];
    for (const { type, re } of leakPatterns) {
        const match = markdown.match(re);
        if (match) {
            failures.push(`Check 6 (acceptance protocol): leaked ${type} "${match[0]!}"`);
        }
    }

    return failures;
}

// ── Check 7: leftover changelog fragments ───────────────────────────────
//
// Each PR drops one changelog.d/<issue>.<section>.md fragment instead of
// editing CHANGELOG.md directly (format: changelog.d/README.md). At release
// time `npm run changelog:collect` folds every fragment into CHANGELOG.md and
// deletes it. A release cut while fragments are still on disk would ship a
// changelog missing those entries, so refuse to pass. The directory is
// optional — a checkout that predates fragments simply has none. Filesystem
// read only: takes the directory path, returns one message if any fragment is
// left after README.md is discounted.
export function checkChangelogFragments(fragmentsDir: string): string[] {
    const failures: string[] = [];
    if (!existsSync(fragmentsDir)) return failures;

    let entries: Dirent[];
    try {
        entries = readdirSync(fragmentsDir, { withFileTypes: true });
    } catch {
        return failures;
    }

    const leftovers = entries
        .filter((e) => e.isFile() && e.name !== 'README.md')
        .map((e) => e.name)
        .sort();

    if (leftovers.length) {
        failures.push(
            `Check 7 (changelog fragments): ${leftovers.length} changelog fragment(s) not collected — run \`npm run changelog:collect\`: ${leftovers.join(', ')}`
        );
    }

    return failures;
}

function main(): void {
    const failures: string[] = [];

    // ── Check 1: version consistency ────────────────────────────────────
    // config.yaml's version: is canonical (HA Supervisor reads it directly).
    // package.json and the two Go consts served from GET /api/version /
    // stamped into backup bundles must all match it — bumped in exactly
    // these four spots at release time (CLAUDE.md's Versioning section).
    const configPath        = path.join(packageRoot, 'config.yaml');
    const configSrc         = readFileSync(configPath, 'utf8');
    const configVersionMatch = configSrc.match(/^version:\s*"?([^"\n]+?)"?\s*$/m);
    const configVersion     = configVersionMatch ? configVersionMatch[1]! : null;
    // `glpVersion` name kept for checks 2 and 4 below — it is the canonical
    // version they compare against.
    const glpVersion        = configVersion;

    if (!configVersion) {
        failures.push(`Check 1 (version match): could not find version: field in ${configPath}`);
    } else {
        const versionSpots = [
            { label: 'package.json "version"', file: path.join(packageRoot, 'package.json'),
              re: /"version"\s*:\s*"([^"]+)"/ },
            { label: 'go/internal/system/version.go glpVersion', file: path.join(packageRoot, 'go', 'internal', 'system', 'version.go'),
              re: /const\s+glpVersion\s*=\s*"([^"]+)"/ },
            { label: 'go/internal/backup/bundle.go glpVersion', file: path.join(packageRoot, 'go', 'internal', 'backup', 'bundle.go'),
              re: /const\s+glpVersion\s*=\s*"([^"]+)"/ },
        ];
        for (const spot of versionSpots) {
            const m = readFileSync(spot.file, 'utf8').match(spot.re);
            if (!m) {
                failures.push(`Check 1 (version match): could not read a version from ${spot.label}`);
            } else if (m[1] !== configVersion) {
                failures.push(`Check 1 (version match): ${spot.label}="${m[1]!}" does not match config.yaml version="${configVersion}"`);
            }
        }
    }

    // ── Check 2: CHANGELOG heading ───────────────────────────────────────
    const changelogPath = path.join(packageRoot, 'CHANGELOG.md');
    const changelogSrc  = readFileSync(changelogPath, 'utf8');
    const headings      = [...changelogSrc.matchAll(/^##\s*\[([^\]]+)\]/gm)].map((m) => m[1]!);
    const releasedHeadings = headings.filter((h) => h.toLowerCase() !== 'unreleased');
    const topHeading = releasedHeadings[0] || null;

    if (!topHeading) {
        failures.push(`Check 2 (CHANGELOG heading): no released version heading found in ${changelogPath}`);
    } else if (glpVersion && topHeading !== glpVersion) {
        failures.push(`Check 2 (CHANGELOG heading): topmost released heading is "${topHeading}", expected "${glpVersion}" (from config.yaml)`);
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
    const featureDirs      = ['go', 'public-src'].map((p) => path.join(pkgRelDir, p));
    let latestFeatureTime: number | null = null;
    let latestFeaturePath: string | null = null;
    for (const p of featureDirs) {
        const t = gitLastCommitTime(repoRoot, p);
        if (t != null && (latestFeatureTime == null || t > latestFeatureTime)) {
            latestFeatureTime = t;
            latestFeaturePath = p;
        }
    }

    if (!existsSync(devStatsPathAbs)) {
        failures.push(`Check 4 (dev-stats freshness): ${devStatsPathAbs} does not exist — run node scripts/dev-stats.mts`);
    } else {
        const devStatsTime = gitLastCommitTime(repoRoot, devStatsPathRel);
        if (devStatsTime != null && latestFeatureTime != null && devStatsTime < latestFeatureTime) {
            failures.push(`Check 4 (dev-stats freshness): DEVELOPMENT.md last committed ${fmtTime(devStatsTime)}, older than the most recent feature commit (${latestFeaturePath}, ${fmtTime(latestFeatureTime)}) — run node scripts/dev-stats.mts`);
        }
    }

    // ── Check 5: DOCS.md / DOCS.de.md heading-structure parity ─────────
    function headingSequence(filePath: string): number[] {
        const src = readFileSync(filePath, 'utf8');
        const seq: number[] = [];
        for (const line of src.split('\n')) {
            const m = line.match(/^(#{1,6})\s+/);
            if (m) seq.push(m[1]!.length);
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

    // ── Check 6: acceptance protocol ─────────────────────────────────────
    // The file is named after the release version; its absence is a hard
    // failure (check 1 already reported an unreadable config version).
    if (glpVersion) {
        const acceptanceRel = path.join(pkgRelDir, 'docs', 'acceptance', `v${glpVersion}.md`);
        const acceptanceAbs = path.join(repoRoot, acceptanceRel);
        if (!existsSync(acceptanceAbs)) {
            failures.push(`Check 6 (acceptance protocol): ${acceptanceRel} does not exist — add the release's acceptance protocol (format: docs/acceptance/README.md)`);
        } else {
            failures.push(...checkAcceptanceProtocol(readFileSync(acceptanceAbs, 'utf8'), glpVersion));
        }
    }

    // ── Check 7: leftover changelog fragments ───────────────────────────
    failures.push(...checkChangelogFragments(path.join(packageRoot, 'changelog.d')));

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
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]!);
if (invokedDirectly) main();
