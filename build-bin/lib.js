const fs = require('node:fs');
const path = require('path');
const { execSync } = require('node:child_process');
const { parseDescriptionFile } = require('../shared/manifest');
const builtinPackages = require('./builtin_packages.json');

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
        platformTag: getPlatformTag(), // e.g. linux_ubuntu22 / macos / windows
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

// Resolves each LinkingTo dep's version from its installed DESCRIPTION.
// Builtin (base/recommended) packages are excluded unless opted in.
function resolveLinkedTo(linkingToDeps, libraryPath, includeBuiltinLinkingToDeps) {
    const resolvedLibraryPath = path.resolve(libraryPath);
    const linkedTo = {};
    for (const dep of linkingToDeps) {
        if (!includeBuiltinLinkingToDeps && builtinPackages.includes(dep)) {
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
    return linkedTo;
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

module.exports = {
    getExtension,
    renameBinaryArchive,
    parseOsRelease,
    getPlatformTag,
    getRMinorVersion,
    getBuildTagParts,
    decomposePlatformTag,
    resolveLinkedTo,
    buildPackageBinary,
};
