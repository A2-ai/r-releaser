const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { updateDescription } = require('../shared/description');

function getTarballs() {
    const items = fs.readdirSync('.');
    const files = items.filter(item => {
        return fs.statSync(item).isFile() && item.endsWith(".tar.gz");
    });

    return new Set(files);
}

function updateDescriptionFile(metadata) {
    const content = fs.readFileSync('DESCRIPTION', 'utf8');
    const updatedContent = updateDescription(content, { set: metadata, remove: ['Remotes'] });
    fs.writeFileSync('DESCRIPTION', updatedContent);

    return updatedContent;
}

function buildArgs(buildVignettes, resaveData, md5, user) {
    let args = ['R', 'CMD', 'build', '.'];
    if (!buildVignettes) {
        args.push("--no-build-vignettes");
    }
    if (!resaveData) {
        args.push("--no-resave-data");
    }
    if (md5) {
        args.push("--md5")
    }
    if (user) {
        args.push(`--user=${user}`)
    }
    return args;
}

function buildPackage(libraryPath, buildVignettes, resaveData, md5, user) {
    const args = buildArgs(buildVignettes, resaveData, md5, user);

    console.log(`Running "${args.join(" ")}" and using ${libraryPath} as library`);

    try {
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
    }
}

// We want a non null object where the values can only be string/number/boolean
function validateMetadata(obj) {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        return false;
    }

    return Object.values(obj).every(value => {
        const type = typeof value;
        return type === 'string' || type === 'number' || type === 'boolean';
    });
}

module.exports = { getTarballs, updateDescriptionFile, buildArgs, buildPackage, validateMetadata };
