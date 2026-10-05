#!/usr/bin/env node
// Collects changelog fragments from changelog.d/ into CHANGELOG.md's
// `## [Unreleased]` block, then deletes the collected files. Every PR used to
// edit the same spot under `## [Unreleased]`, so each merge into dev made every
// other open PR conflict and the resync push dismissed approvals; one file per
// PR instead never conflicts. See #1421 and changelog.d/README.md.
//
// The pure part -- collectChangelog -- takes the changelog text plus
// {name, content} fragments and returns the new changelog text, so the tests in
// test/changelog-collect.test.ts can exercise it without a filesystem. The
// wrapper at the bottom only reads/writes files and deletes what it collected.

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep-a-Changelog order; lowercase on disk, title case in the heading.
const SECTIONS = ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security'] as const;
type Section = (typeof SECTIONS)[number];
const TITLES: Record<Section, string> = {
    added: 'Added',
    changed: 'Changed',
    deprecated: 'Deprecated',
    removed: 'Removed',
    fixed: 'Fixed',
    security: 'Security',
};

export interface ChangelogFragment {
    name: string;
    content: string;
}

interface ParsedFragment {
    section: Section;
    issue: number;
    suffix: string;
}

function isSection(value: string): value is Section {
    return (SECTIONS as readonly string[]).includes(value);
}

function parseFragmentName(fileName: string): ParsedFragment {
    if (!fileName.endsWith('.md')) {
        throw new Error(`changelog fragment ${fileName}: expected a .md file`);
    }
    const stem = fileName.slice(0, -3);
    const dot = stem.lastIndexOf('.');
    if (dot <= 0) {
        throw new Error(`changelog fragment ${fileName}: expected <issue>.<section>.md`);
    }
    const name = stem.slice(0, dot);
    const section = stem.slice(dot + 1);
    if (!isSection(section)) {
        throw new Error(
            `changelog fragment ${fileName}: unknown section "${section}" (expected one of: ${SECTIONS.join(', ')})`,
        );
    }
    const match = /^(\d+)(?:-(.+))?$/.exec(name);
    if (!match) {
        throw new Error(`changelog fragment ${fileName}: name must start with the issue number`);
    }
    return { section, issue: Number(match[1]), suffix: match[2] ?? '' };
}

function bulletsOf(content: string): string[] {
    return content
        .split('\n')
        .map((line) => line.replace(/\r$/, ''))
        .filter((line) => line.startsWith('- '));
}

// Returns a Map of existing `### Title` heading to the lines that follow it,
// in the order they appear. Only used on the [Unreleased] block.
function parseUnreleased(blockLines: readonly string[]): Map<string, string[]> {
    const sections = new Map<string, string[]>();
    let current: string[] | null = null;
    for (const line of blockLines.slice(1)) {
        const heading = /^###\s+(.*\S)\s*$/.exec(line);
        if (heading) {
            current = [];
            sections.set(heading[1] ?? '', current);
        } else if (current && line.trim() !== '') {
            current.push(line);
        }
    }
    return sections;
}

function unreleasedBlock(text: string): string {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => /^##\s+\[Unreleased\]\s*$/.test(line));
    if (start === -1) return '';
    let end = start + 1;
    while (end < lines.length && !/^##\s/.test(lines[end] ?? '')) end += 1;
    return lines.slice(start, end).join('\n');
}

export function collectChangelog(
    changelogText: string,
    fragments: readonly ChangelogFragment[],
): string {
    if (fragments.length === 0) return changelogText;

    const entries = fragments
        .map((fragment) => ({ ...fragment, ...parseFragmentName(fragment.name) }))
        .sort((a, b) => a.issue - b.issue || a.suffix.localeCompare(b.suffix));

    const bulletsBySection = new Map<Section, string[]>(
        SECTIONS.map((section): [Section, string[]] => [section, []]),
    );
    for (const entry of entries) {
        const bullets = bulletsOf(entry.content);
        if (bullets.length === 0) {
            throw new Error(`changelog fragment ${entry.name}: no "- " bullet line found`);
        }
        const bucket = bulletsBySection.get(entry.section);
        if (bucket) bucket.push(...bullets);
    }

    const lines = changelogText.split('\n');
    const headingIndex = lines.findIndex((line) => /^##\s+\[Unreleased\]\s*$/.test(line));
    let blockStart = 0;
    let blockEnd = 0;
    if (headingIndex !== -1) {
        blockStart = headingIndex;
        let end = headingIndex + 1;
        while (end < lines.length && !/^##\s/.test(lines[end] ?? '')) end += 1;
        blockEnd = end;
    }

    const existing = parseUnreleased(lines.slice(blockStart, blockEnd));

    const rebuilt = ['## [Unreleased]'];
    for (const section of SECTIONS) {
        const title = TITLES[section];
        const existingBody = existing.get(title);
        const newBullets = bulletsBySection.get(section) ?? [];
        if (existingBody === undefined && newBullets.length === 0) continue;
        rebuilt.push(`### ${title}`);
        if (existingBody !== undefined) rebuilt.push(...existingBody);
        rebuilt.push(...newBullets);
    }
    // Keep any subheading the block already had that is not a known section.
    for (const [title, body] of existing) {
        if (!SECTIONS.some((section) => TITLES[section] === title)) {
            rebuilt.push(`### ${title}`, ...body);
        }
    }

    if (headingIndex === -1) {
        return [...rebuilt, '', ...lines].join('\n');
    }
    if (blockEnd < lines.length) rebuilt.push('');
    return [...lines.slice(0, blockStart), ...rebuilt, ...lines.slice(blockEnd)].join('\n');
}

// CLI: node changelog-collect.mts [--dry-run]
if (import.meta.url === `file://${process.argv[1]}`) {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const projectDir = join(scriptDir, '..');
    const fragmentsDir = join(projectDir, 'changelog.d');
    const changelogPath = join(projectDir, 'CHANGELOG.md');
    const dryRun = process.argv.includes('--dry-run');

    const names = existsSync(fragmentsDir)
        ? readdirSync(fragmentsDir).filter((name) => name.endsWith('.md') && name !== 'README.md')
        : [];
    const fragments: ChangelogFragment[] = names.map((name) => ({
        name,
        content: readFileSync(join(fragmentsDir, name), 'utf8'),
    }));
    const changelogText = readFileSync(changelogPath, 'utf8');

    let newText: string;
    try {
        newText = collectChangelog(changelogText, fragments);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
        throw error;
    }

    if (dryRun) {
        console.log(unreleasedBlock(newText));
    } else {
        writeFileSync(changelogPath, newText);
        for (const name of names) unlinkSync(join(fragmentsDir, name));
        console.log(`collected ${names.length} changelog fragment(s) into CHANGELOG.md`);
    }
}
