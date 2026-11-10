const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const fixtures = {
    vanilla: [['Alpha', 'First note', ['Warm', 'Shared'], 9], ['Beta', 'Second note', ['Warm'], 7]],
    neutral: [['Gamma', 'Third note', ['Cool', 'Shared'], 5]],
    avoid: [['Delta', 'Fourth note', ['Avoid', 'Cool'], 2]],
};
let server, browser, baseURL;

before(async () => {
    server = http.createServer(async (req, res) => {
        const name = new URL(req.url, 'http://localhost').pathname;
        const files = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/favicon.png': 'favicon.png' };
        const file = files[name];
        if (!file) { res.writeHead(404).end(); return; }
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
        res.setHeader('Content-Type', types[path.extname(file)]);
        res.end(await fs.readFile(path.join(root, file)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
        ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
        headless: true,
        args: ['--no-sandbox'],
    });
});

after(async () => {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
});

async function openPage(t, entries = fixtures, init) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    t.after(() => context.close());
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        const match = url.pathname.match(/^\/data-(vanilla|neutral|avoid)\.js$/);
        if (url.origin === baseURL && match) {
            const body = entries ? `const ${match[1]}Entries = ${JSON.stringify(entries[match[1]])};`
                : await fs.readFile(path.join(root, `data-${match[1]}.js`), 'utf8');
            await route.fulfill({ contentType: 'text/javascript', body });
        } else if (url.origin === baseURL || url.protocol === 'data:') {
            await route.continue();
        } else {
            await route.abort();
        }
    });
    await context.addInitScript(({ pixel }) => {
        window.testPixel = pixel;
        window.nativeFetch = window.fetch.bind(window);
        window.fetchLog = [];
        window.fetch = async (url, options) => {
            window.fetchLog.push({ url, time: Date.now() });
            return new Response(JSON.stringify({ data: [{ images: { jpg: { image_url: pixel } } }] }));
        };
    }, { pixel });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', error => page.errors.push(error.message));
    await page.goto(baseURL);
    await page.locator('#anime-grid').scrollIntoViewIfNeeded();
    return page;
}

async function loaderPage(t) {
    const page = await openPage(t);
    await page.evaluate(() => {
        loader.reset([]);
        loader._cache.clear();
        ImageLoader.MIN_INTERVAL = 10;
        ImageLoader.ERROR_PAUSE = 10;
        ImageLoader.REQUEST_TIMEOUT = 100;
        ImageLoader.IMAGE_TIMEOUT = 100;
        window.fetchLog = [];
    });
    return page;
}

async function render(page, titles = ['First', 'Second']) {
    await page.evaluate(titles => {
        currentData = titles.map(title => ({ title, note: 'Test note', tags: [], score: 5 }));
        renderCards(currentData);
    }, titles);
    await page.locator('#anime-grid').scrollIntoViewIfNeeded();
}

async function loaded(page, index) {
    await page.waitForFunction(index => {
        const img = document.getElementById(`img-${index}`);
        return img?.naturalWidth > 0 && getComputedStyle(img).display !== 'none';
    }, index, { timeout: 3000 });
}

test('tag OR/AND changes update results immediately', async t => {
    const page = await openPage(t);
    await page.locator('.advanced-toggle').click();
    await page.locator('[data-tag="Warm"]').click();
    await page.locator('[data-tag="Shared"]').click();
    assert.equal(await page.locator('.card').count(), 3);
    await page.locator('input[value="all"]').check();
    assert.equal(await page.locator('.card').count(), 1);
    assert.equal(await page.locator('.card-title').textContent(), 'Alpha');
});

test('reset restores search, sort, scores, tags, logic and category', async t => {
    const page = await openPage(t);
    await page.locator('.advanced-toggle').click();
    await page.locator('#sortSelect').selectOption('title_desc');
    await page.locator('[data-tag="Warm"]').click();
    await page.locator('input[value="all"]').check();
    await page.locator('[data-cat="vanilla"]').click();
    await page.locator('#searchInput').fill('Beta');
    await page.locator('[data-score="7"]').click();
    await page.locator('.reset-btn').click();
    assert.equal(await page.locator('#sortSelect').inputValue(), 'score_desc');
    assert.equal(await page.locator('#searchInput').inputValue(), '');
    assert.equal(await page.locator('.card').count(), 4);
    assert.equal(await page.locator('.score-btn.active').count(), 10);
    assert.equal(await page.locator('.tag-btn.active').count(), 0);
    assert.equal(await page.locator('[data-cat="all"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('input[value="any"]').isChecked(), true);
});

test('search ignores surrounding whitespace and handles empty results', async t => {
    const page = await openPage(t);
    await page.locator('#searchInput').fill('  alpha  ');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
    await page.locator('#searchInput').fill('No matching entry');
    await page.waitForFunction(() => document.querySelector('.no-results'));
    await page.locator('.random-btn').click();
    assert.deepEqual(page.errors, []);
});

test('titles, notes and tags render as literal text, including quotes and HTML', async t => {
    const title = 'Quoted " <em>Title</em> & text';
    const note = '<img src=x onerror="window.injected=true">';
    const page = await openPage(t, { vanilla: [[title, note, ['<b>Tag</b>'], 9]], neutral: [], avoid: [] });
    assert.equal(await page.locator('.card-title').textContent(), title);
    assert.equal(await page.locator('.card-img').getAttribute('alt'), title);
    assert.equal(await page.locator('.card-note').textContent(), note);
    assert.equal(await page.locator('.tag').textContent(), '<b>Tag</b>');
    assert.equal(await page.locator('.card-note img, .card-title em, .tag b').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
});

test('advanced filters and title copying work with the keyboard', async t => {
    const page = await openPage(t, fixtures, () => {
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; } } });
    });
    await page.locator('.advanced-toggle').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.advanced-toggle').getAttribute('aria-expanded'), 'true');
    await page.locator('.copy-title').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.copied === 'Alpha');
    assert.match(await page.locator('#copyStatus').textContent(), /copied/i);
});

test('missing Clipboard API uses a fallback and failed copying gives feedback', async t => {
    const page = await openPage(t, fixtures, () => {
        Object.defineProperty(navigator, 'clipboard', { value: undefined });
        document.execCommand = command => {
            window.copied = document.activeElement.value;
            return !window.failCopy && command === 'copy';
        };
    });
    await page.locator('.card').first().click();
    await page.waitForFunction(() => window.copied === 'Alpha');
    assert.match(await page.locator('#copyStatus').textContent(), /copied/i);
    await page.evaluate(() => { window.failCopy = true; });
    await page.locator('.card').first().click();
    assert.match(await page.locator('#copyStatus').textContent(), /could not copy/i);
    assert.deepEqual(page.errors, []);
});

test('covers load successfully and queries keep the full normalized title', async t => {
    const page = await loaderPage(t);
    const title = 'A Long: Distinctive Title With More Than Forty Characters & Its Sequel';
    await render(page, [title]);
    await loaded(page, 0);
    const urls = await page.evaluate(() => fetchLog.map(entry => entry.url));
    const url = new URL(urls[0]);
    assert.equal(url.origin, 'https://api.jikan.moe');
    assert.equal(url.pathname, '/v4/anime');
    assert.equal(url.searchParams.get('q'), 'A Long Distinctive Title With More Than Forty Characters Its Sequel');
    assert.equal(url.searchParams.get('limit'), '1');
});

test('empty results do not block later covers and can be retried manually', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        window.fetch = async url => {
            fetchLog.push(url);
            const empty = new URL(url).searchParams.get('q') === 'First' && !window.recover;
            return new Response(JSON.stringify({ data: empty ? [] : [{ images: { jpg: { image_url: testPixel } } }] }));
        };
    });
    await render(page);
    await loaded(page, 1);
    assert.match(await page.locator('#spinner-0').textContent(), /no cover/i);
    assert.equal(await page.evaluate(() => fetchLog.filter(url => new URL(url).searchParams.get('q') === 'First').length), 1);
    await page.evaluate(() => { window.recover = true; });
    await page.locator('#card-0 .image-retry').click();
    await loaded(page, 0);
    assert.equal(await page.locator('#copyStatus').textContent(), '');
});

for (const failure of ['network', 'server', 'rate-limit', 'invalid-json', 'missing-data', 'broken-image', '404']) {
    test(`${failure} failures terminate and let other covers load`, async t => {
        const page = await loaderPage(t);
        await page.evaluate(failure => {
            window.fetch = async url => {
                fetchLog.push(url);
                if (new URL(url).searchParams.get('q') !== 'First') {
                    return new Response(JSON.stringify({ data: [{ images: { webp: { image_url: testPixel } } }] }));
                }
                if (failure === 'network') throw new TypeError('Failed to fetch');
                if (failure === 'server') return new Response('', { status: 503 });
                if (failure === '404') return new Response('', { status: 404 });
                if (failure === 'rate-limit') return new Response('', { status: 429, headers: { 'Retry-After': 'invalid' } });
                if (failure === 'invalid-json') return new Response('{broken');
                if (failure === 'missing-data') return new Response('null');
                return new Response(JSON.stringify({ data: [{ images: { jpg: { image_url: 'data:image/png;base64,broken' } } }] }));
            };
        }, failure);
        await render(page);
        await loaded(page, 1);
        await page.waitForFunction(() => loader._states[0] === 'error', null, { timeout: 3000 });
        const attempts = await page.evaluate(() => fetchLog.filter(url => new URL(url).searchParams.get('q') === 'First').length);
        assert.equal(attempts, ['404', 'missing-data'].includes(failure) ? 1 : 3);
        assert.equal(await page.locator('#card-0 .image-retry').count(), 1);
        assert.deepEqual(page.errors, []);
    });
}

test('a hung request times out and releases the queue', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        window.abortCount = 0;
        window.fetch = (url, options) => {
            if (new URL(url).searchParams.get('q') !== 'First') return Promise.resolve(new Response(JSON.stringify({ data: [{ images: { jpg: { image_url: testPixel } } }] })));
            return new Promise((resolve, reject) => options?.signal.addEventListener('abort', () => {
                abortCount++;
                reject(new DOMException('Aborted', 'AbortError'));
            }));
        };
    });
    await render(page);
    await loaded(page, 1);
    await page.waitForFunction(() => loader._states[0] === 'error', null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => abortCount), 3);
});

test('filter changes abort old requests and stale JSON errors cannot alter new cards', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        ImageLoader.REQUEST_TIMEOUT = 3000;
        window.fetch = async (url, options) => {
            if (new URL(url).searchParams.get('q') === 'Old') {
                window.oldSignal = options?.signal;
                return { ok: true, status: 200, headers: new Headers(), json: () => new Promise((resolve, reject) => { window.rejectOld = reject; }) };
            }
            return new Response(JSON.stringify({ data: [{ images: { jpg: { image_url: testPixel } } }] }));
        };
    });
    await render(page, ['Old']);
    await page.waitForFunction(() => typeof window.rejectOld === 'function');
    await render(page, ['New']);
    await loaded(page, 0);
    assert.equal(await page.evaluate(() => window.oldSignal?.aborted), true);
    await page.evaluate(() => { window.rejectOld(new SyntaxError('Old response')); });
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => loader._states[0]), 'done');
    assert.equal(await page.locator('#spinner-0').isVisible(), false);
    assert.deepEqual(page.errors, []);
});

for (const format of ['seconds', 'date']) {
    test(`Retry-After ${format} delays all subsequent API requests`, async t => {
        const page = await loaderPage(t);
        await page.evaluate(format => {
            window.retryUntil = 0;
            window.fetch = async url => {
                fetchLog.push({ url, time: Date.now() });
                if (fetchLog.length === 1) {
                    const retryAfter = format === 'seconds' ? '0.15' : new Date(Date.now() + 1500).toUTCString();
                    window.retryUntil = format === 'seconds' ? Date.now() + 150 : Date.parse(retryAfter);
                    return new Response('', { status: 429, headers: { 'Retry-After': retryAfter } });
                }
                return new Response(JSON.stringify({ data: [{ images: { jpg: { image_url: testPixel } } }] }));
            };
        }, format);
        await render(page);
        await loaded(page, 0);
        await loaded(page, 1);
        const { log, until } = await page.evaluate(() => ({ log: fetchLog, until: retryUntil }));
        assert.equal(log.length, 3);
        assert.ok(log.slice(1).every(entry => entry.time >= until - 5));
    });
}

test('rapid renders do not schedule duplicate cover requests', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        const data = [{ title: 'Only', note: '', tags: [], score: 5 }];
        renderCards(data);
        renderCards(data);
        renderCards(data);
    });
    await loaded(page, 0);
    assert.equal(await page.evaluate(() => fetchLog.length), 1);
});

test('covers outside the viewport wait until scrolled near', async t => {
    const page = await loaderPage(t);
    await render(page, Array.from({ length: 60 }, (_, i) => `Entry ${i}`));
    await loaded(page, 0);
    const initially = await page.evaluate(() => fetchLog.map(entry => new URL(entry.url).searchParams.get('q')));
    assert.ok(!initially.includes('Entry 59'));
    await page.locator('#card-59').scrollIntoViewIfNeeded();
    await loaded(page, 59);
});

test('random highlight expires on tall cards and is cleared by filtering', async t => {
    const page = await openPage(t);
    await page.evaluate(() => {
        Math.random = () => 0;
        document.getElementById('card-0').style.height = '3000px';
        const scroll = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function(options) { scroll.call(this, { ...options, behavior: 'instant' }); };
        randomAnime();
    });
    await page.waitForFunction(() => !document.getElementById('card-0').classList.contains('highlighted'), null, { timeout: 3500 });
    await page.locator('.random-btn').click();
    await page.locator('#searchInput').fill('Beta');
    await page.waitForFunction(() => currentData.length === 1);
    assert.equal(await page.evaluate(() => _highlightedCard), null);
    assert.equal(await page.evaluate(() => _highlightObserver), null);
});

test('mobile layout stays within the viewport', async t => {
    const page = await openPage(t, { vanilla: [['X'.repeat(120), 'Long note '.repeat(30), ['LongTag'.repeat(12)], 9]], neutral: [], avoid: [] });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.locator('.advanced-toggle').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
});

test('the actual catalogue renders with valid scores, tags and no script errors', async t => {
    const page = await openPage(t, null);
    const counts = await page.evaluate(() => ({
        data: animeData.length,
        rendered: document.querySelectorAll('.card').length,
        invalid: animeData.filter(a => !a.title || !Array.isArray(a.tags) || !Number.isInteger(a.score) || a.score < 1 || a.score > 10).length,
    }));
    assert.ok(counts.data > 0);
    assert.equal(counts.rendered, counts.data);
    assert.equal(counts.invalid, 0);
    assert.deepEqual(page.errors, []);
});

test('real browser Fetch handles the Jikan response contract and CORS', async t => {
    const page = await loaderPage(t);
    const requests = [];
    await page.route('https://api.jikan.moe/v4/anime?**', async route => {
        requests.push(route.request().url());
        await route.fulfill({
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ pagination: {}, data: [{ images: { jpg: { image_url: pixel } } }] }),
        });
    });
    await page.evaluate(() => { window.fetch = window.nativeFetch; ImageLoader.REQUEST_TIMEOUT = 2000; });
    await render(page, ['Contract Test']);
    await loaded(page, 0);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0]).searchParams.get('q'), 'Contract Test');
    assert.deepEqual(page.errors, []);
});

test('a stalled image download times out without blocking other covers', async t => {
    const page = await loaderPage(t);
    await page.route('https://covers.test/slow.png', () => {});
    await page.evaluate(() => {
        window.fetch = async url => {
            fetchLog.push(url);
            const image = new URL(url).searchParams.get('q') === 'First' ? 'https://covers.test/slow.png' : testPixel;
            return new Response(JSON.stringify({ data: [{ images: { jpg: { image_url: image } } }] }));
        };
    });
    await render(page);
    await loaded(page, 1);
    await page.waitForFunction(() => loader._states[0] === 'error', null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => fetchLog.filter(url => new URL(url).searchParams.get('q') === 'First').length), 3);
    assert.equal(await page.locator('#card-0 .image-retry').count(), 1);
});

test('verified covers are reused from cache without another API request', async t => {
    const page = await loaderPage(t);
    await render(page, ['Cached']);
    await loaded(page, 0);
    await render(page, ['Cached']);
    await loaded(page, 0);
    assert.equal(await page.evaluate(() => fetchLog.length), 1);
});

test('detached image callbacks cannot modify replacement cards', async t => {
    const page = await loaderPage(t);
    await page.route('https://covers.test/old.png', () => {});
    await page.evaluate(() => {
        ImageLoader.IMAGE_TIMEOUT = 3000;
        window.fetch = async url => {
            const image = new URL(url).searchParams.get('q') === 'Old' ? 'https://covers.test/old.png' : testPixel;
            return new Response(JSON.stringify({ data: [{ images: { jpg: { image_url: image } } }] }));
        };
    });
    await render(page, ['Old']);
    await page.waitForFunction(() => document.getElementById('img-0').getAttribute('src') === 'https://covers.test/old.png');
    await page.evaluate(() => {
        const img = document.getElementById('img-0');
        window.oldImageCallbacks = [img.onload, img.onerror];
    });
    await render(page, ['New']);
    await loaded(page, 0);
    await page.evaluate(() => window.oldImageCallbacks.forEach(callback => callback()));
    assert.equal(await page.evaluate(() => loader._states[0]), 'done');
    assert.equal(await page.locator('#spinner-0').isVisible(), false);
});

test('requests are serialized and minimum spacing survives filter changes', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        ImageLoader.MIN_INTERVAL = 80;
        ImageLoader.REQUEST_TIMEOUT = 2000;
        window.concurrent = 0;
        window.maxConcurrent = 0;
        window.fetch = async url => {
            window.maxConcurrent = Math.max(window.maxConcurrent, ++window.concurrent);
            fetchLog.push({ url, time: Date.now() });
            await new Promise(resolve => setTimeout(resolve, 30));
            window.concurrent--;
            return new Response(JSON.stringify({ data: [{ images: { jpg: { image_url: testPixel } } }] }));
        };
    });
    await render(page, ['Before']);
    await loaded(page, 0);
    await render(page, ['After', 'Another']);
    await loaded(page, 0);
    await loaded(page, 1);
    const { log, concurrent } = await page.evaluate(() => ({ log: fetchLog, concurrent: maxConcurrent }));
    assert.equal(log.length, 3);
    assert.equal(concurrent, 1);
    for (let i = 1; i < log.length; i++) assert.ok(log[i].time - log[i - 1].time >= 75);
});

test('missing Retry-After uses a bounded fallback delay', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        window.fetch = async url => {
            fetchLog.push({ url, time: Date.now() });
            if (fetchLog.length === 1) return new Response('', { status: 429 });
            return new Response(JSON.stringify({ data: [{ images: { jpg: { image_url: testPixel } } }] }));
        };
    });
    await render(page, ['Retry']);
    await loaded(page, 0);
    const log = await page.evaluate(() => fetchLog);
    assert.equal(log.length, 2);
    assert.ok(log[1].time - log[0].time >= 10);
});

test('browsers without IntersectionObserver still load covers and clear highlights', async t => {
    const page = await openPage(t, fixtures, () => { window.IntersectionObserver = undefined; });
    await loaded(page, 0);
    await page.evaluate(() => { Math.random = () => 0; randomAnime(); });
    await page.waitForFunction(() => !document.getElementById('card-0').classList.contains('highlighted'), null, { timeout: 3000 });
    assert.deepEqual(page.errors, []);
});
