const fs = require('node:fs');
const { parseDescription } = require('./description');

function parseDescriptionFile(filePath) {
    return parseDescription(fs.readFileSync(filePath, 'utf8'));
}

function writeManifest(manifestPath, manifest) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

// Merges entries into an existing manifest file rather than replacing it, so
// actions writing to the same manifest_path cannot drop each other's entries.
function updateManifest(manifestPath, entries) {
    let existing = {};
    if (fs.existsSync(manifestPath)) {
        existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
    const merged = { ...existing, ...entries };
    writeManifest(manifestPath, merged);
    return merged;
}

function parseLinkingTo(value) {
    if (!value) return [];
    return value.split(',').map(dep => dep.trim().replace(/\s*\(.*\)/, ''));
}

module.exports = { parseDescriptionFile, writeManifest, updateManifest, parseLinkingTo };
