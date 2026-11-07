import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { syncDevConfig } from '../scripts/sync-dev-config.mts';

const ROOT = resolve(import.meta.dirname, '..');

function read(rel: string): string {
    return readFileSync(join(ROOT, rel), 'utf8');
}

// #805: build-dev.yaml bumped `version` and copied apparmor.txt (#790) but
// never synced `options`/`schema`, so an option added to the app's own
// config.yaml (e.g. #804's expose_api_port) had no way to reach the dev
// add-on's Configuration tab. These tests exercise the merge function the
// workflow now calls, using minimal stand-ins for the two real config.yaml
// files rather than the full files, so each case stays readable.

function source(optionsBody: string, schemaBody: string) {
    return [
        'name: "GLP — Gaggiuino Local Profiler"',
        'slug: "gaggiuino_local_profiler"',
        'options:',
        optionsBody,
        'schema:',
        schemaBody,
    ].join('\n');
}

function target(optionsBody: string, schemaBody: string) {
    return [
        'name: "GLP DEV — Gaggiuino Local Profiler (unstable)"',
        'slug: "gaggiuino_local_profiler_dev"',
        'boot: manual',
        'options:',
        optionsBody,
        'schema:',
        schemaBody,
    ].join('\n');
}

describe('syncDevConfig (#805)', () => {
    it('adds a new option with the source default and its schema entry, keeping other fields untouched', () => {
        const sourceText = source(
            '  debug_logging: false\n  expose_api_port: true',
            '  debug_logging: bool?\n  expose_api_port: bool?',
        );
        const targetText = target('  debug_logging: true', '  debug_logging: bool?');

        const { text, added, removed } = syncDevConfig(sourceText, targetText);

        expect(added).toEqual(['expose_api_port']);
        expect(removed).toEqual([]);
        // dev's existing value survives even though the source default differs.
        expect(text).toContain('  debug_logging: true');
        expect(text).not.toContain('  debug_logging: false');
        expect(text).toContain('  expose_api_port: true');
        expect(text).toContain('  expose_api_port: bool?');
        // fields outside options/schema are byte-for-byte untouched.
        expect(text).toContain('name: "GLP DEV — Gaggiuino Local Profiler (unstable)"');
        expect(text).toContain('slug: "gaggiuino_local_profiler_dev"');
        expect(text).toContain('boot: manual');
    });

    it('drops an option the source no longer has', () => {
        const sourceText = source('  debug_logging: false', '  debug_logging: bool?');
        const targetText = target(
            '  debug_logging: true\n  enable_orders: false',
            '  debug_logging: bool?\n  enable_orders: bool?',
        );

        const { text, removed } = syncDevConfig(sourceText, targetText);

        expect(removed).toEqual(['enable_orders']);
        expect(text).not.toContain('enable_orders');
        expect(text).toContain('  debug_logging: true');
    });

    it('carries a comment preceding a newly added option key along with it', () => {
        const sourceText = source(
            '  debug_logging: false\n  # explains the default\n  expose_api_port: true',
            '  debug_logging: bool?\n  expose_api_port: bool?',
        );
        const targetText = target('  debug_logging: true', '  debug_logging: bool?');

        const { text } = syncDevConfig(sourceText, targetText);

        expect(text).toContain('  # explains the default\n  expose_api_port: true');
    });

    it('tolerates a blank line between options in the source without carrying it into the merge', () => {
        const sourceText = source(
            '  debug_logging: false\n\n  expose_api_port: true',
            '  debug_logging: bool?\n  expose_api_port: bool?',
        );
        const targetText = target('  debug_logging: true', '  debug_logging: bool?');

        const { text, added } = syncDevConfig(sourceText, targetText);

        expect(added).toEqual(['expose_api_port']);
        const optionsBlock = text.slice(text.indexOf('options:'), text.indexOf('schema:'));
        expect(optionsBlock).not.toContain('\n\n');
        expect(text).toContain('  debug_logging: true\n  expose_api_port: true');
    });

    it('drops a comment from the merge when a blank line separates it from the key below', () => {
        const sourceText = source(
            '  debug_logging: false\n  # a standalone note, not attached below\n\n  expose_api_port: true',
            '  debug_logging: bool?\n  expose_api_port: bool?',
        );
        const targetText = target('  debug_logging: true', '  debug_logging: bool?');

        const { text } = syncDevConfig(sourceText, targetText);

        expect(text).not.toContain('a standalone note');
        expect(text).toContain('  expose_api_port: true');
    });

    it('does not carry a trailing comment from the source into the target', () => {
        // #1920: the source's schema block is followed by a blank line and a
        // column-0 comment documenting `backup:`; neither is part of schema.
        const sourceText = [
            'name: "GLP — Gaggiuino Local Profiler"',
            'options:',
            '  debug_logging: false',
            'schema:',
            '  debug_logging: bool?',
            '',
            '# Home Assistant stops the app while it backs it up.',
            'backup: cold',
        ].join('\n');
        const targetText = target('  debug_logging: true', '  debug_logging: bool?');

        const { text } = syncDevConfig(sourceText, targetText);

        expect(text).not.toContain('# Home Assistant stops the app');
        expect(text).not.toContain('backup: cold');
        expect(text).toContain('  debug_logging: bool?');
    });

    it('leaves the target lines after its schema block untouched', () => {
        const sourceText = source('  debug_logging: false', '  debug_logging: bool?');
        const targetText = [
            'name: "GLP DEV — Gaggiuino Local Profiler (unstable)"',
            'boot: manual',
            'options:',
            '  debug_logging: true',
            'schema:',
            '  debug_logging: bool?',
            '',
            '# keep me',
            'backup: cold',
        ].join('\n');

        const { text } = syncDevConfig(sourceText, targetText);

        expect(text).toContain('\n# keep me\nbackup: cold');
    });

    it('leaves the real config.yaml lines after the schema entries untouched', () => {
        const real = read('config.yaml');
        // Stand-in for the dev manifest: same schema, a stale value, and its
        // own comment above `backup:`.
        const devText = real.replace('  sync_interval: int(1,60)', '  sync_interval: int(1,5)')
            .replace('# Home Assistant stops the app while it backs it up:', '# dev-only note');
        const devTail = devText.slice(devText.indexOf('backup:'));

        const { text } = syncDevConfig(real, devText);

        expect(text).toContain('  sync_interval: int(1,60)');
        expect(text).not.toContain('# Home Assistant stops the app');
        expect(text.slice(text.indexOf('backup:'))).toBe(devTail);
    });

    it('is a no-op when options/schema already match', () => {
        const sourceText = source('  debug_logging: false', '  debug_logging: bool?');
        const targetText = target('  debug_logging: false', '  debug_logging: bool?');

        const { added, removed } = syncDevConfig(sourceText, targetText);

        expect(added).toEqual([]);
        expect(removed).toEqual([]);
    });
});
