const core = require('@actions/core');
const fs = require('node:fs');
const path = require('path');
const { writeManifest } = require('../shared/manifest');

function findManifests(dir, glob) {
    const results = [];
    // Convert glob to regex: **/manifest.json -> match manifest.json at any depth
    const pattern = new RegExp(
        '^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '{{GLOBSTAR}}').replace(/\*/g, '[^/]*').replace(/\{\{GLOBSTAR\}\}/g, '.*') + '$'
    );

    function walk(currentDir) {
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const full = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                const rel = path.relative(dir, full);
                if (pattern.test(rel)) {
                    results.push(full);
                }
            }
        }
    }

    walk(dir);
    return results;
}

try {
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const manifestDirInput = core.getInput('manifest_dir') || 'manifests';
    const manifestGlob = core.getInput('manifest_glob') || '**/manifest.json';
    const manifestDir = path.resolve(workspace, manifestDirInput);

    console.log(`Workspace: ${workspace}`);
    console.log(`Manifest directory: ${manifestDir}`);

    if (!fs.existsSync(manifestDir)) {
        throw new Error(`Manifest directory "${manifestDir}" does not exist`);
    }

    const files = findManifests(manifestDir, manifestGlob);
    if (files.length === 0) {
        throw new Error(`No files matched "${manifestGlob}" in "${manifestDir}"`);
    }

    console.log(`Found ${files.length} manifest file(s):`);

    const merged = {};
    for (const file of files) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const count = Object.keys(data).length;
        console.log(`  ${file} (${count} entry/entries)`);
        Object.assign(merged, data);
    }

    const outputPath = path.resolve(workspace, 'manifest.json');
    writeManifest(outputPath, merged);
    console.log(`Wrote merged manifest with ${Object.keys(merged).length} entries`);

    core.setOutput('manifest_path', outputPath);
} catch (error) {
    core.setFailed(error.message);
}
