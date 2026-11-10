const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkJS, checkCSS, checkHTML, checkCompatibility } = require('../scripts/check-compat.cjs');

test('all shipped scripts, inline handlers, HTML and CSS pass the Chrome 56 guard', () => {
    assert.deepEqual(checkCompatibility(), []);
});

test('the compatibility guard rejects newer syntax and unguarded modern methods', () => {
    for (const code of ['class Example { static value = 1; }', 'const x = value?.name;', 'try {} catch {}', 'const r = /\\p{L}/u;', 'Object.fromEntries([]);', 'element.replaceChildren();', 'request.finally(done);']) {
        assert.ok(checkJS(code, 'fixture.js').length > 0, code);
    }
});

test('the compatibility guard rejects newer layout and focus features', () => {
    for (const code of ['.x { display: grid; }', '.x { gap: 10px; }', '.x { aspect-ratio: 1; }', '.x { width: clamp(1px, 2vw, 3px); }', '.x:focus-visible { color: red; }']) {
        assert.ok(checkCSS(code, 'fixture.css').length > 0, code);
    }
    assert.deepEqual(checkCSS('.x { display: flex; margin: 8px; width: calc(20% - 16px); }', 'fixture.css'), []);
});

test('external tabs explicitly retain opener protection on older Chrome', () => {
    assert.ok(checkHTML('<a target="_blank">Link</a>', 'fixture.html').length > 0);
    assert.deepEqual(checkHTML('<a target="_blank" rel="noopener noreferrer">Link</a>', 'fixture.html'), []);
});
