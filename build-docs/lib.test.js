import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    MAX_TARBALL_BYTES,
    PKGDOCS_BUILD_R,
    defaultAssetName,
    writeBuildScript,
    tarDocs,
    checkTarballSize,
} from './lib.js';

describe('defaultAssetName', () => {
    it('names the tarball per package and version', () => {
        expect(defaultAssetName('mypkg', '0.1.0')).toBe('mypkg_0.1.0_docs.tar.gz');
    });

    it('does not collide with a source tarball name', () => {
        expect(defaultAssetName('mypkg', '0.1.0')).not.toBe('mypkg_0.1.0.tar.gz');
    });
});

describe('PKGDOCS_BUILD_R', () => {
    it('drops the keys PRISM overrides and forces bootstrap 5', () => {
        expect(PKGDOCS_BUILD_R).toContain('c("url", "template", "redirects", "destination")');
        expect(PKGDOCS_BUILD_R).toContain('list(template = list(bootstrap = 5L))');
    });

    it('retries the build without examples', () => {
        expect(PKGDOCS_BUILD_R).toContain('pkgdown::build_site(working_dir, examples = FALSE)');
    });
});

describe('writeBuildScript', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-docs-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes the script verbatim', () => {
        const scriptPath = writeBuildScript(tmpDir);
        expect(fs.readFileSync(scriptPath, 'utf8')).toBe(PKGDOCS_BUILD_R);
    });
});

describe('tarDocs', () => {
    let tmpDir;
    let docsDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-docs-test-'));
        docsDir = path.join(tmpDir, 'docs');
        fs.mkdirSync(path.join(docsDir, 'reference'), { recursive: true });
        fs.writeFileSync(path.join(docsDir, 'index.html'), '<html></html>');
        fs.writeFileSync(path.join(docsDir, 'reference', 'fn.html'), '<html></html>');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('packs the docs directory contents without a leading directory', () => {
        const tarball = path.join(tmpDir, 'pkg_1.0.0_docs.tar.gz');
        tarDocs(docsDir, tarball);

        const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
            .split('\n')
            .filter(line => line.length > 0);

        expect(listing).toContain('./index.html');
        expect(listing).toContain('./reference/fn.html');
        expect(listing.some(entry => entry.includes('/docs/'))).toBe(false);
    });

    it('fails with tar stderr when the directory does not exist', () => {
        expect(() => tarDocs(path.join(tmpDir, 'missing'), path.join(tmpDir, 'out.tar.gz')))
            .toThrow(/tar exited with/);
    });
});

describe('checkTarballSize', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-docs-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns the size of a tarball under the cap', () => {
        const file = path.join(tmpDir, 'small.tar.gz');
        fs.writeFileSync(file, 'x'.repeat(64));
        expect(checkTarballSize(file)).toBe(64);
    });

    it('reports the actual byte count when over the cap', () => {
        const file = path.join(tmpDir, 'big.tar.gz');
        // Sparse file: only the length matters to the cap check.
        const fd = fs.openSync(file, 'w');
        fs.ftruncateSync(fd, MAX_TARBALL_BYTES + 1);
        fs.closeSync(fd);
        expect(() => checkTarballSize(file)).toThrow(`${MAX_TARBALL_BYTES + 1} bytes`);
    });
});
