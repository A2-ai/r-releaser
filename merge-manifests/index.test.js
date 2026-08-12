import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const INDEX = path.join(import.meta.dirname, 'index.js');

const SOURCE_ENTRY = {
    package: 'pkg',
    version: '1.0.0',
    type: 'source',
    needs_compilation: true,
    PrismRemoteRef: 'v1.0.0',
};

const BINARY_ENTRY = {
    package: 'pkg',
    version: '1.0.0',
    type: 'binary',
    os: 'linux',
    os_codename: 'alma8',
    arch: 'x64',
    r_version: '4.4',
    linked_to: { Rcpp: '1.0.11' },
};

const DOCS_ENTRY = {
    package: 'pkg',
    version: '1.0.0',
    type: 'docs',
};

let workspace;
beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-manifests-test-'));
    fs.mkdirSync(path.join(workspace, 'manifests'));
});
afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
});

function writeInput(name, manifest) {
    const dir = path.join(workspace, 'manifests', name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
}

function runMerge() {
    return spawnSync(process.execPath, [INDEX], {
        encoding: 'utf8',
        env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            INPUT_MANIFEST_DIR: 'manifests',
            INPUT_MANIFEST_GLOB: '**/manifest.json',
        },
    });
}

describe('merge-manifests', () => {
    it('merges entries from multiple manifests', () => {
        writeInput('source', { 'pkg_1.0.0.tar.gz': SOURCE_ENTRY });
        writeInput('alma8', { 'pkg_1.0.0_linux_alma8_x64_4.4.tar.gz': BINARY_ENTRY });

        const result = runMerge();
        expect(result.status).toBe(0);

        const merged = JSON.parse(fs.readFileSync(path.join(workspace, 'manifest.json'), 'utf8'));
        expect(Object.keys(merged).sort()).toEqual([
            'pkg_1.0.0.tar.gz',
            'pkg_1.0.0_linux_alma8_x64_4.4.tar.gz',
        ]);
    });

    it('merges a docs entry alongside source and binary entries', () => {
        writeInput('source', { 'pkg_1.0.0.tar.gz': SOURCE_ENTRY });
        writeInput('alma8', { 'pkg_1.0.0_linux_alma8_x64_4.4.tar.gz': BINARY_ENTRY });
        writeInput('docs', { 'pkg_1.0.0_docs.tar.gz': DOCS_ENTRY });

        const result = runMerge();
        expect(result.status).toBe(0);

        const merged = JSON.parse(fs.readFileSync(path.join(workspace, 'manifest.json'), 'utf8'));
        expect(merged['pkg_1.0.0_docs.tar.gz']).toEqual(DOCS_ENTRY);
        expect(Object.keys(merged)).toHaveLength(3);
    });

    it('tolerates identical duplicate entries', () => {
        writeInput('a', { 'pkg_1.0.0.tar.gz': SOURCE_ENTRY });
        writeInput('b', { 'pkg_1.0.0.tar.gz': SOURCE_ENTRY });

        expect(runMerge().status).toBe(0);
    });

    it('fails on conflicting duplicate entries instead of last-wins', () => {
        writeInput('a', { 'pkg_1.0.0.tar.gz': SOURCE_ENTRY });
        writeInput('b', { 'pkg_1.0.0.tar.gz': { ...SOURCE_ENTRY, version: '2.0.0' } });

        const result = runMerge();
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('conflicts with the entry already merged');
    });

    it('names the offending file for malformed JSON', () => {
        fs.mkdirSync(path.join(workspace, 'manifests', 'bad'));
        fs.writeFileSync(path.join(workspace, 'manifests', 'bad', 'manifest.json'), '{not json');

        const result = runMerge();
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('Failed to parse manifest');
    });

    it('rejects merged manifests that fail schema validation', () => {
        writeInput('bad', { 'pkg_1.0.0.tar.gz': { type: 'source' } });

        const result = runMerge();
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('Merged manifest is invalid');
    });
});
