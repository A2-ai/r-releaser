const core = require('@actions/core');
const fs = require('node:fs');
const path = require('path');
const { execSync } = require('node:child_process');

const FIELD_NAME_RE = /^([^:]+)/;

function getTarballs() {
    const items = fs.readdirSync('.');
    const files = items.filter(item => {
        return fs.statSync(item).isFile() && item.endsWith(".tar.gz");
    });


    return new Set(files);
}

function updateDescriptionFile(metadata) {
    const content = fs.readFileSync('DESCRIPTION', 'utf8');
    let fields = [];

    const lines = content.split('\n');
    let currentField = ""
    for (const line of lines) {
        // Whitespace -> continuing the field
        if (/^\s/.test(line)) {
            currentField += line;
        } else {
            // Otherwise a new field
            // Push previous one first
            if (currentField) {
                fields.push(currentField);
            }
            currentField = line;
        }
    }

    if (currentField) {
        fields.push(currentField);
    }

    // Then we rebuild the file, updating with our metadata if needed
    let updatedContent = "";
    let metadataAdded = [];
    for (const field of fields) {
        let fieldName = field.match(FIELD_NAME_RE)[0];
        // Skip remotes
        if (fieldName.toLowerCase() === "remotes") {
            continue;
        }
        const key = Object.keys(metadata).find(k => k.toLowerCase() === fieldName.toLowerCase());
        if (key !== undefined) {
            updatedContent += `${fieldName}: ${metadata[key]}\n`;
            metadataAdded.push(key);
        } else {
            updatedContent += field + '\n';
        }
    }

    for (const [key, value] of Object.entries(metadata)) {
        if (metadataAdded.includes(key)) {
            continue;
        }
        updatedContent += `${key}: ${value}\n`;
    }

    fs.writeFileSync('DESCRIPTION', updatedContent);

    return updatedContent;
}

function buildPackage(libraryPath, buildVignettes, resaveData, md5, user) {
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

    console.log(`Running "${args.join(" ")}" and using ${libraryPath} as library`);

    try {
        execSync(args.join(" "), {
            // Capture stdout and stderr from child process. Overrides the
            // default behavior of streaming child stderr to the parent stderr
            stdio: 'pipe',
            env: {
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
    console.log("md5:", resaveData);
    console.log("user:", user);

    const tarballs = getTarballs();
    updateDescriptionFile(metadata);
    buildPackage(libraryPath, buildVignettes, resaveData, md5);
    const updatedTarballs = getTarballs();
    const diff = new Set([...updatedTarballs].filter(x => !tarballs.has(x)));
    if (diff.size !== 1) {
        throw Error(`R CMD build created several tarballs: ${diff}`);
    }
    const [tarballName] = [...diff];
    core.setOutput("tarball_path", path.resolve(".", tarballName));
    core.setOutput("tarball_name", tarballName);

} catch (error) {
    core.setFailed(error.message);
}