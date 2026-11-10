const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const postcss = require('postcss');
const bcd = require('@mdn/browser-compat-data');

const target = 56;

function supportsChrome(feature) {
    const support = feature?.__compat?.support?.chrome;
    return (Array.isArray(support) ? support : [support]).some(entry => {
        if (!entry || entry.flags || entry.prefix || entry.alternative_name || !entry.version_added) return false;
        const added = entry.version_added === true ? 1 : parseFloat(String(entry.version_added).replace('≤', ''));
        return added <= target && (!entry.version_removed || parseFloat(entry.version_removed) > target);
    });
}

function checkJS(code, filename) {
    const errors = [];
    let tree;
    try {
        tree = acorn.parse(code, { ecmaVersion: 2017, sourceType: 'script', locations: true, allowReturnOutsideFunction: true });
    } catch (error) { return [`${filename}: ${error.message}`]; }
    const newerMethods = new Set(['fromEntries', 'finally', 'replaceChildren', 'replaceAll', 'flat', 'flatMap', 'at', 'toSorted', 'toReversed', 'toSpliced', 'findLast', 'findLastIndex']);
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'MemberExpression' && !node.computed && newerMethods.has(node.property.name)) {
            errors.push(`${filename}:${node.loc.start.line}: ${node.property.name} needs a Chrome 56 alternative`);
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    }
    visit(tree);
    return errors;
}

function checkCSS(code, filename) {
    const errors = [];
    const sheet = postcss.parse(code, { from: filename });
    const functions = new Set(['var', 'calc', 'url', 'rgb', 'rgba', 'translate', 'translatex', 'translatey']);
    sheet.walkDecls(decl => {
        const prop = decl.prop.startsWith('--') ? 'custom-property' : decl.prop;
        const feature = bcd.css.properties[prop];
        const at = `${filename}:${decl.source.start.line}`;
        if (!supportsChrome(feature)) errors.push(`${at}: ${decl.prop} is not supported in Chrome ${target}`);
        const valueFeature = feature?.[decl.value];
        if (valueFeature?.__compat && !supportsChrome(valueFeature)) errors.push(`${at}: ${decl.prop}: ${decl.value} is not supported in Chrome ${target}`);
        for (const match of decl.value.matchAll(/([a-z-]+)\(/gi)) {
            if (!functions.has(match[1].toLowerCase())) errors.push(`${at}: audit ${match[1]}() before using it with Chrome ${target}`);
        }
    });
    sheet.walkRules(rule => {
        for (const match of rule.selector.matchAll(/::?([a-z-]+)/gi)) {
            if (!supportsChrome(bcd.css.selectors[match[1].replace(/-/g, '_')] || bcd.css.selectors[match[1]])) {
                errors.push(`${filename}:${rule.source.start.line}: :${match[1]} is not supported in Chrome ${target}`);
            }
        }
    });
    return errors;
}

function checkHTML(code, filename) {
    const errors = [];
    for (const match of code.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
        const tag = match[1].toLowerCase();
        if (!supportsChrome(bcd.html.elements[tag])) errors.push(`${filename}: <${tag}> is not supported in Chrome ${target}`);
        for (const handler of match[2].matchAll(/\bon\w+="([^"]*)"/g)) errors.push(...checkJS(handler[1], `${filename} inline handler`));
        const style = /\bstyle="([^"]*)"/.exec(match[2]);
        if (style) errors.push(...checkCSS(`element { ${style[1]} }`, `${filename} inline style`));
        if (tag === 'script' && /\btype="module"/.test(match[2])) errors.push(`${filename}: module scripts need a classic-script alternative in Chrome ${target}`);
        if (tag === 'input') {
            const type = /\btype="([^"]+)"/.exec(match[2]);
            if (type && !supportsChrome(bcd.html.elements.input[`type_${type[1]}`])) errors.push(`${filename}: input type=${type[1]} is not supported in Chrome ${target}`);
        }
        if (tag === 'a' && /target="_blank"/.test(match[2]) && !/rel="[^"]*\bnoopener\b/.test(match[2])) {
            errors.push(`${filename}: external tabs need explicit rel=noopener on Chrome ${target}`);
        }
    }
    for (const style of code.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) errors.push(...checkCSS(style[1], `${filename} inline stylesheet`));
    return errors;
}

function checkCompatibility(directory = path.resolve(__dirname, '..')) {
    const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
    const errors = checkHTML(html, 'index.html');
    for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
        errors.push(...checkJS(fs.readFileSync(path.join(directory, match[1]), 'utf8'), match[1]));
    }
    for (const match of html.matchAll(/<link\b(?=[^>]*\brel="stylesheet")[^>]*\bhref="([^"]+)"/g)) {
        errors.push(...checkCSS(fs.readFileSync(path.join(directory, match[1]), 'utf8'), match[1]));
    }
    return errors;
}

if (require.main === module) {
    const errors = checkCompatibility();
    if (errors.length) { errors.forEach(error => console.error(error)); process.exitCode = 1; }
    else console.log('Chrome 56 JavaScript syntax, CSS, and HTML compatibility checks passed.');
}

module.exports = { checkJS, checkCSS, checkHTML, checkCompatibility };
