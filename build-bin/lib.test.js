import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    resolveLinkedTo,
    decomposePlatformTag,
    getExtension,
    isPortableRuntimeLib,
    parseNeededLibs,
    parseGlibcVersions,
    compareVersions,
    verifyPortability,
    applyPortabilityPolicy,
    readTarballDescription,
} from './lib.js';
import { execFileSync } from 'node:child_process';

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

describe('isPortableRuntimeLib', () => {
    it('allows the glibc family, loaders, libgcc_s, and the R family', () => {
        for (const lib of [
            'libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0',
            'librt.so.1', 'libresolv.so.2', 'libutil.so.1',
            'ld-linux-x86-64.so.2', 'ld-linux-aarch64.so.1',
            'libgcc_s.so.1',
            'libR.so', 'libRblas.so', 'libRlapack.so',
        ]) {
            expect(isPortableRuntimeLib(lib), lib).toBe(true);
        }
    });

    it('rejects compiler runtimes and system libraries', () => {
        for (const lib of [
            'libstdc++.so.6', 'libgfortran.so.5', 'libgomp.so.1',
            'libcurl.so.4', 'libxml2.so.2', 'libssl.so.3',
        ]) {
            expect(isPortableRuntimeLib(lib), lib).toBe(false);
        }
    });
});

const readelfOutput = (needed, versions = []) => [
    'Dynamic section at offset 0x1d8 contains 24 entries:',
    '  Tag        Type                         Name/Value',
    ...needed.map(lib => ` 0x0000000000000001 (NEEDED)             Shared library: [${lib}]`),
    ' 0x000000000000000e (SONAME)             Library soname: [pkg.so]',
    '',
    ...(versions.length ? [
        "Version needs section '.gnu.version_r' contains 1 entry:",
        ' Addr: 0x0000000000000560  Offset: 0x000560  Link: 5 (.dynstr)',
        '  000000: Version: 1  File: libc.so.6  Cnt: ' + versions.length,
        ...versions.map(v => `  0x0010:   Name: ${v}  Flags: none  Version: 2`),
    ] : []),
].join('\n');

describe('parseNeededLibs', () => {
    it('extracts every NEEDED entry', () => {
        const output = readelfOutput(['libcurl.so.4', 'libstdc++.so.6', 'libc.so.6']);
        expect(parseNeededLibs(output)).toEqual(['libcurl.so.4', 'libstdc++.so.6', 'libc.so.6']);
    });

    it('returns empty for a dynamic section with no NEEDED entries', () => {
        expect(parseNeededLibs(readelfOutput([]))).toEqual([]);
    });
});

describe('parseGlibcVersions', () => {
    it('captures GLIBC_ versions but not GLIBCXX_', () => {
        const output = readelfOutput(['libc.so.6'], ['GLIBC_2.17', 'GLIBCXX_3.4.29', 'GLIBC_2.28']);
        expect(parseGlibcVersions(output)).toEqual(['2.17', '2.28']);
    });
});

describe('compareVersions', () => {
    it('compares segment-wise numerically, not lexicographically', () => {
        expect(compareVersions('2.28', '2.9')).toBeGreaterThan(0);
        expect(compareVersions('2.9', '2.28')).toBeLessThan(0);
        expect(compareVersions('2.28', '2.28')).toBe(0);
        expect(compareVersions('2.2.5', '2.2')).toBeGreaterThan(0);
    });
});

describe('verifyPortability', () => {
    let libDir;

    const makeSoFiles = (...names) => {
        const libsPath = path.join(libDir, 'pkg', 'libs');
        for (const name of names) {
            fs.mkdirSync(path.dirname(path.join(libsPath, name)), { recursive: true });
            fs.writeFileSync(path.join(libsPath, name), '');
        }
    };

    beforeEach(() => {
        libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-bin-verify-'));
    });

    afterEach(() => {
        fs.rmSync(libDir, { recursive: true, force: true });
    });

    it('throws when the installed package directory is missing', () => {
        expect(() => verifyPortability(libDir, 'pkg', () => {
            throw Error('should not be called');
        })).toThrow('Installed package not found');
    });

    it('is trivially portable when there is no libs directory', () => {
        fs.mkdirSync(path.join(libDir, 'pkg'), { recursive: true });
        expect(verifyPortability(libDir, 'pkg', () => {
            throw Error('should not be called');
        })).toEqual({ noSysDeps: true, violations: [], glibcMax: null });
    });

    it('passes clean objects and records the max GLIBC_ across all of them', () => {
        makeSoFiles('a.so', 'b.so');
        const outputs = {
            'a.so': readelfOutput(['libc.so.6', 'libm.so.6'], ['GLIBC_2.28']),
            'b.so': readelfOutput(['libc.so.6', 'libgcc_s.so.1'], ['GLIBC_2.17']),
        };
        const result = verifyPortability(libDir, 'pkg', soPath => outputs[path.basename(soPath)]);
        expect(result).toEqual({ noSysDeps: true, violations: [], glibcMax: '2.28' });
    });

    it('reports violations from every object, not just the first', () => {
        makeSoFiles('a.so', 'b.so');
        const outputs = {
            'a.so': readelfOutput(['libstdc++.so.6', 'libc.so.6']),
            'b.so': readelfOutput(['libcurl.so.4', 'libgomp.so.1']),
        };
        const result = verifyPortability(libDir, 'pkg', soPath => outputs[path.basename(soPath)]);
        expect(result.noSysDeps).toBe(false);
        expect(result.violations).toEqual([
            { so: 'a.so', libs: ['libstdc++.so.6'] },
            { so: 'b.so', libs: ['libcurl.so.4', 'libgomp.so.1'] },
        ]);
    });

    it('finds shared objects in arch subdirectories', () => {
        makeSoFiles(path.join('x64', 'pkg.so'));
        const result = verifyPortability(libDir, 'pkg', () => readelfOutput(['libcurl.so.4']));
        expect(result.noSysDeps).toBe(false);
        expect(result.violations).toEqual([
            { so: path.join('x64', 'pkg.so'), libs: ['libcurl.so.4'] },
        ]);
    });

    it('propagates readelf failures', () => {
        makeSoFiles('a.so');
        expect(() => verifyPortability(libDir, 'pkg', () => {
            throw Error('spawn readelf ENOENT');
        })).toThrow('spawn readelf ENOENT');
    });

    it('throws when the output has no dynamic section', () => {
        makeSoFiles('a.so');
        expect(() => verifyPortability(libDir, 'pkg', () => 'not readelf output'))
            .toThrow('contains no dynamic section');
    });
});

describe('applyPortabilityPolicy', () => {
    const linux = { platform: 'linux', platformTag: 'linux_alma8', pkgName: 'pkg' };
    const clean = { noSysDeps: true, violations: [], glibcMax: '2.28' };
    const dirty = {
        noSysDeps: false,
        violations: [{ so: 'pkg.so', libs: ['libstdc++.so.6', 'libcurl.so.4'] }],
        glibcMax: '2.17',
    };

    it('warns and writes nothing on non-linux when claimed', () => {
        const out = applyPortabilityPolicy({
            claimed: true, platform: 'darwin', platformTag: 'macos', pkgName: 'pkg',
            verify: () => { throw Error('should not be called'); },
        });
        expect(out.fields).toEqual({});
        expect(out.warning).toContain('applies only to linux');
        expect(out.notice).toBeNull();
    });

    it('is silent on non-linux when unclaimed', () => {
        const out = applyPortabilityPolicy({
            claimed: false, platform: 'darwin', platformTag: 'macos', pkgName: 'pkg',
            verify: () => { throw Error('should not be called'); },
        });
        expect(out).toEqual({ fields: {}, warning: null, notice: null });
    });

    it('fails a claim when verification cannot run', () => {
        expect(() => applyPortabilityPolicy({
            ...linux, claimed: true, verify: () => { throw Error('spawn readelf ENOENT'); },
        })).toThrow('no_sys_deps was claimed but could not be verified: spawn readelf ENOENT');
    });

    it('downgrades to a warning with no fields when unclaimed verification cannot run', () => {
        const out = applyPortabilityPolicy({
            ...linux, claimed: false, verify: () => { throw Error('spawn readelf ENOENT'); },
        });
        expect(out.fields).toEqual({});
        expect(out.warning).toContain('could not run');
    });

    it('fails a claim on violations, naming every object and library', () => {
        expect(() => applyPortabilityPolicy({ ...linux, claimed: true, verify: () => dirty }))
            .toThrow('pkg.so: libstdc++.so.6, libcurl.so.4');
    });

    it('records violations silently when unclaimed', () => {
        const out = applyPortabilityPolicy({ ...linux, claimed: false, verify: () => dirty });
        expect(out.fields).toEqual({ no_sys_deps: false, glibc_max: '2.17' });
        expect(out.warning).toBeNull();
        expect(out.notice).toBeNull();
    });

    it('confirms a clean claim with fields and a notice', () => {
        const out = applyPortabilityPolicy({ ...linux, claimed: true, verify: () => clean });
        expect(out.fields).toEqual({ no_sys_deps: true, glibc_max: '2.28' });
        expect(out.notice).toContain('verified');
        expect(out.notice).toContain('2.28');
    });

    it('suggests the flag on a clean unclaimed build', () => {
        const out = applyPortabilityPolicy({ ...linux, claimed: false, verify: () => clean });
        expect(out.fields).toEqual({ no_sys_deps: true, glibc_max: '2.28' });
        expect(out.notice).toContain('eligible for no_sys_deps');
    });

    it('omits glibc_max when no GLIBC_ requirement was seen', () => {
        const out = applyPortabilityPolicy({
            ...linux, claimed: false,
            verify: () => ({ noSysDeps: true, violations: [], glibcMax: null }),
        });
        expect(out.fields).toEqual({ no_sys_deps: true });
    });
});

describe('readTarballDescription', () => {
    let workDir;

    beforeEach(() => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-bin-tarball-'));
    });

    afterEach(() => {
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    const makeTarball = (dirName, descContent, tarballName) => {
        fs.mkdirSync(path.join(workDir, dirName));
        if (descContent !== null) {
            fs.writeFileSync(path.join(workDir, dirName, 'DESCRIPTION'), descContent);
        }
        const tarballPath = path.join(workDir, tarballName);
        execFileSync('tar', ['-czf', tarballPath, '-C', workDir, dirName]);
        return tarballPath;
    };

    it('reads Package and Version from DESCRIPTION, not the filename', () => {
        const tarball = makeTarball('mypkg', 'Package: mypkg\nVersion: 1.2.3\n', 'renamed-download.tar.gz');
        expect(readTarballDescription(tarball)).toEqual({ pkgName: 'mypkg', pkgVersion: '1.2.3' });
    });

    it('throws when the tarball has no top-level DESCRIPTION', () => {
        const tarball = makeTarball('mypkg', null, 'mypkg_1.0.0.tar.gz');
        expect(() => readTarballDescription(tarball)).toThrow('No top-level DESCRIPTION');
    });

    it('throws when DESCRIPTION lacks Package or Version', () => {
        const tarball = makeTarball('mypkg', 'Package: mypkg\n', 'mypkg_1.0.0.tar.gz');
        expect(() => readTarballDescription(tarball)).toThrow('lacks Package or Version');
    });
});
