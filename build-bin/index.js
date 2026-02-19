const core = require('@actions/core');
const fs = require('node:fs');
const path = require('path');
const { execSync } = require('node:child_process');

const FIELD_NAME_RE = /^([^:]+)/;

function getTarballs() {
    const items = fs.readdirSync('.');
    const files = items.filter(item => {
        return fs.statSync(item).isFile() && 
        (item.endsWith(".tar.gz")  || item.endsWith(".tgz") || item.endsWith(".zip"));
    });


    return new Set(files);
}

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

function addBinaryInfoToFilename(platformTag, archTag, rVersion) {
    const items = fs.readdirSync('.');
    const tarballName = items.find(item => {
        return fs.statSync(item).isFile() && 
        getExtension(item) !== '';
    });
    if (!tarballName) {
        throw Error(`No tarball found`);
    }
    const extension = getExtension(tarballName);
    const oldName = tarballName.substring(0, tarballName.indexOf(extension));
    const newName = `${oldName}_${platformTag}_${archTag}_${rVersion}${extension}`;
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

function buildPackageBinary(libraryPath, srcTarballPath) {
    let args = ['R', 'CMD', 'install', srcTarballPath, '--use-vanilla', '--strip', '--strip-lib', '--clean', '--build'];
    const originalCwd = process.cwd();
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
                "R_LIBS_SITE": libraryPath,
                "R_LIBS_USER": libraryPath,
            }
        });

        const { platformTag, archTag, rVersion } = getBuildTagParts();
        const filename = addBinaryInfoToFilename(platformTag, archTag, rVersion);
        const src = path.join(tmpDir, filename);
        const dest = path.join(originalCwd, filename);
        fs.renameSync(src, dest);
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
// We will a few things:
// 1. Update DESCRIPTION file to include metadata given, git sha
// 2. Run R CMD build . + some arguments depending on workflow params
try {
    const libraryPath = core.getInput('library');
    const srcTarballPath = core.getInput('src_tarball_path');

    console.log("Library:", libraryPath);
    console.log("Metadata:", metadata);

    const tarballs = getTarballs();
    buildPackageBinary(libraryPath, srcTarballPath);
    const updatedTarballs = getTarballs();
    const diff = new Set([...updatedTarballs].filter(x => !tarballs.has(x)));
    if (diff.size !== 1) {
        throw Error(`R CMD install created duplicate tarballs: ${diff}`);
    }
    const [tarballName] = [...diff];
    core.setOutput("binary_path", path.resolve(".", tarballName));
    core.setOutput("binary_name", tarballName);

} catch (error) {
    core.setFailed(error.message);
}