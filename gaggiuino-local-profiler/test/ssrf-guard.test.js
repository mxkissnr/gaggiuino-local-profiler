import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { isPrivateAddress, isLoopbackOrMetadataAddress } = require('../lib/ssrf-guard');

// #336: isPrivateAddress() (used by the bean-import route, where the host
// comes from arbitrary user-supplied external content) and
// isLoopbackOrMetadataAddress() (used for machine hosts, the app owner's
// own trusted LAN configuration) are deliberately different — a real
// Gaggiuino/GaggiMate controller lives at exactly the private addresses
// isPrivateAddress() blocks, so machine hosts must not be checked against it.
describe('isPrivateAddress (bean-import SSRF guard)', () => {
    it('blocks RFC1918 private ranges', () => {
        expect(isPrivateAddress('10.1.10.19')).toBe(true);
        expect(isPrivateAddress('192.168.1.5')).toBe(true);
        expect(isPrivateAddress('172.20.0.1')).toBe(true);
    });
    it('blocks loopback and link-local', () => {
        expect(isPrivateAddress('127.0.0.1')).toBe(true);
        expect(isPrivateAddress('169.254.169.254')).toBe(true);
    });
    it('allows a public address', () => {
        expect(isPrivateAddress('203.0.113.10')).toBe(false);
    });
});

describe('isLoopbackOrMetadataAddress (machine-host SSRF guard)', () => {
    it('allows RFC1918 private LAN ranges — real machines live there', () => {
        expect(isLoopbackOrMetadataAddress('10.1.10.19')).toBe(false);
        expect(isLoopbackOrMetadataAddress('192.168.1.5')).toBe(false);
        expect(isLoopbackOrMetadataAddress('172.20.0.1')).toBe(false);
    });
    it('still blocks loopback', () => {
        expect(isLoopbackOrMetadataAddress('127.0.0.1')).toBe(true);
    });
    it('still blocks link-local, including the cloud-metadata address', () => {
        expect(isLoopbackOrMetadataAddress('169.254.169.254')).toBe(true);
        expect(isLoopbackOrMetadataAddress('169.254.1.1')).toBe(true);
    });
    it('allows a public address', () => {
        expect(isLoopbackOrMetadataAddress('203.0.113.10')).toBe(false);
    });
});
