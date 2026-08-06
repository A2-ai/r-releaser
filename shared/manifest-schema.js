// Dependency-free runtime validation of the manifest format documented in
// shared/schemas/manifest.schema.json — keep the two in sync. No third-party
// validator here because deploy-prism runs this without an npm install.

const SCALAR_TYPES = new Set(['string', 'number', 'boolean']);

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(entry, key, filename, errors) {
    if (typeof entry[key] !== 'string' || entry[key].length === 0) {
        errors.push(`${filename}: "${key}" must be a non-empty string`);
    }
}

function validateEntry(filename, entry, errors) {
    if (!isPlainObject(entry)) {
        errors.push(`${filename}: entry must be an object`);
        return;
    }

    requireString(entry, 'package', filename, errors);
    requireString(entry, 'version', filename, errors);

    if (entry.type === 'source') {
        if (typeof entry.needs_compilation !== 'boolean') {
            errors.push(`${filename}: "needs_compilation" must be a boolean`);
        }
        for (const [key, value] of Object.entries(entry)) {
            if (key === 'needs_compilation') continue;
            if (!SCALAR_TYPES.has(typeof value)) {
                errors.push(`${filename}: metadata field "${key}" must be a string/number/boolean`);
            }
        }
    } else if (entry.type === 'binary') {
        for (const key of ['os', 'os_codename', 'arch', 'r_version']) {
            requireString(entry, key, filename, errors);
        }
        if (!isPlainObject(entry.linked_to)) {
            errors.push(`${filename}: "linked_to" must be an object`);
        } else {
            for (const [dep, version] of Object.entries(entry.linked_to)) {
                if (typeof version !== 'string') {
                    errors.push(`${filename}: linked_to["${dep}"] must be a string`);
                }
            }
        }
        if ('no_sys_deps' in entry && typeof entry.no_sys_deps !== 'boolean') {
            errors.push(`${filename}: "no_sys_deps" must be a boolean`);
        }
        if ('glibc_max' in entry && (typeof entry.glibc_max !== 'string' || !/^\d+\.\d+(\.\d+)?$/.test(entry.glibc_max))) {
            errors.push(`${filename}: "glibc_max" must be a version string like "2.28"`);
        }
    } else {
        errors.push(`${filename}: "type" must be "source" or "binary" (got ${JSON.stringify(entry.type)})`);
    }
}

// Returns a list of human-readable problems; empty means valid.
function validateManifest(manifest) {
    if (!isPlainObject(manifest)) {
        return ['manifest must be a JSON object keyed by artifact filename'];
    }
    const errors = [];
    for (const [filename, entry] of Object.entries(manifest)) {
        validateEntry(filename, entry, errors);
    }
    return errors;
}

module.exports = { validateManifest };
