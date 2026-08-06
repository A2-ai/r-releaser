import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLinkedTo, decomposePlatformTag, getExtension } from './lib.js';

describe('resolveLinkedTo', () => {
    let libDir;

    beforeEach(() => {
        libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-bin-test-'));
        for (const [pkg, version] of [['Rcpp', '1.0.11'], ['Matrix', '1.6-1']]) {
            fs.mkdirSync(path.join(libDir, pkg));
            fs.writeFileSync(
                path.join(libDir, pkg, 'DESCRIPTION'),
                `Package: ${pkg}\nVersion: ${version}\n`
            );
        }
    });

    afterEach(() => {
        fs.rmSync(libDir, { recursive: true, force: true });
    });

    it('excludes builtin packages by default', () => {
        const linkedTo = resolveLinkedTo(['Rcpp', 'Matrix'], libDir, false);
        expect(linkedTo).toEqual({ Rcpp: '1.0.11' });
    });

    it('includes builtin packages when opted in', () => {
        const linkedTo = resolveLinkedTo(['Rcpp', 'Matrix'], libDir, true);
        expect(linkedTo).toEqual({ Rcpp: '1.0.11', Matrix: '1.6-1' });
    });

    it('falls back to unknown for deps missing from the library', () => {
        const linkedTo = resolveLinkedTo(['nope'], libDir, false);
        expect(linkedTo).toEqual({ nope: 'unknown' });
    });
});

describe('decomposePlatformTag', () => {
    it('splits linux tags into os and codename', () => {
        expect(decomposePlatformTag('linux_alma8')).toEqual({ os: 'linux', os_codename: 'alma8' });
        expect(decomposePlatformTag('linux_ubuntu22')).toEqual({ os: 'linux', os_codename: 'ubuntu22' });
    });

    it('uses the whole tag for non-linux platforms', () => {
        expect(decomposePlatformTag('macos')).toEqual({ os: 'macos', os_codename: 'macos' });
    });
});

describe('getExtension', () => {
    it('recognizes archive extensions', () => {
        expect(getExtension('pkg_1.0.0.tar.gz')).toBe('.tar.gz');
        expect(getExtension('pkg_1.0.0.zip')).toBe('.zip');
        expect(getExtension('pkg_1.0.0.txt')).toBe('');
    });
});
