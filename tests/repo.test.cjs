const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../scripts/serve.cjs');
const { validateEntries, validateCatalogue } = require('../scripts/validate-data.cjs');

let server, origin;
before(async () => {
    server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
});

test('preview serves the application with correct content types and HEAD responses', async () => {
    for (const [file, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css'], ['/data-vanilla.js', 'text/javascript'], ['/favicon.png', 'image/png']]) {
        const response = await fetch(origin + file);
        assert.equal(response.status, 200);
        assert.ok(response.headers.get('Content-Type').startsWith(type));
        const body = await response.arrayBuffer();
        assert.ok(body.byteLength > 0);
        const head = await fetch(origin + file, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(Number(head.headers.get('Content-Length')), body.byteLength);
        assert.equal(await head.text(), '');
    }
});

test('preview does not serve repository internals or accept writes', async () => {
    for (const file of ['/.git/config', '/package-lock.json', '/node_modules/playwright/package.json', '/scripts/serve.cjs', '/missing']) {
        assert.equal((await fetch(origin + file)).status, 404);
    }
    const response = await fetch(origin, { method: 'POST', body: 'test' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD');
});

test('the committed catalogue passes validation', () => {
    const result = validateCatalogue();
    assert.ok(result.count > 0);
    assert.deepEqual(result.errors, []);
});

test('validation catches malformed entries before they reach the browser', () => {
    const entries = [
        ['Valid', '', ['Tag'], 7],
        ['', '', [], 7],
        ['Invalid note', {}, [], 7],
        ['Invalid tags', '', ['Tag', 'Tag'], 7],
        ['Invalid score', '', [], 11],
        ['Short tuple'],
    ];
    const errors = validateEntries(entries, 'fixture.js');
    assert.equal(errors.length, 5);
    assert.ok(errors.every(error => error.startsWith('fixture.js: entry ')));
});

test('validation catches duplicate titles across categories', () => {
    const seen = new Set();
    assert.deepEqual(validateEntries([['Example', '', [], 7]], 'first.js', seen), []);
    assert.match(validateEntries([[' EXAMPLE ', '', [], 6]], 'second.js', seen)[0], /duplicate title/);
});

test('validation reports data-file syntax errors', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vanilla-data-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    for (const category of ['vanilla', 'neutral', 'avoid']) {
        await fs.writeFile(path.join(directory, `data-${category}.js`), category === 'neutral' ? 'const neutralEntries = [' : `const ${category}Entries = [];`);
    }
    const result = validateCatalogue(directory);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /^data-neutral\.js:/);
});
