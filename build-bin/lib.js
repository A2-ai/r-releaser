const fs = require('node:fs');
const path = require('path');
const { execSync, execFileSync } = require('node:child_process');
const { parseDescriptionFile } = require('../shared/manifest');
const { parseDescription } = require('../shared/description');
const builtinPackages = require('./builtin_packages.json');
const { linux_id_map: LINUX_ID_MAP } = require('../shared/platforms.json');

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

// The tarball's own DESCRIPTION is the authority for name/version: R CMD
// INSTALL installs under the DESCRIPTION Package name regardless of what the
// tarball file is called, so filename-derived names break on renamed tarballs.
function readTarballDescription(srcTarballPath) {
    // Node's default 1 MiB maxBuffer overflows on listings of large packages.
    const tarOpts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
    const entries = execFileSync('tar', ['-tzf', srcTarballPath], tarOpts).split('\n');
    const descEntry = entries.map(e => e.trim()).find(e => /^(\.\/)?[^/]+\/DESCRIPTION$/.test(e));
    if (!descEntry) {
        throw Error(`No top-level DESCRIPTION found in ${srcTarballPath}`);
    }
    const content = execFileSync('tar', ['-xzOf', srcTarballPath, descEntry], tarOpts);
    const desc = parseDescription(content);
    if (!desc['Package'] || !desc['Version']) {
        throw Error(`DESCRIPTION in ${srcTarballPath} lacks Package or Version`);
    }
    return { pkgName: desc['Package'], pkgVersion: desc['Version'] };
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
        // Fail at build time rather than letting deploy-prism reject the
        // binary at release time — both sides read shared/platforms.json.
        if (!(id in LINUX_ID_MAP)) {
            throw Error(`Unsupported linux distro "${id}" (from /etc/os-release) — add it to shared/platforms.json`);
        }
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

const PORTABLE_RUNTIME_LIBS = new Set(require('./portable_runtime_libs.json').sonames);
const LD_LINUX_RE = /^ld-linux-[^/]*\.so(\.\d+)?$/;

function isPortableRuntimeLib(soname) {
    return PORTABLE_RUNTIME_LIBS.has(soname) || LD_LINUX_RE.test(soname);
}

function parseNeededLibs(readelfOutput) {
    return [...readelfOutput.matchAll(/\(NEEDED\)\s+Shared library:\s+\[([^\]]+)\]/g)]
        .map(match => match[1]);
}

function parseGlibcVersions(readelfOutput) {
    return [...readelfOutput.matchAll(/\bGLIBC_(\d+\.\d+(?:\.\d+)?)\b/g)]
        .map(match => match[1]);
}

function compareVersions(a, b) {
    const as = a.split('.').map(Number);
    const bs = b.split('.').map(Number);
    for (let i = 0; i < Math.max(as.length, bs.length); i++) {
        const diff = (as[i] || 0) - (bs[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function execReadelf(soPath) {
    // LC_ALL=C: the parsers below match readelf's English output.
    return execFileSync('readelf', ['-dV', soPath], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, LC_ALL: 'C' },
    });
}

const SO_FILE_RE = /\.so(\.\d+)*$/;

// Static DT_NEEDED read of every shared object in the installed package;
// throws when verification cannot run (readelf missing/erroring, no dynamic
// section). Walks the whole install tree, not just libs/: packages ship
// versioned objects via inst/ (e.g. lib/libtbb.so.2, jri/libjri.so), and a
// missed object would let a false no_sys_deps claim through.
function verifyPortability(libraryPath, pkgName, runReadelf = execReadelf) {
    const pkgDir = path.join(libraryPath, pkgName);
    if (!fs.existsSync(pkgDir)) {
        throw Error(`Installed package not found at ${pkgDir} — cannot verify portability`);
    }
    const soFiles = fs.readdirSync(pkgDir, { recursive: true })
        .map(String)
        .filter(f => SO_FILE_RE.test(f) && fs.statSync(path.join(pkgDir, f)).isFile());

    const violations = [];
    let glibcMax = null;
    for (const so of soFiles) {
        const output = runReadelf(path.join(pkgDir, so));
        if (!output.includes('Dynamic section')) {
            throw Error(`readelf output for ${so} contains no dynamic section`);
        }
        const offending = parseNeededLibs(output).filter(lib => !isPortableRuntimeLib(lib));
        if (offending.length > 0) {
            violations.push({ so, libs: offending });
        }
        for (const version of parseGlibcVersions(output)) {
            if (glibcMax === null || compareVersions(version, glibcMax) > 0) {
                glibcMax = version;
            }
        }
    }
    return { noSysDeps: violations.length === 0, violations, glibcMax };
}

// Turns the claim plus a verification attempt into manifest fields and
// messages, per the outcome table in docs/portability-contract.md. Throws
// exactly when the claim must fail the build.
function applyPortabilityPolicy({ claimed, platform, platformTag, pkgName, verify }) {
    if (platform !== 'linux') {
        return {
            fields: {},
            warning: claimed ? `no_sys_deps applies only to linux binaries; ignoring for ${platformTag}` : null,
            notice: null,
        };
    }

    let result;
    try {
        result = verify();
    } catch (err) {
        if (claimed) {
            throw Error(`no_sys_deps was claimed but could not be verified: ${err.message}`);
        }
        return { fields: {}, warning: `portability verification could not run: ${err.message}`, notice: null };
    }

    if (!result.noSysDeps && claimed) {
        const details = result.violations
            .map(v => `${v.so}: ${v.libs.join(', ')}`)
            .join('; ');
        throw Error(`no_sys_deps was claimed but ${pkgName} links system libraries — ${details} (see https://github.com/A2-ai/r-releaser/blob/main/docs/portability-contract.md)`);
    }

    const fields = { no_sys_deps: result.noSysDeps };
    if (result.glibcMax !== null) {
        fields.glibc_max = result.glibcMax;
    }
    const notice = result.noSysDeps
        ? (claimed
            ? `no_sys_deps verified for ${pkgName}${result.glibcMax ? ` (glibc_max ${result.glibcMax})` : ''}`
            : `${pkgName} links only portable runtime libraries — eligible for no_sys_deps (see https://github.com/A2-ai/r-releaser/blob/main/docs/portability-contract.md)`)
        : null;
    return { fields, warning: null, notice };
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
    readTarballDescription,
    renameBinaryArchive,
    parseOsRelease,
    getPlatformTag,
    getRMinorVersion,
    getBuildTagParts,
    decomposePlatformTag,
    resolveLinkedTo,
    isPortableRuntimeLib,
    parseNeededLibs,
    parseGlibcVersions,
    compareVersions,
    verifyPortability,
    applyPortabilityPolicy,
    buildPackageBinary,
};
