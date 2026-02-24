const core = require('@actions/core');
const artifact = require('@actions/artifact');
const fs = require('node:fs');
const path = require('path');
const { writeManifest } = require('../shared/manifest');

async function run() {
    const pattern = core.getInput('artifact_pattern') || 'manifest-*';
    const client = new artifact.DefaultArtifactClient();

    // Find all matching artifacts
    const { artifacts } = await client.listArtifacts({ latest: true });
    const matched = artifacts.filter(a => {
        return matchGlob(pattern, a.name);
    });

    if (matched.length === 0) {
        throw new Error(`No artifacts matched pattern "${pattern}"`);
    }

    console.log(`Found ${matched.length} manifest artifacts: ${matched.map(a => a.name).join(', ')}`);

    // Download and merge
    const merged = {};
    const tmpDir = path.join(process.cwd(), '_manifests');
    fs.mkdirSync(tmpDir, { recursive: true });

    for (const art of matched) {
        const downloadDir = path.join(tmpDir, art.name);
        await client.downloadArtifact(art.id, { path: downloadDir });
        const manifestFile = path.join(downloadDir, 'manifest.json');
        if (!fs.existsSync(manifestFile)) {
            console.warn(`Warning: ${art.name} has no manifest.json, skipping`);
            continue;
        }
        const data = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        Object.assign(merged, data);
        console.log(`Merged ${Object.keys(data).length} entry/entries from ${art.name}`);
    }

    // Write merged manifest
    const outputPath = 'manifest.json';
    writeManifest(outputPath, merged);
    console.log(`Wrote merged manifest with ${Object.keys(merged).length} entries`);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

    core.setOutput('manifest_path', path.resolve(outputPath));
}

function matchGlob(pattern, name) {
    const regex = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    );
    return regex.test(name);
}

run().catch(err => core.setFailed(err.message));
