#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { updateDescription } = require('../shared/description');
const { validateManifest } = require('../shared/manifest-schema');
const { linux_id_map: LINUX_ID_MAP, codename_aliases: CODENAME_ALIASES } = require('../shared/platforms.json');

const MANAGED_FIELDS = ['OS', 'Arch', 'LinkedTo'];

function mapOs(osField, osCodename) {
    if (osField === 'macos') return 'macOS';
    if (osField === 'windows') return 'windows';

    if (osField !== 'linux') {
        throw new Error(`Unknown os value: "${osField}"`);
    }

    if (CODENAME_ALIASES[osCodename]) {
        return CODENAME_ALIASES[osCodename];
    }

    // Linux: split codename into name + version number
    // e.g. "ubuntu22" -> "ubuntu 22", "alma8" -> "almalinux 8", "rhel9" -> "redhat 9"
    const match = osCodename.match(/^([a-z]+)(\d+)$/);
    if (!match) {
        throw new Error(`Invalid os_codename for linux binary: "${osCodename}"`);
    }

    const name = LINUX_ID_MAP[match[1]];
    const version = match[2];
    if (!name) {
        throw new Error(`Unknown linux distro "${match[1]}" in os_codename "${osCodename}" — add it to shared/platforms.json`);
    }
    return `${name} ${version}`;
}

function mapArch(arch) {
    if (arch === 'x64') return 'x86_64';
    return arch; // arm64 stays arm64
}

function formatLinkedTo(linkedTo) {
    // { "Rcpp": "1.0.11", "cli": "3.6.1" } -> "Rcpp (== 1.0.11), cli (== 3.6.1)"
    return Object.entries(linkedTo)
        .map(([pkg, ver]) => `${pkg} (== ${ver})`)
        .join(', ');
}

function getArchiveExtension(filename) {
    for (const ext of ['.tar.gz', '.tgz', '.zip']) {
        if (filename.endsWith(ext)) return ext;
    }
    return null;
}

function run(cmd, args, opts = {}) {
    const result = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
    if (result.error) {
        throw new Error(`Failed to run ${cmd}: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}:\n${result.stderr}`);
    }
}

function extractArchive(archivePath, destDir, ext) {
    if (ext === '.tar.gz' || ext === '.tgz') {
        run('tar', ['xf', archivePath, '-C', destDir]);
    } else if (ext === '.zip') {
        run('unzip', ['-q', '-o', archivePath, '-d', destDir]);
    }
}

function repackArchive(archivePath, sourceDir, ext) {
    // Get the top-level entries to pack
    const entries = fs.readdirSync(sourceDir);
    if (ext === '.tar.gz' || ext === '.tgz') {
        run('tar', ['czf', archivePath, ...entries], { cwd: sourceDir });
    } else if (ext === '.zip') {
        run('zip', ['-qr', archivePath, ...entries], { cwd: sourceDir });
    }
}

function findDescription(extractDir, pkgName) {
    // Look for <pkgname>/DESCRIPTION inside extracted contents
    const descPath = path.join(extractDir, pkgName, 'DESCRIPTION');
    if (fs.existsSync(descPath)) return descPath;

    // Fallback: search one level deep for any DESCRIPTION
    for (const entry of fs.readdirSync(extractDir)) {
        const candidate = path.join(extractDir, entry, 'DESCRIPTION');
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function buildDescriptionFields(entry) {
    const fields = {};

    if (entry.os) {
        fields['OS'] = mapOs(entry.os, entry.os_codename || entry.os);
    }
    if (entry.arch) {
        fields['Arch'] = mapArch(entry.arch);
    }
    if (entry.linked_to && typeof entry.linked_to === 'object' && Object.keys(entry.linked_to).length > 0) {
        fields['LinkedTo'] = formatLinkedTo(entry.linked_to);
    }

    return fields;
}

function processEntry(downloadDir, filename, entry) {
    const ext = getArchiveExtension(filename);
    if (!ext) {
        throw new Error(`${filename}: unrecognized archive format`);
    }

    const archivePath = path.join(downloadDir, filename);
    if (!fs.existsSync(archivePath)) {
        throw new Error(`${filename}: file not found in download directory`);
    }

    const fields = buildDescriptionFields(entry);
    if (Object.keys(fields).length === 0) {
        throw new Error(`${filename}: binary entry produced no DESCRIPTION fields — check manifest data`);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-bin-'));
    try {
        // Extract
        extractArchive(archivePath, tmpDir, ext);

        // Find and modify DESCRIPTION
        const descPath = findDescription(tmpDir, entry.package);
        if (!descPath) {
            throw new Error(`${filename}: no DESCRIPTION found in archive`);
        }

        const content = fs.readFileSync(descPath, 'utf8');
        const remove = MANAGED_FIELDS.filter(name => !(name in fields));
        fs.writeFileSync(descPath, updateDescription(content, { set: fields, remove }), 'utf8');

        // Re-archive, replacing the original
        fs.unlinkSync(archivePath);
        repackArchive(archivePath, tmpDir, ext);

        console.log(`  Modified ${filename}: set ${Object.keys(fields).join(', ')}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

function parseSkipRules(raw) {
    // "windows+4.3, ubuntu22, 4.2" -> [["windows", "4.3"], ["ubuntu22"], ["4.2"]]
    // Rules are OR-ed; tokens within a rule are AND-ed.
    return (raw || '')
        .split(',')
        .map(rule => rule
            .split('+')
            .map(t => t.trim().toLowerCase())
            .filter(t => t.length > 0))
        .filter(tokens => tokens.length > 0);
}

function tokenMatchesEntry(token, entry) {
    // A token matches if it equals the entry's os, os_codename, or r_version.
    return [entry.os, entry.os_codename, entry.r_version]
        .some(v => typeof v === 'string' && v.toLowerCase() === token);
}

function matchSkipRule(entry, skipRules) {
    // Returns the first rule whose tokens ALL match the entry, or null.
    return skipRules.find(tokens => tokens.every(t => tokenMatchesEntry(t, entry))) || null;
}

function main() {
    const downloadDir = process.argv[2];
    if (!downloadDir) {
        console.error('Usage: prepare-binaries.js <download-dir>');
        process.exit(1);
    }

    const manifestPath = path.join(downloadDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error(`manifest.json not found in ${downloadDir}`);
        process.exit(1);
    }

    const skipRules = parseSkipRules(process.env.SKIP_RULES);
    if (skipRules.length > 0) {
        console.log(`Skip rules: ${skipRules.map(tokens => tokens.join('+')).join(', ')}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const problems = validateManifest(manifest);
    if (problems.length > 0) {
        console.error(`manifest.json is invalid:\n${problems.join('\n')}`);
        process.exit(1);
    }
    const entries = Object.entries(manifest);
    console.log(`Processing ${entries.length} manifest entries...`);

    const matchedRules = new Set();
    for (const [filename, entry] of entries) {
        if (entry.type !== 'binary') {
            console.log(`  Skipping ${filename}: type=${entry.type}`);
            continue;
        }
        const rule = matchSkipRule(entry, skipRules);
        if (rule) {
            matchedRules.add(rule);
            const archivePath = path.join(downloadDir, filename);
            if (fs.existsSync(archivePath)) {
                fs.unlinkSync(archivePath);
            }
            console.log(`  Skipping ${filename}: matched skip rule "${rule.join('+')}"; removed from upload set`);
            continue;
        }
        processEntry(downloadDir, filename, entry);
    }

    for (const rule of skipRules) {
        if (!matchedRules.has(rule)) {
            console.log(`::warning::skip rule "${rule.join('+')}" did not match any manifest entry`);
        }
    }
}

if (require.main === module) {
    main();
}

module.exports = { mapOs, mapArch, formatLinkedTo, buildDescriptionFields, parseSkipRules, matchSkipRule };
