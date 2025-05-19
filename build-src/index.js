const core = require('@actions/core');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const FIELD_NAME_RE = /^([^:]+)/;

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

function buildPackage(libraryPath, buildVignettes, resaveData, md5) {
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

    console.log(`Running ${args.join(" ")}`);

    try {
        const stdout = execSync(args.join(" "), {
            // Capture stdout and stderr from child process. Overrides the
            // default behavior of streaming child stderr to the parent stderr
            stdio: 'pipe',
            env: {
                "R_LIBS_SITE": libraryPath,
                "R_LIBS_USER": libraryPath,
            }
        });
        console.log("sucess", stdout);
    } catch (err) {
        if (err.code) {
            // Spawning child process failed
            console.error(err.code);
            throw Error("Failed to start build.");
        } else {
            // Child was spawned but exited with non-zero exit code
            // Error contains any stdout and stderr from the child
            const { stdout, stderr } = err;
            throw Error(`Failed to build package:\nstdout:\n${stdout}\nstderr:${stderr}`);
        }
    }
}

// For now we assume the current directory is where the DESCRIPTION file is located
// We will a few things:
// 1. Update DESCRIPTION file to include metadata given, git sha
// 2. Run R CMD build . + some arguments depending on workflow params
try {
    const libraryPath = core.getInput('library');
    const metadata = JSON.parse(core.getInput('metadata'));
    metadata["SHA"] = process.env.GITHUB_SHA
    const buildVignettes = core.getInput('build-vignettes') === 'true';
    const resaveData = core.getInput('resave-data') === 'true';
    const md5 = core.getInput('md5') === 'true';

    updateDescriptionFile(metadata);
    buildPackage(libraryPath, buildVignettes, resaveData, md5);
} catch (error) {
    core.setFailed(error.message);
}