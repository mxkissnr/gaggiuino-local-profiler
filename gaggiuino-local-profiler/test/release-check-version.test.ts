import { describe, it, expect } from 'vitest';
import { checkVersionMatch, type VersionSource } from '../scripts/release-check.mts';

// Check 1 of release-check.mts. An unreadable or version-less source must be
// a failure, not a silently skipped comparison — otherwise the gate can pass
// by omission when a file moves or cannot be read.
describe('checkVersionMatch', () => {
    const packageJsonRe = /"version"\s*:\s*"([^"]+)"/;

    function sources(...values: (string | null)[]): VersionSource[] {
        return values.map((source, i) => ({ label: `spot${i}`, source, re: packageJsonRe }));
    }

    const configSource = 'version: "3.4.0"\n';

    it('passes when every source matches config.yaml', () => {
        const result = checkVersionMatch(configSource, sources('{"version":"3.4.0"}', '{"version":"3.4.0"}'));
        expect(result).toEqual({ configVersion: '3.4.0', failures: [] });
    });

    it('fails when a source does not match config.yaml', () => {
        const result = checkVersionMatch(configSource, sources('{"version":"3.3.0"}'));
        expect(result.configVersion).toBe('3.4.0');
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toContain('spot0="3.3.0"');
    });

    it('fails closed when a source could not be read', () => {
        const result = checkVersionMatch(configSource, sources(null));
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toContain('could not read a version from spot0');
    });

    it('fails closed when a source has no version field', () => {
        const result = checkVersionMatch(configSource, sources('{"name":"app"}'));
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toContain('could not read a version from spot0');
    });

    it('fails closed when config.yaml cannot be read', () => {
        const result = checkVersionMatch(null, sources('{"version":"3.4.0"}'));
        expect(result.configVersion).toBeNull();
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toContain('could not read the version: field from config.yaml');
    });

    it('fails closed when config.yaml has no version field', () => {
        const result = checkVersionMatch('name: app\n', sources('{"version":"3.4.0"}'));
        expect(result.configVersion).toBeNull();
        expect(result.failures).toHaveLength(1);
    });
});
