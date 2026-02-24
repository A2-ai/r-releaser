const fs = require('node:fs');

function parseDescriptionFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const result = {};
    const lines = content.split('\n');
    let currentKey = null;
    let currentValue = '';

    for (const line of lines) {
        if (/^\s/.test(line) && currentKey) {
            currentValue += '\n' + line;
        } else {
            if (currentKey) {
                result[currentKey] = currentValue.trim();
            }
            const match = line.match(/^([^:]+):\s*(.*)/);
            if (match) {
                currentKey = match[1].trim();
                currentValue = match[2];
            } else {
                currentKey = null;
                currentValue = '';
            }
        }
    }
    if (currentKey) {
        result[currentKey] = currentValue.trim();
    }
    return result;
}

function writeManifest(manifestPath, manifest) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

function parseLinkingTo(value) {
    if (!value) return [];
    return value.split(',').map(dep => dep.trim().replace(/\s*\(.*\)/, ''));
}

module.exports = { parseDescriptionFile, writeManifest, parseLinkingTo };
