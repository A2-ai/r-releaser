import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const INDEX = path.join(import.meta.dirname, 'index.js');

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
        writeInput('source', { 'pkg_1.0.0.tar.gz': { type: 'source' } });
        writeInput('alma8', { 'pkg_1.0.0_linux_alma8_x64_4.4.tar.gz': { type: 'binary' } });

        const result = runMerge();
        expect(result.status).toBe(0);

        const merged = JSON.parse(fs.readFileSync(path.join(workspace, 'manifest.json'), 'utf8'));
        expect(Object.keys(merged).sort()).toEqual([
            'pkg_1.0.0.tar.gz',
            'pkg_1.0.0_linux_alma8_x64_4.4.tar.gz',
        ]);
    });

    it('tolerates identical duplicate entries', () => {
        writeInput('a', { 'pkg_1.0.0.tar.gz': { type: 'source', version: '1.0.0' } });
        writeInput('b', { 'pkg_1.0.0.tar.gz': { type: 'source', version: '1.0.0' } });

        expect(runMerge().status).toBe(0);
    });

    it('fails on conflicting duplicate entries instead of last-wins', () => {
        writeInput('a', { 'pkg_1.0.0.tar.gz': { type: 'source', version: '1.0.0' } });
        writeInput('b', { 'pkg_1.0.0.tar.gz': { type: 'source', version: '2.0.0' } });

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
});
