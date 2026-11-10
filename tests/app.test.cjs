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
                media: result ? result(title) : [{ title: { romaji: title }, coverImage: { large: pixel } }],
            }])),
        }));
        window.setApiHandler = handler => {
            window.fetch = async (url, options) => {
                const body = JSON.parse(options.body);
                window.fetchLog.push({ url, ...body, headers: options.headers, time: Date.now() });
                return handler(body.variables, options);
            };
        };
        window.setApiHandler(variables => window.respond(variables));
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
        assert.equal(attempts, failure === '404' ? 1 : 3);
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
            data[alias] = title === 'First' ? null : { media: [{ coverImage: { large: testPixel } }] };
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

test('covers outside the viewport wait until scrolled near', async t => {
    const page = await loaderPage(t);
    await render(page, Array.from({ length: 60 }, (_, i) => `Entry ${i}`));
    await loaded(page, 0);
    const initially = await page.evaluate(() => fetchLog.flatMap(entry => Object.values(entry.variables)));
    assert.ok(!initially.includes('Entry 59'));
    await page.locator('#card-59').scrollIntoViewIfNeeded();
    await loaded(page, 59);
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
        const data = Object.fromEntries(Object.keys(request.variables).map(key => [key.replace('q', 'c'), { media: [{ coverImage: { large: pixel } }] }]));
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
    assert.equal(await page.evaluate(() => fetchLog.filter(request => Object.values(request.variables).includes('First')).length), 3);
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
