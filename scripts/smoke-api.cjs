const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createServer } = require('./serve.cjs');

// Keep live checks separate from the real catalogue and normal CI.
const titles = [
    'Cowboy Bebop', 'Mushishi', 'Planetes', 'Aria The Animation', 'Yuru Camp',
    'Non Non Biyori', 'Natsume Yuujinchou', 'Haibane Renmei', 'Barakamon', 'Kino no Tabi',
];

async function main() {
    const server = createServer();
    let browser;
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
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
            if (request.url().startsWith('https://graphql.anilist.co') && request.method() === 'POST') apiRequests++;
        });
        page.on('response', response => {
            if (response.url().startsWith('https://graphql.anilist.co')) responses.push({ status: response.status() });
        });
        await page.addInitScript(() => { window.IntersectionObserver = undefined; });
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            const match = url.pathname.match(/^\/data-(vanilla|neutral|avoid)\.js$/);
            if (url.origin === origin && match) {
                const entries = match[1] === 'vanilla' ? titles.map(title => [title, 'Live API test', [], 5]) : [];
                await route.fulfill({ contentType: 'text/javascript', body: `const ${match[1]}Entries = ${JSON.stringify(entries)};` });
            } else if (url.origin === origin || url.hostname === 'graphql.anilist.co' || url.hostname.endsWith('.anilist.co')) {
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
        console.log(`Live browser check passed: 10 covers loaded through AniList in ${((Date.now() - started) / 1000).toFixed(2)}s using one API request.`);
    } catch (error) {
        console.error('Live browser check failed:', error.message);
        console.error('API responses:', JSON.stringify(responses));
        process.exitCode = 1;
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
