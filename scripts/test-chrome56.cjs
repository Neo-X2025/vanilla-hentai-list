const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('./serve.cjs');

const root = path.resolve(__dirname, '..');
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const entries = {
    vanilla: [['Alpha', 'First note', ['Warm', 'Shared'], 9], ['Beta', 'Second note', ['Warm'], 7],
        ...Array.from({ length: 20 }, (_, i) => [`Entry ${i}`, i ? 'Fixture note' : 'Long note '.repeat(20), [], 6])],
    neutral: [['Gamma', 'Third note', ['Cool', 'Shared'], 5]],
    avoid: [['Delta', 'Fourth note', ['Avoid', 'Cool'], 2]],
};
const total = Object.values(entries).flat().length;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(callback, message, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await callback()) return;
        await pause(100);
    }
    throw new Error(message);
}

async function freePort() {
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return port;
}

async function connect(url, exceptions) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    const pending = new Map();
    let id = 0;
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') exceptions.push(JSON.stringify(message.params.exceptionDetails));
        const task = pending.get(message.id);
        if (!task) return;
        pending.delete(message.id);
        clearTimeout(task.timer);
        if (message.error) task.reject(new Error(JSON.stringify(message.error)));
        else task.resolve(message.result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async expression => {
        const result = await call('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    return { call, evaluate, close: () => socket.close() };
}

async function main() {
    if (!process.env.CHROME56_PATH) throw new Error('Set CHROME56_PATH to the archived Chromium 56 executable. See npm run setup:chrome56.');
    const expected = Number((process.argv.find(value => value.startsWith('--expect-major=')) || '--expect-major=56').split('=')[1]);
    const state = { requests: [], aborted: 0, slow: new Set() };
    const site = createServer();
    const server = http.createServer(async (req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname === '/api' && req.method === 'POST') {
            let body = '';
            for await (const chunk of req) body += chunk;
            const request = JSON.parse(body);
            const titles = Object.values(request.variables);
            state.requests.push(titles);
            res.on('close', () => { if (!res.writableEnded) state.aborted++; });
            const data = Object.fromEntries(Object.entries(request.variables).map(([name, title]) => [name.replace('q', 'c'), {
                media: title === 'Missing' ? [] : [{ title: { romaji: title }, coverImage: { large: pixel } }],
            }]));
            const send = () => {
                if (res.destroyed) return;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ data }));
            };
            if (titles.some(title => state.slow.has(title))) setTimeout(send, 1000);
            else send();
        } else if (pathname === '/') {
            const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
            res.setHeader('Content-Type', 'text/html');
            res.end(html.replace('<script src="app.js">', '<script src="/bootstrap.js"></script>\n<script src="app.js">'));
        } else if (pathname === '/bootstrap.js') {
            res.setHeader('Content-Type', 'text/javascript');
            // Keep the real XHR implementation, redirecting only the API URL to
            // the local fixture server. Browser-side code here is ES5 syntax.
            res.end(`(function () {
                ${expected === 56 ? '' : 'window.AbortController = undefined; Object.defineProperty(navigator, "clipboard", {value: undefined});'}
                var Native = window.XMLHttpRequest;
                window.XMLHttpRequest = function () {
                    var xhr = new Native(); var open = xhr.open;
                    xhr.open = function (method, url, async) { return open.call(xhr, method, url === 'https://graphql.anilist.co' ? '/api' : url, async); };
                    return xhr;
                };
                window.fetch = function () { throw new Error('Use cancellable XHR on Chrome 56'); };
                var copy = document.execCommand;
                document.execCommand = function (command) { window.copyValue = document.activeElement.value; return copy.call(document, command); };
            }());`);
        } else if (/^\/data-(vanilla|neutral|avoid)\.js$/.test(pathname)) {
            const category = /^\/data-(\w+)\.js$/.exec(pathname)[1];
            res.setHeader('Content-Type', 'text/javascript');
            res.end(`const ${category}Entries = ${JSON.stringify(entries[category])};`);
        } else if (pathname === '/styles.css') {
            res.setHeader('Content-Type', 'text/css');
            // Test the real layout with its normal fallback font, without an
            // external font service affecting deterministic CI startup.
            res.end((await fs.readFile(path.join(root, 'styles.css'), 'utf8')).replace(/@import[^;]+;/, ''));
        } else site.emit('request', req, res);
    });
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'vanilla-chrome56-profile-'));
    const fontconfig = path.join(profile, 'fonts.conf');
    await fs.writeFile(fontconfig, `<?xml version="1.0"?><fontconfig><dir>/usr/share/fonts/truetype/dejavu</dir><cachedir>${profile}/font-cache</cachedir></fontconfig>`);
    let browser, client, stderr = '';
    const exceptions = [];
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const port = await freePort();
        browser = spawn(process.env.CHROME56_PATH, [
            '--no-sandbox', '--disable-nacl', '--single-process', '--no-zygote', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking',
            '--disable-component-update', '--disable-extensions', '--disable-sync', '--no-first-run', '--no-default-browser-check',
            '--window-size=1600,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
        ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, FONTCONFIG_FILE: fontconfig } });
        browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000); });
        browser.on('error', error => { stderr += error.message; });
        let version;
        await until(async () => {
            try { const result = await fetch(`http://127.0.0.1:${port}/json/version`); version = await result.json(); return true; } catch { return false; }
        }, 'Chromium did not start');
        assert.match(version.Browser, new RegExp(`(?:Chrome|Chromium)/${expected}\\.`));
        console.log(`Testing actual ${version.Browser}`);
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        client = await connect(targets.find(target => target.type === 'page').webSocketDebuggerUrl, exceptions);
        await client.call('Page.enable');
        await client.call('Runtime.enable');
        await client.call('Page.navigate', { url: origin });
        await until(() => client.evaluate(`document.querySelectorAll('.card').length === ${total}`), 'Catalogue did not render');
        const capabilities = await client.evaluate(`({ grid: CSS.supports('display', 'grid'), aspectRatio: CSS.supports('aspect-ratio', '1'), abort: typeof AbortController, finallyMethod: typeof Promise.prototype.finally })`);
        if (expected === 56) assert.deepEqual(capabilities, { grid: false, aspectRatio: false, abort: 'undefined', finallyMethod: 'undefined' });
        assert.equal(await client.evaluate('loader._normalizeTitle("東京々〆〇 café—❶")'), '東京々〆〇 café ❶');
        await client.evaluate('ImageLoader.MIN_INTERVAL = 10; ImageLoader.ERROR_PAUSE = 10; ImageLoader.REQUEST_TIMEOUT = 2000; window.scrollTo(0, document.getElementById("anime-grid").offsetTop);');
        await until(() => client.evaluate('Array.from(document.querySelectorAll(".card-img")).some(function(img) { return img.naturalWidth > 0 && img.style.display === "block"; })'), 'XHR cover loading failed');
        assert.ok(state.requests.length > 0);
        assert.ok(state.requests.every(request => request.length <= 10));
        console.log('PASS: script boot, native cancellable XHR, cover decoding and batched queries');

        await client.evaluate('document.querySelector(".advanced-toggle").click(); document.querySelector("[data-tag=Warm]").click(); document.querySelector("[data-tag=Shared]").click();');
        assert.equal(await client.evaluate('currentData.length'), 3);
        await client.evaluate('document.querySelector("input[value=all]").click();');
        assert.equal(await client.evaluate('currentData.length'), 1);
        await client.evaluate('sortSelect.value = "title_desc"; searchInput.value = "  Alpha  "; updateDisplay();');
        assert.equal(await client.evaluate('currentData.length'), 1);
        await client.evaluate('document.querySelector(".copy-title").click();');
        assert.equal(await client.evaluate('window.copyValue'), 'Alpha');
        assert.match(await client.evaluate('document.getElementById("copyStatus").textContent'), /copied|Could not copy/);
        await client.evaluate('resetFilters();');
        assert.equal(await client.evaluate('currentData.length'), total);
        assert.equal(await client.evaluate('sortSelect.value'), 'score_desc');
        await client.evaluate('document.querySelector("[data-score=\\"9\\"]").click();');
        assert.equal(await client.evaluate('currentData.length'), total - 1);
        await client.evaluate('document.querySelector("[data-cat=neutral]").click();');
        assert.equal(await client.evaluate('currentData[0].title'), 'Gamma');
        await client.evaluate('resetFilters(); document.querySelector(".copy-title").focus(); window.copyValue = null;');
        await client.call('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, text: '\r' });
        await client.call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13 });
        await until(() => client.evaluate('window.copyValue === "Alpha"'), 'Keyboard title copying did not activate');
        console.log('PASS: filtering, scores, categories, tag logic, reset, keyboard and clipboard fallback');

        for (const [width, columns] of [[1600, 5], [1300, 4], [1000, 3], [700, 2], [320, 1]]) {
            await client.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false, fitWindow: false });
            await pause(100);
            const layout = await client.evaluate(`(function() {
                var cards = Array.from(document.querySelectorAll('.card')); var firstTop = cards[0].offsetTop;
                var image = cards[0].querySelector('.card-img-container').getBoundingClientRect();
                return { columns: cards.filter(function(card) { return Math.abs(card.offsetTop - firstTop) < 1; }).length,
                    ratio: image.height / image.width, overflow: document.documentElement.scrollWidth > window.innerWidth };
            }())`);
            assert.equal(layout.columns, columns, `Columns at ${width}px`);
            assert.ok(Math.abs(layout.ratio - 320 / 225) < 0.01, `Cover aspect ratio at ${width}px`);
            assert.equal(layout.overflow, false, `Horizontal overflow at ${width}px`);
        }
        console.log('PASS: five responsive breakpoints, cover aspect ratio and mobile overflow');
        await client.evaluate('Math.random = function() { return 0; }; randomAnime();');
        await until(() => client.evaluate('!document.getElementById("card-0").classList.contains("highlighted")'), 'Random highlight did not expire', 5000);
        await client.evaluate('scrollToTop();');
        await until(() => client.evaluate('window.scrollY === 0'), 'Back-to-top did not scroll to the top');
        console.log('PASS: legacy intersection handling, random selection and numeric scroll fallback');

        state.slow.add('Old');
        await client.evaluate('currentData = [{title:"Old", note:"", tags:[], score:5}]; renderCards(currentData); window.scrollTo(0, document.getElementById("anime-grid").offsetTop);');
        await until(() => state.requests.some(request => request.includes('Old')), 'Old request did not start');
        await client.evaluate('currentData = [{title:"New", note:"", tags:[], score:5}]; renderCards(currentData);');
        await until(() => client.evaluate('loader._states[0] === "done"'), 'Replacement cover did not load');
        await until(() => state.aborted > 0, 'Old XHR was not aborted');
        state.slow.add('Hung');
        await client.evaluate('ImageLoader.REQUEST_TIMEOUT = 100; currentData = [{title:"Hung", note:"", tags:[], score:5}]; renderCards(currentData);');
        await until(() => client.evaluate('loader._states[0] === "error"'), 'Hung XHR did not reach a bounded failure');
        assert.equal(state.requests.filter(request => request.includes('Hung')).length, 3);
        assert.equal(await client.evaluate('document.querySelectorAll(".image-retry").length'), 1);
        assert.deepEqual(exceptions, []);
        console.log('PASS: real XHR cancellation, timeouts, bounded retries and no JavaScript exceptions');
    } catch (error) {
        if (browser) console.error(`Browser exit=${browser.exitCode}, signal=${browser.signalCode}`);
        console.error(stderr);
        if (exceptions.length) console.error('Page exceptions:', exceptions);
        throw error;
    } finally {
        client?.close();
        browser?.kill('SIGTERM');
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
