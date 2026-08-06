import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildArgs, updateDescriptionFile } from './lib.js';

describe('buildArgs', () => {
    it('passes user through to R CMD build', () => {
        const args = buildArgs(true, true, false, 'r-releaser');
        expect(args).toContain('--user=r-releaser');
    });

    it('omits user when not given', () => {
        const args = buildArgs(true, true, false, undefined);
        expect(args.some(a => a.startsWith('--user'))).toBe(false);
    });

    it('maps the boolean flags', () => {
        expect(buildArgs(false, false, true)).toEqual(
            ['R', 'CMD', 'build', '.', '--no-build-vignettes', '--no-resave-data', '--md5']
        );
        expect(buildArgs(true, true, false)).toEqual(['R', 'CMD', 'build', '.']);
    });
});

describe('updateDescriptionFile', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-src-test-'));
        originalCwd = process.cwd();
        process.chdir(tmpDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('injects metadata, strips Remotes, and preserves multi-line fields', () => {
        fs.writeFileSync('DESCRIPTION', [
            'Package: mypkg',
            'Version: 0.1.0',
            'Imports:',
            '    cli,',
            '    rlang',
            'Remotes: r-lib/cli',
            '',
        ].join('\n'));

        const updated = updateDescriptionFile({ GitSHA: 'abc123', Version: '0.2.0' });

        expect(updated).toContain('Version: 0.2.0');
        expect(updated).toContain('GitSHA: abc123');
        expect(updated).not.toContain('Remotes:');
        expect(updated).toContain('Imports:\n    cli,\n    rlang');
        expect(fs.readFileSync('DESCRIPTION', 'utf8')).toBe(updated);
    });
});
