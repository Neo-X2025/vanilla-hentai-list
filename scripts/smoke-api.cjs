const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createServer } = require('./serve.cjs');

// Keep live checks separate from the real catalogue and normal CI.
const provider = process.argv.includes("--shikimori") ? "shikimori" : "anilist";
const endpoint = provider === "shikimori" ? "https://shikimori.io/api/graphql" : "https://graphql.anilist.co";
const titles = [
    'Cowboy Bebop', 'Mushishi', 'Planetes', 'Aria The Animation', 'Yuru Camp',
    'Non Non Biyori', 'Natsume Yuujinchou', 'Haibane Renmei', 'Barakamon', 'Kino no Tabi',
];

async function main() {
    const server = createServer();
    let browser, page;
    let apiRequests = 0;
    const responses = [];
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        browser = await chromium.launch({
            ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
            headless: true,
            args: ['--no-sandbox'],
        });
        page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
            if (request.url().startsWith(endpoint) && request.method() === 'POST') apiRequests++;
        });
        page.on('response', response => {
            if (response.url().startsWith(endpoint)) responses.push({ status: response.status() });
        });
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            const match = url.pathname.match(/^\/data-(vanilla|neutral|avoid)\.js$/);
            if (url.origin === origin && match) {
                const entries = match[1] === 'vanilla' ? titles.map(title => [title, 'Live API test', [], 5]) : [];
                await route.fulfill({ contentType: 'text/javascript', body: `const ${match[1]}Entries = ${JSON.stringify(entries)};` });
            } else if (url.hostname === 'graphql.anilist.co' && provider === 'shikimori') {
                // Verify real fallback behavior, without relying on AniList downtime.
                await route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
            } else if (url.hostname === 'shikimori.io' && provider === 'anilist') {
                await route.abort();
            } else if (url.origin === origin || url.hostname === 'graphql.anilist.co' || url.hostname.endsWith('.anilist.co')
                || url.hostname === 'shikimori.io' || url.hostname.endsWith('.shikimori.io')) {
                await route.continue();
            } else await route.abort();
        });
        const started = Date.now();
        await page.goto(origin);
        await page.waitForFunction(() => {
            const images = [...document.querySelectorAll('.card-img')];
            return images.length === 10 && images.every(img => img.naturalWidth > 0 && img.style.display === 'block');
        }, null, { timeout: 30000 });
        assert.equal(apiRequests, 1, 'All ten covers should use one API request');
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(provider => currentData.every(entry => loader._cache.get(entry.title).provider === provider), provider), true);
        console.log(`Live browser check passed: 10 covers loaded through ${provider} in ${((Date.now() - started) / 1000).toFixed(2)}s using one API request.`);
    } catch (error) {
        console.error('Live browser check failed:', error.message);
        console.error('API responses:', JSON.stringify(responses));
        if (page) console.error('Cover states:', await page.evaluate(() => currentData.map((entry, index) => ({
            title: entry.title, state: loader._states[index], message: document.getElementById(`spinner-${index}`).textContent,
        }))));
        process.exitCode = 1;
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
