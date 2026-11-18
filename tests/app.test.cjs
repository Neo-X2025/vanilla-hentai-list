const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../scripts/serve.cjs');
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
    server = createServer();
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
        window.respond = (variables, result) => new Response(JSON.stringify({
            data: Object.fromEntries(Object.entries(variables).map(([name, title]) => [name.replace('q', 'c'), {
                media: result ? result(title).map(entry => Object.assign({ title: { romaji: title } }, entry)) : [{ title: { romaji: title }, coverImage: { large: pixel } }],
            }])),
        }));
        window.respondShikimori = (variables, result) => new Response(JSON.stringify({
            data: Object.fromEntries(Object.entries(variables).map(([name, title]) => [name.replace('q', 'c'),
                result ? result(title) : [{ name: title, poster: { originalUrl: pixel } }],
            ])),
        }));
        window.setApiHandler = handler => {
            window.fetch = async (url, options) => {
                const body = JSON.parse(options.body);
                window.fetchLog.push({ url, ...body, headers: options.headers, time: Date.now() });
                return handler(body.variables, options, url);
            };
        };
        window.setApiHandler((variables, options, url) => url.includes("shikimori") ? window.respondShikimori(variables) : window.respond(variables));
    }, { pixel });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', error => page.errors.push(error.message));
    await page.goto(baseURL);
    await page.locator('#anime-grid').scrollIntoViewIfNeeded();
    return page;
}

async function loaderPage(t, entries = fixtures) {
    const page = await openPage(t, entries);
    await page.evaluate(() => {
        loader.reset([]);
        loader._cache.clear();
        ImageLoader.SOURCES = ["anilist"];
        ImageLoader.SECONDARY_INTERVAL = 10;
        ImageLoader.SERVICE_PAUSE = 20;
        ImageLoader.HOST_PAUSE = 20;
        ImageLoader.MIN_INTERVAL = 10;
        ImageLoader.ERROR_PAUSE = 10;
        ImageLoader.RATE_LIMIT_PAUSE = 10;
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

test('ten title lookups share one POST and keep full normalized titles in variables', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => { window.IntersectionObserver = undefined; });
    const titles = ['A Long: Distinctive Title With More Than Forty Characters & Its Sequel', ...Array.from({ length: 9 }, (_, i) => `Entry ${i}`)];
    await render(page, titles);
    await loaded(page, 9);
    const log = await page.evaluate(() => fetchLog);
    assert.equal(log.length, 1);
    assert.equal(log[0].url, 'https://graphql.anilist.co');
    assert.equal(Object.keys(log[0].variables).length, 10);
    assert.equal(log[0].variables.q0, 'A Long Distinctive Title With More Than Forty Characters Its Sequel');
    assert.match(log[0].query, /c9: Page/);
    assert.ok(!log[0].query.includes('Distinctive'));
    assert.equal(log[0].headers['Content-Type'], 'application/json');
});

test('legacy title normalization preserves Japanese letters and Unicode numbers', async t => {
    const page = await loaderPage(t);
    await render(page, ['東京々〆〇 café—❶']);
    await loaded(page, 0);
    assert.equal(await page.evaluate(() => fetchLog[0].variables.q0), '東京々〆〇 café ❶');
});

test('batches stay bounded when more than ten cards are queued', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => { window.IntersectionObserver = undefined; });
    await render(page, Array.from({ length: 23 }, (_, i) => `Entry ${i}`));
    await loaded(page, 22);
    const log = await page.evaluate(() => fetchLog);
    assert.equal(log.length, 3);
    assert.deepEqual(log.map(request => Object.keys(request.variables).length), [10, 10, 3]);
});

test('an empty search does not block its batch and can be retried manually', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => setApiHandler(variables => respond(variables, title =>
        title === 'First' && !window.recover ? [] : [{ coverImage: { large: testPixel } }]
    )));
    await render(page);
    await loaded(page, 1);
    assert.match(await page.locator('#spinner-0').textContent(), /no cover/i);
    assert.equal(await page.evaluate(() => fetchLog.length), 1);
    await page.evaluate(() => { window.recover = true; });
    await page.locator('#card-0 .image-retry').click();
    await loaded(page, 0);
    assert.equal(await page.locator('#copyStatus').textContent(), '');
    assert.equal(await page.evaluate(() => fetchLog.length), 2);
});

for (const failure of ['network', 'server', 'rate-limit', 'invalid-json', 'missing-data', 'broken-image', '404']) {
    test(`${failure} failures terminate and let later batches load`, async t => {
        const page = await loaderPage(t);
        await page.evaluate(failure => {
            ImageLoader.BATCH_SIZE = 1;
            setApiHandler(variables => {
                if (!Object.values(variables).includes('First')) return respond(variables);
                if (failure === 'network') throw new TypeError('Failed to fetch');
                if (failure === 'server') return new Response('', { status: 503 });
                if (failure === '404') return new Response('', { status: 404 });
                if (failure === 'rate-limit') return new Response('', { status: 429, headers: { 'Retry-After': 'invalid' } });
                if (failure === 'invalid-json') return new Response('{broken');
                if (failure === 'missing-data') return new Response('null');
                return respond(variables, () => [{ coverImage: { large: 'data:image/png;base64,broken' } }]);
            });
        }, failure);
        await render(page);
        await loaded(page, 1);
        await page.waitForFunction(() => loader._states[0] === 'error', null, { timeout: 3000 });
        const attempts = await page.evaluate(() => fetchLog.filter(request => Object.values(request.variables).includes('First')).length);
        assert.equal(attempts, ['404', 'broken-image'].includes(failure) ? 1 : 3);
        assert.equal(await page.locator('#card-0 .image-retry').count(), 1);
        assert.deepEqual(page.errors, []);
    });
}

test('partial GraphQL errors retry only failed aliases and preserve successful covers', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => setApiHandler(variables => {
        const data = {};
        const errors = [];
        for (const [key, title] of Object.entries(variables)) {
            const alias = key.replace('q', 'c');
            data[alias] = title === 'First' ? null : { media: [{ title: { romaji: title }, coverImage: { large: testPixel } }] };
            if (title === 'First') errors.push({ path: [alias], status: 500, message: 'Temporary failure' });
        }
        return new Response(JSON.stringify({ data, errors }));
    }));
    await render(page);
    await loaded(page, 1);
    await page.waitForFunction(() => loader._states[0] === 'error');
    const log = await page.evaluate(() => fetchLog);
    assert.equal(log.length, 3);
    assert.equal(log.filter(request => Object.values(request.variables).includes('Second')).length, 1);
});

test('HTTP 200 GraphQL rate-limit errors respect the provider reset time', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        window.retryUntil = Math.ceil((Date.now() + 300) / 1000) * 1000;
        setApiHandler(variables => fetchLog.length === 1
            ? new Response(JSON.stringify({ data: null, errors: [{ status: 429, message: 'Too Many Requests' }] }), {
                headers: { 'X-RateLimit-Reset': String(retryUntil / 1000) },
            }) : respond(variables));
    });
    await render(page);
    await loaded(page, 0);
    const { log, until } = await page.evaluate(() => ({ log: fetchLog, until: retryUntil }));
    assert.equal(log.length, 2);
    assert.ok(log[1].time >= until - 5);
});

test('exact alternate titles beat the first fuzzy search hit', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => setApiHandler(variables => respond(variables, title => [
        { title: { romaji: 'Wrong sequel' }, coverImage: { large: 'data:image/png;base64,broken' } },
        { title: { romaji: 'Alternate' }, synonyms: [title], coverImage: { medium: testPixel } },
    ])));
    await render(page, ['Exact']);
    await loaded(page, 0);
    assert.equal(await page.evaluate(() => fetchLog.length), 1);
    assert.equal(await page.locator('#img-0').getAttribute('src'), pixel);
});

test('a hung batch times out and releases later batches', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        ImageLoader.BATCH_SIZE = 1;
        window.abortCount = 0;
        setApiHandler((variables, options) => {
            if (!Object.values(variables).includes('First')) return respond(variables);
            return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
                abortCount++;
                reject(new DOMException('Aborted', 'AbortError'));
            }));
        });
    });
    await render(page);
    await loaded(page, 1);
    await page.waitForFunction(() => loader._states[0] === 'error', null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => abortCount), 3);
});

test('filter changes abort old batches and stale JSON errors cannot alter new cards', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        ImageLoader.REQUEST_TIMEOUT = 3000;
        setApiHandler((variables, options) => {
            if (Object.values(variables).includes('Old')) {
                window.oldSignal = options.signal;
                return { ok: true, status: 200, headers: new Headers(), json: () => new Promise((resolve, reject) => { window.rejectOld = reject; }) };
            }
            return respond(variables);
        });
    });
    await render(page, ['Old']);
    await page.waitForFunction(() => typeof window.rejectOld === 'function');
    await render(page, ['New']);
    await loaded(page, 0);
    assert.equal(await page.evaluate(() => window.oldSignal.aborted), true);
    await page.evaluate(() => { window.rejectOld(new SyntaxError('Old response')); });
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => loader._states[0]), 'done');
    assert.equal(await page.locator('#spinner-0').isVisible(), false);
    assert.deepEqual(page.errors, []);
});

for (const format of ['seconds', 'date', 'missing']) {
    test(`Retry-After ${format} delays subsequent batches`, async t => {
        const page = await loaderPage(t);
        await page.evaluate(format => {
            window.retryUntil = 0;
            setApiHandler(variables => {
                if (fetchLog.length !== 1) return respond(variables);
                const headers = {};
                if (format !== 'missing') headers['Retry-After'] = format === 'seconds' ? '0.15' : new Date(Date.now() + 1500).toUTCString();
                retryUntil = format === 'seconds' ? Date.now() + 150 : format === 'date' ? Date.parse(headers['Retry-After']) : Date.now() + ImageLoader.RATE_LIMIT_PAUSE;
                return new Response('', { status: 429, headers });
            });
        }, format);
        await render(page);
        await loaded(page, 0);
        await loaded(page, 1);
        const { log, until } = await page.evaluate(() => ({ log: fetchLog, until: retryUntil }));
        assert.equal(log.length, 2);
        assert.ok(log[1].time >= until - 5);
    });
}

test('successful responses with exhausted quota delay the next batch', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        window.retryUntil = Math.ceil((Date.now() + 300) / 1000) * 1000;
        setApiHandler(async variables => {
            const response = respond(variables);
            if (fetchLog.length === 1) {
                response.headers.set('X-RateLimit-Remaining', '0');
                response.headers.set('X-RateLimit-Reset', String(retryUntil / 1000));
            }
            return response;
        });
    });
    await render(page, ['Before']);
    await loaded(page, 0);
    await render(page, ['After']);
    await loaded(page, 0);
    const { log, until } = await page.evaluate(() => ({ log: fetchLog, until: retryUntil }));
    assert.equal(log.length, 2);
    assert.ok(log[1].time >= until - 5);
});

test('batches are serialized and provider limits survive filter changes', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        ImageLoader.REQUEST_TIMEOUT = 2000;
        window.concurrent = 0;
        window.maxConcurrent = 0;
        setApiHandler(async variables => {
            window.maxConcurrent = Math.max(window.maxConcurrent, ++window.concurrent);
            await new Promise(resolve => setTimeout(resolve, 30));
            window.concurrent--;
            const response = respond(variables);
            response.headers.set('X-RateLimit-Limit', '600');
            return response;
        });
    });
    await render(page, ['Before']);
    await loaded(page, 0);
    await render(page, ['After', 'Another']);
    await loaded(page, 0);
    await loaded(page, 1);
    const { log, concurrent } = await page.evaluate(() => ({ log: fetchLog, concurrent: maxConcurrent }));
    assert.equal(log.length, 2);
    assert.equal(concurrent, 1);
    assert.ok(log[1].time - log[0].time >= 195);
});

test('rapid renders do not schedule duplicate batch requests', async t => {
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

test('covers outside the viewport load without scrolling', async t => {
    const page = await loaderPage(t);
    await render(page, Array.from({ length: 60 }, (_, i) => `Entry ${i}`));
    await loaded(page, 0);
    const before = await page.evaluate(() => window.scrollY);
    await loaded(page, 59);
    assert.equal(await page.evaluate(() => window.scrollY), before);
});

test('real browser Fetch handles GraphQL POST and CORS', async t => {
    const page = await loaderPage(t);
    const requests = [];
    await page.route('https://graphql.anilist.co/', async route => {
        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };
        if (route.request().method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers });
            return;
        }
        const request = route.request().postDataJSON();
        requests.push(request);
        const data = Object.fromEntries(Object.keys(request.variables).map(key => [key.replace('q', 'c'), { media: [{ title: { romaji: request.variables[key] }, coverImage: { large: pixel } }] }]));
        await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({ data }) });
    });
    await page.evaluate(() => { window.fetch = window.nativeFetch; ImageLoader.REQUEST_TIMEOUT = 2000; });
    await render(page, ['Contract Test', 'Another']);
    await loaded(page, 0);
    await loaded(page, 1);
    assert.equal(requests.length, 1);
    assert.deepEqual(Object.values(requests[0].variables), ['Contract Test', 'Another']);
    assert.deepEqual(page.errors, []);
});

test('a stalled image download times out without blocking its batch', async t => {
    const page = await loaderPage(t);
    await page.route('https://covers.test/slow.png', () => {});
    await page.evaluate(() => setApiHandler(variables => respond(variables, title => [{
        coverImage: { large: title === 'First' ? 'https://covers.test/slow.png' : testPixel },
    }])));
    await render(page);
    await loaded(page, 1);
    await page.waitForFunction(() => loader._states[0] === 'error', null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => fetchLog.filter(request => Object.values(request.variables).includes('First')).length), 1);
    assert.equal(await page.locator('#card-0 .image-retry').count(), 1);
});

test('verified covers are reused without another API request', async t => {
    const page = await loaderPage(t);
    await render(page, ['Cached']);
    await loaded(page, 0);
    await render(page, ['Cached']);
    await loaded(page, 0);
    assert.equal(await page.evaluate(() => fetchLog.length), 1);
});

test('verified HTTPS covers survive a page reload', async t => {
    const entries = { vanilla: [['Cached', '', [], 5]], neutral: [], avoid: [] };
    const page = await loaderPage(t, entries);
    await page.route('https://covers.test/cache.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(pixel.split(',')[1], 'base64') }));
    await page.evaluate(() => setApiHandler(variables => respond(variables, () => [{ coverImage: { large: 'https://covers.test/cache.png' } }])));
    await render(page, ['Cached']);
    await loaded(page, 0);
    await page.reload();
    await page.locator('#anime-grid').scrollIntoViewIfNeeded();
    await loaded(page, 0);
    assert.equal(await page.evaluate(() => fetchLog.length), 0);
    assert.equal(await page.locator('#img-0').getAttribute('src'), 'https://covers.test/cache.png');
});

for (const failure of ['blocked', 'invalid-json', 'expired']) {
    test(`${failure} persistent cache falls back to the API`, async t => {
        const page = await openPage(t, { vanilla: [['Cached', '', [], 5]], neutral: [], avoid: [] });
        const key = await page.evaluate(() => ImageLoader.CACHE_KEY);
        await page.addInitScript(({ failure, key }) => {
            if (failure === 'blocked') Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
            else localStorage.setItem(key, failure === 'invalid-json' ? '{broken' : JSON.stringify([
                ['Cached', { url: 'https://covers.test/expired.png', expires: Date.now() - 1 }],
            ]));
        }, { failure, key });
        await page.reload();
        await page.locator('#anime-grid').scrollIntoViewIfNeeded();
        await loaded(page, 0);
        assert.equal(await page.evaluate(() => fetchLog.length), 1);
        assert.deepEqual(page.errors, []);
    });
}

test('detached image callbacks cannot modify replacement cards', async t => {
    const page = await loaderPage(t);
    await page.route('https://covers.test/old.png', () => {});
    await page.evaluate(() => {
        ImageLoader.IMAGE_TIMEOUT = 3000;
        setApiHandler(variables => respond(variables, title => [{
            coverImage: { large: title === 'Old' ? 'https://covers.test/old.png' : testPixel },
        }]));
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

test('browsers without IntersectionObserver still load covers and clear highlights', async t => {
    const page = await openPage(t, fixtures, () => { window.IntersectionObserver = undefined; });
    await loaded(page, 0);
    await page.evaluate(() => { Math.random = () => 0; randomAnime(); });
    await page.waitForFunction(() => !document.getElementById('card-0').classList.contains('highlighted'), null, { timeout: 3000 });
    assert.deepEqual(page.errors, []);
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

test('an AniList outage falls back to a second working API', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        ImageLoader.SOURCES = ['anilist', 'shikimori'];
        setApiHandler((variables, options, url) => url.includes('anilist') ? new Response('', { status: 503 }) : respondShikimori(variables));
    });
    await render(page);
    await loaded(page, 0);
    await loaded(page, 1);
    const log = await page.evaluate(() => fetchLog);
    assert.ok(log.some(request => request.url.includes('anilist')));
    assert.ok(log.some(request => request.url.includes('shikimori')));
    assert.equal(await page.evaluate(() => loader._cache.get('First').provider), 'shikimori');
});

test('one API rate limit does not pause the other API', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        ImageLoader.SOURCES = ['anilist', 'shikimori'];
        setApiHandler((variables, options, url) => url.includes('anilist')
            ? new Response('', { status: 429, headers: { 'Retry-After': '120' } }) : respondShikimori(variables));
    });
    await render(page);
    await loaded(page, 0);
    assert.equal(await page.evaluate(() => fetchLog.filter(request => request.url.includes('anilist')).length), 1);
    assert.equal(await page.evaluate(() => loader._cache.get('First').provider), 'shikimori');
});

test('broken poster sizes fall through without repeating the metadata lookup', async t => {
    const page = await loaderPage(t);
    let failedRequests = 0;
    await page.route('https://covers.test/unavailable.jpg', route => { failedRequests++; return route.fulfill({ status: 404, body: 'missing' }); });
    await page.evaluate(() => setApiHandler(variables => respond(variables, () => [{ coverImage: {
        large: 'https://covers.test/unavailable.jpg', medium: testPixel,
    } }])));
    await render(page, ['Sized']);
    await loaded(page, 0);
    assert.equal(failedRequests, 1);
    assert.equal(await page.evaluate(() => fetchLog.length), 1);
    assert.equal(await page.locator('#img-0').getAttribute('src'), pixel);
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem(ImageLoader.BAD_CACHE_KEY)).some(record => record[0] === 'https://covers.test/unavailable.jpg')));
});

test('unloadable images fall back to the other source and are skipped after filtering', async t => {
    const page = await loaderPage(t);
    let brokenDownloads = 0;
    await page.route('https://covers.test/blocked.jpg', route => { brokenDownloads++; return route.fulfill({ status: 403, body: 'blocked' }); });
    await page.evaluate(() => {
        ImageLoader.SOURCES = ['anilist', 'shikimori'];
        setApiHandler((variables, options, url) => url.includes('anilist')
            ? respond(variables, () => [{ coverImage: { large: 'https://covers.test/blocked.jpg' } }]) : respondShikimori(variables));
    });
    await render(page, ['First']);
    await loaded(page, 0);
    assert.equal(await page.evaluate(() => loader._cache.get('First').provider), 'shikimori');
    await render(page, ['Second']);
    await loaded(page, 0);
    assert.equal(brokenDownloads, 1);
    assert.equal(await page.evaluate(() => loader._cache.get('Second').provider), 'shikimori');
});

test('manual retry can download a previously failed URL after the host recovers', async t => {
    const page = await loaderPage(t);
    let recovered = false, downloads = 0;
    await page.route('https://covers.test/recovered.png', route => {
        downloads++;
        return recovered
            ? route.fulfill({ contentType: 'image/png', body: Buffer.from(pixel.split(',')[1], 'base64') })
            : route.fulfill({ status: 404, body: 'missing' });
    });
    await page.evaluate(() => setApiHandler(variables => respond(variables, () => [{
        coverImage: { large: 'https://covers.test/recovered.png' },
    }])));
    await render(page, ['Recovered']);
    await page.waitForFunction(() => loader._states[0] === 'error');
    assert.equal(downloads, 1);
    recovered = true;
    await page.locator('#card-0 .image-retry').click();
    await loaded(page, 0);
    assert.equal(downloads, 2);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(ImageLoader.BAD_CACHE_KEY)).length), 0);
});

test('a paused image host does not hold up covers available from the other provider', async t => {
    const page = await loaderPage(t);
    let failures = 0;
    await page.route('https://covers.test/outage/**', route => {
        failures++;
        return route.fulfill({ status: 403, body: 'blocked' });
    });
    await page.evaluate(() => {
        ImageLoader.SOURCES = ['anilist', 'shikimori'];
        ImageLoader.HOST_PAUSE = 120000;
        setApiHandler((variables, options, url) => url.includes('anilist')
            ? respond(variables, title => [{ coverImage: { large: `https://covers.test/outage/${encodeURIComponent(title)}.png` } }])
            : respondShikimori(variables));
    });
    await render(page, Array.from({ length: 12 }, (_, i) => `Entry ${i}`));
    await page.waitForFunction(() => loader._states.every(state => state === 'done'), null, { timeout: 3000 });
    assert.ok(failures >= 3 && failures <= 8);
    assert.equal(await page.evaluate(() => currentData.every(entry => loader._cache.get(entry.title).provider === 'shikimori')), true);
});

test('alternate title searches recover a generic animation suffix', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => setApiHandler(variables => respond(variables, title => title === 'Example'
        ? [{ title: { romaji: 'Example' }, coverImage: { large: testPixel } }] : [])));
    await render(page, ['Example The Animation']);
    await loaded(page, 0);
    const searches = await page.evaluate(() => fetchLog.flatMap(request => Object.values(request.variables)));
    assert.ok(searches.includes('Example The Animation'));
    assert.ok(searches.includes('Example'));
    assert.ok(searches.length <= 3);
});

test('unrelated matches stay unavailable instead of displaying a random poster', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        ImageLoader.SOURCES = ['anilist', 'shikimori'];
        setApiHandler((variables, options, url) => url.includes('anilist')
            ? respond(variables, () => [{ title: { romaji: 'Unrelated Work' }, coverImage: { large: testPixel } }])
            : respondShikimori(variables, () => [{ name: 'Also Unrelated', poster: { originalUrl: testPixel } }]));
    });
    await render(page, ['Requested']);
    await page.waitForFunction(() => loader._states[0] === 'error');
    assert.equal(await page.locator('#img-0').getAttribute('src'), null);
    assert.equal(await page.evaluate(() => fetchLog.length), 2);
});

test('stationary background work starts with visible cards and finishes offscreen cards', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => {
        currentData = Array.from({ length: 80 }, (_, i) => ({ title: `Entry ${i}`, note: '', tags: [], score: 5 }));
        renderCards(currentData);
        window.scrollTo(0, document.getElementById('card-50').offsetTop);
    });
    await loaded(page, 50);
    const first = await page.evaluate(() => Object.values(fetchLog[0].variables));
    assert.ok(first.includes('Entry 50'));
    assert.ok(!first.includes('Entry 0'));
    const scroll = await page.evaluate(() => window.scrollY);
    await loaded(page, 79);
    await loaded(page, 0);
    assert.equal(await page.evaluate(() => window.scrollY), scroll);
});

test('scrolling reprioritizes queued covers ahead of distant background work', async t => {
    const page = await loaderPage(t);
    await page.evaluate(() => { ImageLoader.MIN_INTERVAL = 250; });
    await render(page, Array.from({ length: 40 }, (_, i) => `Entry ${i}`));
    await page.waitForFunction(() => fetchLog.length >= 1);
    await page.evaluate(() => {
        window.scrollTo(0, document.getElementById('card-39').offsetTop);
        loader.reprioritize();
    });
    await page.waitForFunction(() => fetchLog.length >= 2);
    assert.ok(await page.evaluate(() => Object.values(fetchLog[1].variables).includes('Entry 39')));
});

test('background downloads respect the concurrency cap', async t => {
    const page = await loaderPage(t);
    const held = [];
    await page.route('https://covers.test/queued/**', route => { held.push(route); });
    await page.evaluate(() => {
        ImageLoader.IMAGE_TIMEOUT = 3000;
        setApiHandler(variables => respond(variables, title => [{ coverImage: { large: `https://covers.test/queued/${encodeURIComponent(title)}.png` } }]));
    });
    await render(page, Array.from({ length: 12 }, (_, i) => `Entry ${i}`));
    await page.waitForFunction(() => loader._activeImages.size === ImageLoader.IMAGE_CONCURRENCY);
    for (let i = 0; i < 30 && held.length < 6; i++) await page.waitForTimeout(20);
    assert.equal(held.length, 6);
    const body = Buffer.from(pixel.split(',')[1], 'base64');
    await Promise.all(held.slice(0, 6).map(route => route.fulfill({ contentType: 'image/png', body })));
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.card-img')).filter(img => img.naturalWidth > 0).length >= 6);
    for (let i = 0; i < 30 && held.length < 12; i++) await page.waitForTimeout(20);
    assert.equal(held.length, 12);
    await Promise.all(held.slice(6).map(route => route.fulfill({ contentType: 'image/png', body })));
    await loaded(page, 11);
});
