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

## Browser support

The page supports **Chrome 56 and newer**, without a build step or downloaded
polyfill service. Responsive cards use flex layout, margins, and padding-based
cover sizing. The shipped scripts avoid newer syntax and DOM methods. Older
Chrome uses cancellable XMLHttpRequest for covers, native clipboard copying,
and numeric scrolling; newer Chrome retains abortable Fetch
and smooth scrolling. Keyboard focus outlines work on both.

`npm run check` checks every shipped script, inline handler, linked/inline style,
and HTML feature against this baseline. CI also runs the page in an actual
archived **Chromium 56.0.2924.0** browser, checking interaction, network cancellation,
and layout at five viewport sizes. Node.js 22 is only a tooling requirement;
visitors do not need it.

## Cover loading

Covers use both [AniList](https://docs.anilist.co/) and
[Shikimori](https://shikimori.io/api/doc/graphql). Each request batches up to **ten
title searches**. The providers have independent queues and cooldowns, so one
being slow, unavailable, or rate limited does not block the other.

Every card in the current results is queued immediately. Visible cards load first,
then nearby cards, then the remaining cards in the background. Loading continues
without scrolling or other interaction. Scrolling and resizing update priorities,
and at most six image downloads run together. Filtering cancels outdated API and
image requests before starting the new results.

Search checks original, English, native, and alternate titles. Up to three query
variants handle punctuation, accents, and generic suffixes such as "The Animation".
Matching rejects unrelated results and conflicting sequel numbers, and accounts
for movie versus TV editions. It does not simply use the first search result.

A poster is cached only after the browser successfully downloads and decodes it.
Broken URLs and image timeouts trigger another poster size or the other provider;
known failed URLs are remembered for 30 minutes. Repeated host failures temporarily
favor other image hosts. Verified URLs stay cached for seven days, with a 500-entry
limit. Storage being disabled or full does not stop loading.

API requests are spaced at least 2.1 seconds apart for AniList and 750 milliseconds
for Shikimori. Batching allows each request to resolve multiple covers. Each
provider's rate-limit headers and `Retry-After` cooldowns can slow it further.
API requests time out after ten seconds and image downloads after fifteen seconds.
Transient API failures get up to two retries, and each card has a bounded image
attempt budget. Partial GraphQL errors leave successful results intact.

An unavailable or ambiguous catalogue entry can still have no usable poster. Its
card explains the failure and offers **Retry cover**, while other cards keep
loading. Manual retry also clears that card's failed-URL records so recovered
images can be tried again.

## Repository layout

| File | Purpose |
| --- | --- |
| `index.html` / `styles.css` | Page structure and responsive styles |
| `app.js` | Filters, rendering, and batched cover loading |
| `cover-search.js` | Provider queries, title matching, and poster URL validation |
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

`npm run check` checks browser compatibility and validates catalogue data, including
duplicate titles, entry structure, tags, and scores. Browser tests cover filtering,
accessibility controls, copying, mobile layout, passive preloading, priority,
provider failover, title matching, batching, caching, cancellation, rate limits,
partial results, and network/image failures. Normal tests use synthetic
responses and do not contact external providers or load real catalogue covers.

If a browser is already installed, use
`BROWSER_PATH=/path/to/chromium npm test`. On minimal Linux systems, Playwright may
need `npx playwright install --with-deps chromium`. GitHub Actions uses Chrome
already installed on its pinned Ubuntu runner.

For an optional live check of the actual browser request and image-loading flow:

```sh
npm run test:live
npm run test:live -- --shikimori
```

Each command checks ten non-adult test titles in one real request and verifies
that all their images load without scrolling. The first isolates AniList; the
second simulates an AniList outage and checks real Shikimori fallback and poster
downloads. They need network access and are kept separate from CI.

To run the archived-browser check locally on Linux x64 with Python 3, `dpkg-deb`,
and Xvfb installed:

```sh
npm run setup:chrome56
CHROME56_PATH=/tmp/vanilla-list-chrome56/chrome-linux/chrome \
LD_LIBRARY_PATH=/tmp/vanilla-list-chrome56/libs/usr/lib/x86_64-linux-gnu \
xvfb-run -a npm run test:chrome56
```

The setup command downloads the official Chromium snapshot and eleven legacy
library packages, verifies their SHA-256 checksums, and extracts them into a
temporary directory. It does not install system packages. The browser test uses
local synthetic API responses and cover pixels, with the fallback font, so no
catalogue covers or external services are required. Current-Chrome tests and
the optional live API check are separate.

See [CONTRIBUTING.md](CONTRIBUTING.md) for catalogue edits and pull requests.

## License and credits

Source code is licensed under [0BSD](LICENSE). Cover metadata is supplied by
[AniList](https://anilist.co/) and [Shikimori](https://shikimori.io/); external cover
artwork belongs to its respective rights holders.
