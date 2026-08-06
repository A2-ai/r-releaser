import { describe, it, expect } from 'vitest';
import { mapOs, mapArch, buildDescriptionFields, parseSkipRules, matchSkipRule } from './prepare-binaries.js';

describe('mapOs', () => {
    it('maps linux codenames through the shared platform table', () => {
        expect(mapOs('linux', 'alma8')).toBe('almalinux 8');
        expect(mapOs('linux', 'almalinux8')).toBe('almalinux 8');
        expect(mapOs('linux', 'rhel9')).toBe('redhat 9');
        expect(mapOs('linux', 'ubuntu22')).toBe('ubuntu 22');
    });

    it('maps macos and windows directly', () => {
        expect(mapOs('macos', 'macos')).toBe('macOS');
        expect(mapOs('windows', 'windows')).toBe('windows');
    });

    it('points at shared/platforms.json for unknown distros', () => {
        expect(() => mapOs('linux', 'gentoo2')).toThrow(/shared\/platforms\.json/);
    });

    it('rejects malformed codenames and unknown os values', () => {
        expect(() => mapOs('linux', 'no-version')).toThrow(/Invalid os_codename/);
        expect(() => mapOs('beos', 'beos')).toThrow(/Unknown os value/);
    });
});

describe('mapArch', () => {
    it('normalizes x64 and passes other arches through', () => {
        expect(mapArch('x64')).toBe('x86_64');
        expect(mapArch('arm64')).toBe('arm64');
    });
});

describe('buildDescriptionFields', () => {
    it('builds OS/Arch/LinkedTo from a binary manifest entry', () => {
        const fields = buildDescriptionFields({
            os: 'linux',
            os_codename: 'alma8',
            arch: 'x64',
            linked_to: { Rcpp: '1.0.11', cli: '3.6.1' },
        });
        expect(fields).toEqual({
            OS: 'almalinux 8',
            Arch: 'x86_64',
            LinkedTo: 'Rcpp (== 1.0.11), cli (== 3.6.1)',
        });
    });

    it('omits absent attributes', () => {
        expect(buildDescriptionFields({ os: 'macos', arch: 'arm64' })).toEqual({
            OS: 'macOS',
            Arch: 'arm64',
        });
    });
});

describe('skip rules', () => {
    it('ORs rules and ANDs tokens within a rule', () => {
        const rules = parseSkipRules('windows+4.3, ubuntu22');
        const windows43 = { os: 'windows', os_codename: 'windows', r_version: '4.3' };
        const windows44 = { os: 'windows', os_codename: 'windows', r_version: '4.4' };
        const ubuntu = { os: 'linux', os_codename: 'ubuntu22', r_version: '4.4' };

        expect(matchSkipRule(windows43, rules)).toEqual(['windows', '4.3']);
        expect(matchSkipRule(windows44, rules)).toBeNull();
        expect(matchSkipRule(ubuntu, rules)).toEqual(['ubuntu22']);
    });

    it('parses empty input to no rules', () => {
        expect(parseSkipRules(undefined)).toEqual([]);
        expect(parseSkipRules('')).toEqual([]);
    });
});
