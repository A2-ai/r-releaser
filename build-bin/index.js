const core = require('@actions/core');
const path = require('path');
const { updateManifest } = require('../shared/manifest');
const { decomposePlatformTag, resolveLinkedTo, buildPackageBinary } = require('./lib');

// For now we assume the current directory is where the DESCRIPTION file is located
// TO reapproach description modding later
try {
    const libraryPath = core.getInput('library');
    const srcTarballPath = core.getInput('src_tarball_path');

    console.log("Library:", libraryPath);
    console.log("Src tarball path:", srcTarballPath);

    // Extract package name/version from source tarball filename
    const srcTarballName = path.basename(srcTarballPath);
    const srcMatch = srcTarballName.match(/^(.+?)_(.+?)\.tar\.gz$/);
    const pkgName = srcMatch ? srcMatch[1] : srcTarballName;
    const pkgVersion = srcMatch ? srcMatch[2] : 'unknown';

    const { filename, platformTag, archTag, rVersion } = buildPackageBinary(libraryPath, srcTarballPath, pkgName, pkgVersion);
    core.setOutput("binary_path", path.resolve(".", filename));
    core.setOutput("binary_name", filename);

    // Generate manifest entry for binary
    const manifestPath = core.getInput('manifest_path') || 'manifest.json';
    const linkingToDeps = JSON.parse(core.getInput('linking_to_deps') || '[]');
    const includeBuiltinLinkingToDeps = core.getInput('include_builtin_linking_to_deps') === 'true';

    const linkedTo = resolveLinkedTo(linkingToDeps, libraryPath, includeBuiltinLinkingToDeps);

    const { os, os_codename } = decomposePlatformTag(platformTag);

    const manifest = {
        [filename]: {
            package: pkgName,
            version: pkgVersion,
            type: 'binary',
            os,
            os_codename,
            arch: archTag,
            r_version: rVersion,
            linked_to: linkedTo,
        },
    };
    updateManifest(manifestPath, manifest);
    core.setOutput("manifest_path", path.resolve(manifestPath));

} catch (error) {
    core.setFailed(error.message);
}
