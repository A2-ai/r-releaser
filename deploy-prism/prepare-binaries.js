#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const os = require('node:os');

const CODENAME_MAP = {
    rhel: 'redhat',
    alma: 'almalinux',
};

const MANAGED_FIELDS = ['OS', 'Arch', 'LinkedTo'];

function mapOs(osField, osCodename) {
    if (osField === 'macos') return 'macOS';
    if (osField === 'windows') return 'windows';

    if (osField !== 'linux') {
        throw new Error(`Unknown os value: "${osField}"`);
    }

    // Linux: split codename into name + version number
    // e.g. "ubuntu22" -> "ubuntu 22", "alma8" -> "almalinux 8", "rhel9" -> "redhat 9"
    const match = osCodename.match(/^([a-z]+)(\d+)$/);
    if (!match) {
        throw new Error(`Invalid os_codename for linux binary: "${osCodename}"`);
    }

    let name = match[1];
    const version = match[2];
    name = CODENAME_MAP[name] || name;
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

function extractArchive(archivePath, destDir, ext) {
    if (ext === '.tar.gz' || ext === '.tgz') {
        execSync(`tar xf "${archivePath}" -C "${destDir}"`, { stdio: 'pipe' });
    } else if (ext === '.zip') {
        execSync(`unzip -q -o "${archivePath}" -d "${destDir}"`, { stdio: 'pipe' });
    }
}

function repackArchive(archivePath, sourceDir, ext) {
    // Get the top-level entries to pack
    const entries = fs.readdirSync(sourceDir);
    if (ext === '.tar.gz' || ext === '.tgz') {
        const args = entries.map(e => `"${e}"`).join(' ');
        execSync(`tar czf "${archivePath}" ${args}`, { cwd: sourceDir, stdio: 'pipe' });
    } else if (ext === '.zip') {
        const args = entries.map(e => `"${e}"`).join(' ');
        execSync(`zip -qr "${archivePath}" ${args}`, { cwd: sourceDir, stdio: 'pipe' });
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
    const fields = [];

    if (entry.os) {
        fields.push(`OS: ${mapOs(entry.os, entry.os_codename || entry.os)}`);
    }
    if (entry.arch) {
        fields.push(`Arch: ${mapArch(entry.arch)}`);
    }
    if (entry.linked_to && typeof entry.linked_to === 'object' && Object.keys(entry.linked_to).length > 0) {
        fields.push(`LinkedTo: ${formatLinkedTo(entry.linked_to)}`);
    }

    return fields;
}

function stripManagedFields(content) {
    // Remove any existing OS/Arch/LinkedTo fields including continuation lines
    // (DESCRIPTION format: continuation lines start with whitespace)
    const lines = content.split('\n');
    const filtered = [];
    let skipping = false;
    for (const line of lines) {
        const fieldMatch = line.match(/^([A-Za-z]+):/);
        if (fieldMatch) {
            skipping = MANAGED_FIELDS.includes(fieldMatch[1]);
        } else if (!/^\s/.test(line)) {
            // Non-field, non-continuation line (e.g. blank line) — stop skipping
            skipping = false;
        }
        if (!skipping) filtered.push(line);
    }
    return filtered.join('\n');
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
    if (fields.length === 0) {
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

        let content = fs.readFileSync(descPath, 'utf8');
        content = stripManagedFields(content);
        // Ensure trailing newline before appending
        if (!content.endsWith('\n')) content += '\n';
        content += fields.join('\n') + '\n';
        fs.writeFileSync(descPath, content, 'utf8');

        // Re-archive, replacing the original
        fs.unlinkSync(archivePath);
        repackArchive(archivePath, tmpDir, ext);

        console.log(`  Modified ${filename}: set ${fields.map(f => f.split(':')[0]).join(', ')}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entries = Object.entries(manifest);
    console.log(`Processing ${entries.length} manifest entries...`);

    for (const [filename, entry] of entries) {
        if (entry.type !== 'binary') {
            console.log(`  Skipping ${filename}: type=${entry.type}`);
            continue;
        }
        processEntry(downloadDir, filename, entry);
    }

    // Remove manifest.json so it isn't uploaded
    fs.unlinkSync(manifestPath);
    console.log('Removed manifest.json from download directory');
}

main();
