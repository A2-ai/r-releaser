const core = require('@actions/core');
const path = require('path');
const { parseDescriptionFile, writeManifest, parseLinkingTo } = require('../shared/manifest');
const { getTarballs, updateDescriptionFile, buildPackage, validateMetadata } = require('./lib');

// For now we assume the current directory is where the DESCRIPTION file is located
// We will a few things:
// 1. Update DESCRIPTION file to include metadata given, git sha
// 2. Run R CMD build . + some arguments depending on workflow params
try {
    const libraryPath = core.getInput('library');
    const metadata = JSON.parse(core.getInput('metadata'));
    if (!validateMetadata(metadata)) {
        throw Error("Metadata is not a valid object: it should only contain string/number/boolean values.");
    }
    metadata["GitOrigin"] = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
    metadata["GitSHA"] = process.env.GITHUB_SHA
    const buildVignettes = core.getInput('build-vignettes') === 'true';
    const resaveData = core.getInput('resave-data') === 'true';
    const md5 = core.getInput('md5') === 'true';
    const user = core.getInput('user') || undefined;

    console.log("Library:", libraryPath);
    console.log("Metadata:", metadata);
    console.log("Build vignettes:", buildVignettes);
    console.log("resave data:", resaveData);
    console.log("md5:", md5);
    console.log("user:", user);

    const tarballs = getTarballs();
    updateDescriptionFile(metadata);
    buildPackage(libraryPath, buildVignettes, resaveData, md5, user);
    const updatedTarballs = getTarballs();
    const diff = new Set([...updatedTarballs].filter(x => !tarballs.has(x)));
    if (diff.size === 0) {
        throw Error("R CMD build did not create a tarball");
    }
    if (diff.size > 1) {
        throw Error(`R CMD build created several tarballs: ${[...diff].join(', ')}`);
    }
    const [tarballName] = [...diff];
    core.setOutput("tarball_path", path.resolve(".", tarballName));
    core.setOutput("tarball_name", tarballName);

    // Generate manifest entry for source tarball
    const manifestPath = core.getInput('manifest_path') || 'manifest.json';
    const desc = parseDescriptionFile('DESCRIPTION');
    const needsCompilation = (desc['NeedsCompilation'] || 'no').toLowerCase() === 'yes';
    const linkingToDeps = parseLinkingTo(desc['LinkingTo']);

    const manifest = {
        [tarballName]: {
            package: desc['Package'],
            version: desc['Version'],
            type: 'source',
            needs_compilation: needsCompilation,
            ...metadata,
        },
    };
    writeManifest(manifestPath, manifest);
    core.setOutput("manifest_path", path.resolve(manifestPath));
    core.setOutput("linking_to_deps", JSON.stringify(linkingToDeps));

} catch (error) {
    core.setFailed(error.message);
}
