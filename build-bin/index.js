const core = require('@actions/core');
const fs = require('node:fs');
const path = require('path');
const { execSync } = require('node:child_process');
const { parseDescriptionFile, writeManifest } = require('../shared/manifest');
const builtinPackages = require('./builtin_packages.json');

const FIELD_NAME_RE = /^([^:]+)/;

function getExtension(fileName) {
    let found = '';
    for (const ext of ['.tar.gz', '.tgz', '.zip']) {
        if (fileName.endsWith(ext)) {
            found = ext;
            break;
        }
    }
    return found;
}

function renameBinaryArchive(pkgName, pkgVersion, platformTag, archTag, rVersion) {
    const items = fs.readdirSync('.');
    const tarballName = items.find(item => {
        return fs.statSync(item).isFile() &&
        getExtension(item) !== '';
    });
    if (!tarballName) {
        throw Error(`No tarball found`);
    }
    const ext = getExtension(tarballName);
    const newName = `${pkgName}_${pkgVersion}_${platformTag}_${archTag}_${rVersion}${ext}`;
    fs.renameSync(tarballName, newName);
    return newName;
}

function parseOsRelease() {
    try {
        const txt = fs.readFileSync('/etc/os-release', 'utf8');
        const out = {};
        for (const line of txt.split('\n')) {
            if (!line || line.startsWith('#') || !line.includes('=')) continue;
            const idx = line.indexOf('=');
            const key = line.slice(0, idx);
            const value = line.slice(idx + 1).replace(/^"|"$/g, '');
            out[key] = value;
        }
        return out;
    } catch {
        return {};
    }
}

function getPlatformTag() {
    if (process.platform === 'linux') {
        const rel = parseOsRelease();
        const id = (rel.ID || 'linux').toLowerCase();
        const major = (rel.VERSION_ID || '0').split('.')[0];
        return `linux_${id}${major}`; // e.g. linux_ubuntu22, linux_rhel9, linux_alma8
    }
    if (process.platform === 'darwin') {
        return `macos`;
    }
    if (process.platform === 'win32') {
        return `windows`;
    }

    return process.platform;
}

function getRMinorVersion() {
    // e.g. 4.4.1 -> 4.4
    const full = execSync('Rscript -e "cat(as.character(getRversion()))"', { encoding: 'utf8' }).trim();
    const parts = full.split('.');
    return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : full;
}

function getBuildTagParts() {
    return {
        platformTag: getPlatformTag(), // linux_ubuntu22 / macos14 / windows11
        archTag: process.arch,
        rVersion: getRMinorVersion(),
    };
}

function decomposePlatformTag(platformTag) {
    const match = platformTag.match(/^([^_]+)_(.+)$/);
    if (match) {
        return { os: match[1], os_codename: match[2] };
    }
    return { os: platformTag, os_codename: platformTag };
}

function buildPackageBinary(libraryDir, srcTarballPath, pkgName, pkgVersion) {
    const originalCwd = process.cwd();
    const libraryPath = path.resolve(originalCwd, libraryDir);
    let args = ['R', 'CMD', 'INSTALL', '-l', libraryPath, srcTarballPath, '--use-vanilla', '--strip', '--strip-lib', '--clean', '--build'];
    const tmpDir = path.join(originalCwd, 'tmp_output');

    console.log(`Running "${args.join(" ")}" and using ${libraryPath} as library`);

    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        process.chdir(tmpDir);
        execSync(args.join(" "), {
            // Capture stdout and stderr from child process. Overrides the
            // default behavior of streaming child stderr to the parent stderr
            stdio: 'pipe',
            env: {
                ...process.env,
                "R_LIBS_SITE": libraryPath,
                "R_LIBS_USER": libraryPath,
            }
        });

        const { platformTag, archTag, rVersion } = getBuildTagParts();
        const filename = renameBinaryArchive(pkgName, pkgVersion, platformTag, archTag, rVersion);
        const src = path.join(tmpDir, filename);
        const dest = path.join(originalCwd, filename);
        fs.renameSync(src, dest);
        return { filename, platformTag, archTag, rVersion };
    } catch (err) {
        if (err.code) {
            // Spawning child process failed
            console.error(err.code);
            throw Error("Failed to start build.");
        } else {
            // Child was spawned but exited with non-zero exit code
            // Error contains any stdout and stderr from the child
            const { stdout, stderr } = err;
            console.log(err);
            throw Error(`Failed to build package:\nstdout:\n${stdout}\nstderr:${stderr}`);
        }
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// We want a non null object where the values can only be string/number/boolea
function validateMetadata(obj) {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        return false;
    }

    return Object.values(obj).every(value => {
        const type = typeof value;
        return type === 'string' || type === 'number' || type === 'boolean';
    });
}

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
    const resolvedLibraryPath = path.resolve(libraryPath);

    // Resolve versions for each LinkingTo dep from the local library
    const linkedTo = {};
    for (const dep of linkingToDeps) {
        if (includeBuiltinLinkingToDeps && builtinPackages.includes(dep)) {
            continue;
        }
        try {
            const depDescPath = path.join(resolvedLibraryPath, dep, 'DESCRIPTION');
            const depDesc = parseDescriptionFile(depDescPath);
            linkedTo[dep] = depDesc['Version'] || 'unknown';
        } catch (err) {
            console.warn(`Warning: could not read DESCRIPTION for LinkingTo dep "${dep}": ${err.message}`);
            linkedTo[dep] = 'unknown';
        }
    }

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
    writeManifest(manifestPath, manifest);
    core.setOutput("manifest_path", path.resolve(manifestPath));

} catch (error) {
    core.setFailed(error.message);
}