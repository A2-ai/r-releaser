import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeManifest, updateManifest, parseLinkingTo } from './manifest.js';

let tmpDir;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
});
afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('updateManifest', () => {
    it('merges into an existing manifest instead of replacing it', () => {
        const manifestPath = path.join(tmpDir, 'manifest.json');
        writeManifest(manifestPath, {
            'pkg_1.0.0.tar.gz': { package: 'pkg', version: '1.0.0', type: 'source' },
        });
        updateManifest(manifestPath, {
            'pkg_1.0.0_linux_alma8_x64_4.4.tar.gz': { package: 'pkg', version: '1.0.0', type: 'binary' },
        });

        const merged = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        expect(Object.keys(merged)).toHaveLength(2);
        expect(merged['pkg_1.0.0.tar.gz'].type).toBe('source');
        expect(merged['pkg_1.0.0_linux_alma8_x64_4.4.tar.gz'].type).toBe('binary');
    });

    it('creates the manifest when none exists', () => {
        const manifestPath = path.join(tmpDir, 'manifest.json');
        updateManifest(manifestPath, { 'a.tar.gz': { type: 'binary' } });
        const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        expect(written['a.tar.gz'].type).toBe('binary');
    });
});

describe('parseLinkingTo', () => {
    it('strips version constraints and whitespace', () => {
        expect(parseLinkingTo('Rcpp (>= 1.0.0), cli')).toEqual(['Rcpp', 'cli']);
    });

    it('returns an empty array for empty input', () => {
        expect(parseLinkingTo(undefined)).toEqual([]);
    });
});
