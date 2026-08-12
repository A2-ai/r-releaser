const core = require('@actions/core');
const fs = require('node:fs');
const path = require('path');
const { parseDescriptionFile, updateManifest } = require('../shared/manifest');
const { defaultAssetName, buildSite, tarDocs, checkTarballSize } = require('./lib');

// Builds the package's pkgdown site and packs it into a tarball that
// deploy-prism posts to PRISM's docs endpoint.
try {
    const libraryPath = core.getInput('library');
    const workingDir = core.getInput('working_dir') || '.';
    const repoUrl = core.getInput('repo_url');
    const manifestPath = core.getInput('manifest_path') || 'manifest.json';

    const desc = parseDescriptionFile(path.join(workingDir, 'DESCRIPTION'));
    const pkgName = desc['Package'];
    const pkgVersion = desc['Version'];
    const assetName = core.getInput('asset_name') || defaultAssetName(pkgName, pkgVersion);

    console.log("Library:", libraryPath);
    console.log("Working directory:", workingDir);
    console.log("Repo URL:", repoUrl);
    console.log("Package:", `${pkgName} ${pkgVersion}`);
    console.log("Asset name:", assetName);

    buildSite(pkgName, pkgVersion, workingDir, libraryPath, repoUrl);

    const docsDir = path.join(workingDir, 'docs');
    if (!fs.existsSync(docsDir)) {
        throw Error(`pkgdown did not produce a docs directory at ${docsDir}`);
    }

    const tarballPath = path.resolve(assetName);
    tarDocs(docsDir, tarballPath);
    const size = checkTarballSize(tarballPath);
    console.log(`Wrote ${assetName} (${size} bytes)`);

    core.setOutput("docs_tarball_path", tarballPath);
    core.setOutput("docs_tarball_name", assetName);

    // Merged rather than written so this composes with a source or binary entry
    // already at manifest_path.
    updateManifest(manifestPath, {
        [assetName]: {
            package: pkgName,
            version: pkgVersion,
            type: 'docs',
        },
    });
    core.setOutput("manifest_path", path.resolve(manifestPath));

} catch (error) {
    core.setFailed(error.message);
}
