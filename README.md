# Vanilla Hentai List

A static review catalogue with search, category and score filters, OR/AND tag
matching, sorting, random selection, and cover images. Built with plain HTML,
CSS, and JavaScript. No framework, build step, server account, or API key is needed.

## Run locally

Open `index.html` directly, or serve the repository with a static web server.
The included preview server requires Node.js 22 or newer:

```sh
npm start
```

Visit `http://127.0.0.1:8080`. Use `npm start -- 9000` for another port. The server
serves only the site's public files. Any static host can serve the same files;
Node.js is only needed for the development tools.

## Cover loading

Covers come from the [AniList GraphQL API](https://docs.anilist.co/). Up to **ten
title searches share one HTTP request**. Cards near the viewport load first, and
verified cover URLs are cached in the browser for seven days, with a 500-entry
limit. The site keeps working if browser storage is disabled or full.

Requests are spaced at least 2.1 seconds apart to respect AniList's current
30-request/minute limit. A full batch resolves ten titles rather than one, so
the request limit does not mean only 30 covers per minute. Server rate-limit
headers can slow requests further; exhausted quota and `Retry-After` cooldowns
are honored. Actual speed depends on the provider, image downloads, and cache hits.

The loader prefers exact titles and alternate names among search results. It
handles partial GraphQL errors without discarding successful covers, aborts
outdated requests after filter changes, and ignores stale callbacks. Requests
time out after ten seconds and image downloads after fifteen seconds. Transient
failures get up to two retries; **Retry cover** allows another attempt afterward.
Entries absent from AniList show a fallback while the other covers continue loading.

## Repository layout

| File | Purpose |
| --- | --- |
| `index.html` / `styles.css` | Page structure and responsive styles |
| `app.js` | Filters, rendering, and batched cover loading |
| `data-vanilla.js` | Vanilla entries |
| `data-neutral.js` | Neutral entries |
| `data-avoid.js` | Avoid entries |
| `scripts/` | Local preview, data validation, and optional live API check |
| `tests/` | Browser regressions and repository-tool checks |

## Development and validation

```sh
npm ci
npx playwright install chromium
npm run check
npm test
```

`npm run check` checks application syntax and validates catalogue data, including
duplicate titles, entry structure, tags, and scores. Browser tests cover filtering,
accessibility controls, copying, mobile layout, batching, caching, cancellation,
rate limits, partial results, and network/image failures. Normal tests use synthetic
responses and do not contact external providers or load real catalogue covers.

If a browser is already installed, use
`BROWSER_PATH=/path/to/chromium npm test`. On minimal Linux systems, Playwright may
need `npx playwright install --with-deps chromium`. GitHub Actions uses Chrome
already installed on its pinned Ubuntu runner.

For an optional live check of the actual browser request and image-loading flow:

```sh
npm run test:live
```

This checks ten non-adult test titles in one real AniList request and verifies
their cover images load. It needs network access and is kept separate from CI.

See [CONTRIBUTING.md](CONTRIBUTING.md) for catalogue edits and pull requests.

## License and credits

Source code is licensed under [0BSD](LICENSE). Cover metadata is supplied by
[AniList](https://anilist.co/); external cover artwork belongs to its respective
rights holders.
