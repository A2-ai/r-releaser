const FIELD_START_RE = /^([^\s:][^:]*):/;

// Parses DCF content into an ordered list of fields, preserving each field's
// original lines verbatim so untouched fields survive a rewrite byte-for-byte.
// Lines that start neither a field nor a continuation (e.g. blanks) become
// entries with name null.
function parseFields(content) {
    const lines = content.split('\n');
    if (lines.length && lines[lines.length - 1] === '') {
        lines.pop();
    }
    const fields = [];
    let current = null;
    for (const line of lines) {
        if (/^\s/.test(line) && current) {
            current.rawLines.push(line);
            continue;
        }
        const match = line.match(FIELD_START_RE);
        if (match) {
            current = { name: match[1].trim(), rawLines: [line] };
            fields.push(current);
        } else {
            current = null;
            fields.push({ name: null, rawLines: [line] });
        }
    }
    return fields;
}

function fieldValue(field) {
    if (field.name === null) {
        return null;
    }
    const first = field.rawLines[0];
    const rest = first.slice(first.indexOf(':') + 1);
    return [rest, ...field.rawLines.slice(1)].join('\n').trim();
}

function parseDescription(content) {
    const result = {};
    for (const field of parseFields(content)) {
        if (field.name !== null) {
            result[field.name] = fieldValue(field);
        }
    }
    return result;
}

// Returns new DCF content with fields in `set` replaced (or appended when
// absent) and fields in `remove` dropped. Name matching is case-insensitive;
// a replaced field keeps its position and original name casing. All other
// fields, including multi-line ones, are preserved verbatim.
function updateDescription(content, { set = {}, remove = [] } = {}) {
    const removeLower = remove.map(name => name.toLowerCase());
    const setKeys = Object.keys(set);
    const applied = new Set();
    const out = [];
    for (const field of parseFields(content)) {
        if (field.name === null) {
            out.push(field.rawLines.join('\n'));
            continue;
        }
        const lower = field.name.toLowerCase();
        if (removeLower.includes(lower)) {
            continue;
        }
        const key = setKeys.find(k => k.toLowerCase() === lower);
        if (key !== undefined) {
            out.push(`${field.name}: ${set[key]}`);
            applied.add(key);
        } else {
            out.push(field.rawLines.join('\n'));
        }
    }
    for (const key of setKeys) {
        if (!applied.has(key)) {
            out.push(`${key}: ${set[key]}`);
        }
    }
    return out.join('\n') + '\n';
}

module.exports = { parseFields, fieldValue, parseDescription, updateDescription };
