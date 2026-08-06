import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const actionYml = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'action.yml'),
    'utf8'
);

// The exact filter the upload step runs, so the test breaks if the action changes.
const filterLine = actionYml.split('\n').find(l => l.includes('has("no_sys_deps")'));
const jqFilter = filterLine && filterLine.match(/'([^']+)'/)?.[1];

let jqAvailable = true;
try {
    execFileSync('jq', ['--version'], { stdio: 'pipe' });
} catch {
    jqAvailable = false;
}

const runFilter = (manifest, fileName) =>
    execFileSync('jq', ['-r', '--arg', 'f', fileName, jqFilter], {
        input: JSON.stringify(manifest),
        encoding: 'utf8',
    }).trim();

describe('deploy-prism no_sys_deps manifest filter', () => {
    it('exists in action.yml', () => {
        expect(jqFilter).toBeTruthy();
    });

    it.skipIf(!jqAvailable)('distinguishes true, false, and absent', () => {
        const entry = { type: 'binary', os: 'linux' };
        expect(runFilter({ 'a.tar.gz': { ...entry, no_sys_deps: true } }, 'a.tar.gz')).toBe('true');
        expect(runFilter({ 'a.tar.gz': { ...entry, no_sys_deps: false } }, 'a.tar.gz')).toBe('false');
        expect(runFilter({ 'a.tar.gz': entry }, 'a.tar.gz')).toBe('absent');
    });
});
