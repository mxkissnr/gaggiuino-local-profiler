#!/usr/bin/env node
// Syncs the `options`/`schema` blocks from this repo's config.yaml into the
// dev manifest's config.yaml (mxkissnr/glp-dev-app), run by
// .github/workflows/build-dev.yaml on every push to `dev`. See #805: before
// this script existed, build-dev.yaml bumped `version` and copied
// apparmor.txt (#790) but never touched these two blocks, so an option added
// to the app (e.g. #804's expose_api_port) simply didn't exist on the dev
// add-on and could never be live-tested.
//
// Deliberately NOT a full YAML parse+dump: both files carry hand-written
// comments throughout (rationale for `boot: manual`, the port 8098/8099
// split, etc.) that a round-trip through a YAML library would silently
// drop or reformat. Instead this treats `options:`/`schema:` as opaque text
// blocks and only touches those two, leaving every other line -- including
// unrelated comments -- byte-for-byte untouched.
//
// Merge rules (see #805):
//  - schema: copied wholesale from the source. It defines what HA renders
//    in the Configuration tab, and the dev add-on has no reason to accept a
//    different set of options than the app it runs.
//  - options: keys missing from the target are added using the source's
//    default (source order); keys the target already has keep the target's
//    existing value untouched (e.g. dev's `debug_logging: true`, which the
//    app itself defaults to false). Keys the source no longer has are
//    dropped from the target.

import { readFileSync, writeFileSync } from 'fs';

const TOP_LEVEL_KEY = /^[^\s#]/;
const OPTION_KEY    = /^\s{2}([A-Za-z0-9_]+):\s*(.*)$/;
const OPTION_COMMENT = /^\s{2}#/;

// Returns { startLine, endLine } (endLine exclusive) for the block whose
// header is an exact `${key}:` line at column 0 -- i.e. from that header
// through the line before the next top-level key, or EOF.
function findBlock(lines, key) {
    const start = lines.findIndex((line) => line === `${key}:`);
    if (start === -1) {
        throw new Error(`no top-level "${key}:" block found`);
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (TOP_LEVEL_KEY.test(lines[i])) {
            end = i;
            break;
        }
    }
    return { start, end };
}

// Parses an options block's body (everything after the `options:` header
// line, up to the block's end) into ordered {key, lines} entries, where
// `lines` includes any comment lines directly preceding the key.
function parseOptionEntries(bodyLines) {
    const entries = [];
    let pendingComments = [];
    for (const line of bodyLines) {
        if (line.trim() === '') {
            // A blank line is formatting, not a key -- there's nothing to
            // interleave it into the merged output next to, so it's simply
            // dropped rather than preserved. It also breaks a comment's
            // attachment to whatever follows: this codebase's own
            // convention (e.g. the block comments above `options:` in both
            // config.yaml files) treats a comment separated from the next
            // line by a blank line as a standalone note, not documentation
            // for that line, so pendingComments is discarded here rather
            // than carried across the gap.
            pendingComments = [];
            continue;
        }
        if (OPTION_COMMENT.test(line)) {
            pendingComments.push(line);
            continue;
        }
        const match = OPTION_KEY.exec(line);
        if (!match) {
            throw new Error(`unrecognized line inside options block: ${JSON.stringify(line)}`);
        }
        entries.push({ key: match[1], lines: [...pendingComments, line] });
        pendingComments = [];
    }
    if (pendingComments.length > 0) {
        throw new Error('options block ends with a comment not attached to any key');
    }
    return entries;
}

// sourceText: this repo's config.yaml. targetText: the dev manifest's
// config.yaml. Returns the new target text plus a short summary of what
// changed, for the workflow log.
export function syncDevConfig(sourceText, targetText) {
    const sourceLines = sourceText.split('\n');
    const targetLines = targetText.split('\n');

    const sourceOptions = findBlock(sourceLines, 'options');
    const sourceSchema  = findBlock(sourceLines, 'schema');
    const targetOptions = findBlock(targetLines, 'options');
    const targetSchema  = findBlock(targetLines, 'schema');

    const sourceEntries = parseOptionEntries(sourceLines.slice(sourceOptions.start + 1, sourceOptions.end));
    const targetEntries = parseOptionEntries(targetLines.slice(targetOptions.start + 1, targetOptions.end));
    const targetByKey = new Map(targetEntries.map((entry) => [entry.key, entry]));
    const sourceKeys = new Set(sourceEntries.map((entry) => entry.key));

    const added = [];
    const removed = targetEntries.filter((entry) => !sourceKeys.has(entry.key)).map((entry) => entry.key);

    const mergedOptionLines = ['options:'];
    for (const sourceEntry of sourceEntries) {
        const existing = targetByKey.get(sourceEntry.key);
        if (existing) {
            mergedOptionLines.push(...existing.lines);
        } else {
            mergedOptionLines.push(...sourceEntry.lines);
            added.push(sourceEntry.key);
        }
    }

    const schemaLines = sourceLines.slice(sourceSchema.start, sourceSchema.end);

    // Blocks are replaced back-to-front (schema, then options) so the
    // earlier block's line numbers don't shift out from under the later
    // splice.
    const result = [...targetLines];
    result.splice(targetSchema.start, targetSchema.end - targetSchema.start, ...schemaLines);
    result.splice(targetOptions.start, targetOptions.end - targetOptions.start, ...mergedOptionLines);

    return { text: result.join('\n'), added, removed };
}

// CLI: node sync-dev-config.mjs <source config.yaml> <target config.yaml>
// Overwrites the target in place.
if (import.meta.url === `file://${process.argv[1]}`) {
    const [sourcePath, targetPath] = process.argv.slice(2);
    if (!sourcePath || !targetPath) {
        console.error('usage: sync-dev-config.mjs <source config.yaml> <target config.yaml>');
        process.exit(1);
    }
    const sourceText = readFileSync(sourcePath, 'utf8');
    const targetText = readFileSync(targetPath, 'utf8');
    const { text, added, removed } = syncDevConfig(sourceText, targetText);
    writeFileSync(targetPath, text);
    console.log(`options/schema synced from ${sourcePath} into ${targetPath}`);
    console.log(added.length > 0 ? `  added: ${added.join(', ')}` : '  added: (none)');
    console.log(removed.length > 0 ? `  removed: ${removed.join(', ')}` : '  removed: (none)');
}
