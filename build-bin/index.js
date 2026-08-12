const core = require('@actions/core');
const path = require('path');
const { updateManifest } = require('../shared/manifest');
const { decomposePlatformTag, resolveLinkedTo, buildPackageBinary, verifyPortability, applyPortabilityPolicy, readTarballDescription } = require('./lib');

// For now we assume the current directory is where the DESCRIPTION file is located
// TO reapproach description modding later
try {
    const libraryPath = core.getInput('library');
    const srcTarballPath = core.getInput('src_tarball_path');

    console.log("Library:", libraryPath);
    console.log("Src tarball path:", srcTarballPath);

    const { pkgName, pkgVersion } = readTarballDescription(srcTarballPath);

    const { filename, platformTag, archTag, rVersion } = buildPackageBinary(libraryPath, srcTarballPath, pkgName, pkgVersion);
    core.setOutput("binary_path", path.resolve(".", filename));
    core.setOutput("binary_name", filename);

    // Generate manifest entry for binary
    const manifestPath = core.getInput('manifest_path') || 'manifest.json';
    const linkingToDeps = JSON.parse(core.getInput('linking_to_deps') || '[]');
    const includeBuiltinLinkingToDeps = core.getInput('include_builtin_linking_to_deps') === 'true';

    const linkedTo = resolveLinkedTo(linkingToDeps, libraryPath, includeBuiltinLinkingToDeps);

    const { os, os_codename } = decomposePlatformTag(platformTag);

    const { fields: portabilityFields, warning, notice } = applyPortabilityPolicy({
        claimed: core.getInput('no_sys_deps') === 'true',
        platform: process.platform,
        platformTag,
        pkgName,
        verify: () => verifyPortability(path.resolve(libraryPath), pkgName),
    });
    if (warning) core.warning(warning);
    if (notice) core.notice(notice);

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
            ...portabilityFields,
        },
    };
    updateManifest(manifestPath, manifest);
    core.setOutput("manifest_path", path.resolve(manifestPath));

} catch (error) {
    core.setFailed(error.message);
}
