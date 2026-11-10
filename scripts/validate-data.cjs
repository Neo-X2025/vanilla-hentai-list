const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const categories = ['vanilla', 'neutral', 'avoid'];

function validateEntries(entries, source, seen = new Set()) {
    if (!Array.isArray(entries)) return [`${source}: expected an array`];
    const errors = [];
    entries.forEach((entry, index) => {
        const at = `${source}: entry ${index + 1}`;
        if (!Array.isArray(entry) || entry.length !== 4) { errors.push(`${at}: expected [title, note, tags, score]`); return; }
        const [title, note, tags, score] = entry;
        if (typeof title !== 'string' || !title.trim()) errors.push(`${at}: title must be a nonempty string`);
        else {
            const key = title.normalize('NFKC').trim().toLowerCase();
            if (seen.has(key)) errors.push(`${at}: duplicate title`);
            seen.add(key);
        }
        if (typeof note !== 'string') errors.push(`${at}: note must be a string`);
        if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.trim()) || new Set(tags).size !== tags.length) {
            errors.push(`${at}: tags must be unique nonempty strings`);
        }
        if (!Number.isInteger(score) || score < 1 || score > 10) errors.push(`${at}: score must be an integer from 1 through 10`);
    });
    return errors;
}

function validateCatalogue(directory = path.resolve(__dirname, '..')) {
    const errors = [];
    const seen = new Set();
    let count = 0;
    for (const category of categories) {
        const source = `data-${category}.js`;
        try {
            const code = fs.readFileSync(path.join(directory, source), 'utf8');
            const entries = vm.runInNewContext(`${code}\n;${category}Entries;`, {}, { timeout: 1000, filename: source });
            errors.push(...validateEntries(entries, source, seen));
            if (Array.isArray(entries)) count += entries.length;
        } catch (error) {
            errors.push(`${source}: ${error.message}`);
        }
    }
    return { count, errors };
}

if (require.main === module) {
    const { count, errors } = validateCatalogue();
    if (errors.length) {
        errors.forEach(error => console.error(error));
        process.exitCode = 1;
    } else console.log(`Validated ${count} catalogue entries.`);
}

module.exports = { validateEntries, validateCatalogue };
