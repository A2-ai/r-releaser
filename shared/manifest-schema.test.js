import { describe, it, expect } from 'vitest';
import { validateManifest } from './manifest-schema.js';

const VALID = {
    'pkg_1.0.0.tar.gz': {
        package: 'pkg',
        version: '1.0.0',
        type: 'source',
        needs_compilation: false,
        GitSHA: 'abc123',
        PrismRemoteRef: 'v1.0.0',
    },
    'pkg_1.0.0_linux_alma8_x64_4.4.tar.gz': {
        package: 'pkg',
        version: '1.0.0',
        type: 'binary',
        os: 'linux',
        os_codename: 'alma8',
        arch: 'x64',
        r_version: '4.4',
        linked_to: { Rcpp: '1.0.11' },
        no_sys_deps: true,
        glibc_max: '2.28',
    },
};

describe('validateManifest', () => {
    it('accepts a valid manifest', () => {
        expect(validateManifest(VALID)).toEqual([]);
    });

    it('rejects non-object manifests', () => {
        expect(validateManifest([])).toHaveLength(1);
        expect(validateManifest(null)).toHaveLength(1);
    });

    it('requires package and version', () => {
        const errors = validateManifest({ 'x.tar.gz': { type: 'source', needs_compilation: true } });
        expect(errors.join('\n')).toContain('"package" must be a non-empty string');
        expect(errors.join('\n')).toContain('"version" must be a non-empty string');
    });

    it('rejects unknown or missing type', () => {
        const errors = validateManifest({ 'x.tar.gz': { package: 'x', version: '1', type: 'sauce' } });
        expect(errors.join('\n')).toContain('"type" must be "source" or "binary"');
    });

    it('requires binary platform fields and string linked_to versions', () => {
        const errors = validateManifest({
            'x.tar.gz': { package: 'x', version: '1', type: 'binary', linked_to: { Rcpp: 1.0 } },
        });
        const joined = errors.join('\n');
        for (const key of ['os', 'os_codename', 'arch', 'r_version']) {
            expect(joined).toContain(`"${key}" must be a non-empty string`);
        }
        expect(joined).toContain('linked_to["Rcpp"] must be a string');
    });

    it('accepts binary entries without portability fields', () => {
        const entry = { ...VALID['pkg_1.0.0_linux_alma8_x64_4.4.tar.gz'] };
        delete entry.no_sys_deps;
        delete entry.glibc_max;
        expect(validateManifest({ 'x.tar.gz': entry })).toEqual([]);
    });

    it('rejects mistyped portability fields', () => {
        const base = VALID['pkg_1.0.0_linux_alma8_x64_4.4.tar.gz'];
        const errors = validateManifest({
            'x.tar.gz': { ...base, no_sys_deps: 'true', glibc_max: 2.28 },
        });
        const joined = errors.join('\n');
        expect(joined).toContain('"no_sys_deps" must be a boolean');
        expect(joined).toContain('"glibc_max" must be a version string');
    });

    it('rejects glibc_max with trailing garbage', () => {
        const base = VALID['pkg_1.0.0_linux_alma8_x64_4.4.tar.gz'];
        const errors = validateManifest({ 'x.tar.gz': { ...base, glibc_max: '2.28garbage' } });
        expect(errors.join('\n')).toContain('"glibc_max" must be a version string');
    });

    it('rejects non-scalar source metadata', () => {
        const errors = validateManifest({
            'x.tar.gz': { package: 'x', version: '1', type: 'source', needs_compilation: true, extra: { nested: true } },
        });
        expect(errors.join('\n')).toContain('metadata field "extra"');
    });
});
