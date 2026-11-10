# Vanilla Hentai List

A static catalogue with search, score and tag filters, sorting, and cover images.
Serve this directory with any static web server, for example:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. There is no build step; the page runs in the browser.

## Cover loading

Covers use the [Jikan v4 anime search API](https://docs.api.jikan.moe/).
Only cards near the viewport request covers. Requests are serialized and spaced
at least 1.1 seconds apart to respect Jikan's 3/second and 60/minute limits.
Successfully loaded covers are cached in memory for the current page session.

API requests time out after 10 seconds and image downloads after 15 seconds.
Transient failures get up to two retries with increasing delays; a failed entry
goes to the back of the queue. Rate limits respect `Retry-After` in seconds or
HTTP-date form, with a fallback delay for missing or invalid headers. Empty
search results and permanent HTTP errors show a fallback immediately. Use
**Retry cover** to try again after a failure. Some entries may not exist in
Jikan's catalogue, and cover availability also depends on Jikan and the image host.

Changing filters cancels pending requests and ignores callbacks from old cards.
Search input is debounced to avoid restarting requests with every keystroke.

## Tests

Requires Node.js 20 or newer. Install the development dependencies and Chromium:

```sh
npm ci
npx playwright install chromium
npm test
```

If Chromium is already installed, use `BROWSER_PATH=/path/to/chromium npm test`.
Minimal Linux systems may need `npx playwright install --with-deps chromium`
instead. GitHub Actions uses Chrome already installed on its Ubuntu runner.

Tests run the real page in headless Chromium with synthetic entries and stubbed
API/image responses. They cover filtering, reset, keyboard controls, clipboard
fallbacks, literal text rendering, mobile layout, lazy loading, request cancellation,
timeouts, rate limiting, malformed responses, and failed image downloads. They do
not depend on Jikan being online or download real catalogue covers.
