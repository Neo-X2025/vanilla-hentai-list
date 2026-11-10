# Contributing

Use Node.js 22 or newer for development. The deployed page is plain HTML, CSS,
and JavaScript and needs no build step.

```sh
npm ci
npx playwright install chromium
npm start
```

The development server listens on `http://127.0.0.1:8080`. To choose another port,
run `npm start -- 9000`.

Before opening a pull request:

```sh
npm run check
npm test
```

If Chromium is installed already, set `BROWSER_PATH` when running tests. The
automated suite uses synthetic API responses and does not contact cover providers.
`npm run test:live` is a separate, optional check using ten non-adult test titles
and the real AniList API and image host. It needs network access and can fail
during a provider outage.

## Catalogue edits

Entries live in `data-vanilla.js`, `data-neutral.js`, and `data-avoid.js`. Keep the
existing array format:

```js
["Example Title", "Your note.", ["Example Tag"], 7],
```

Titles must be unique across all three files. Use nonempty titles, string notes,
unique string tags, and integer scores from 1 through 10. `npm run check` reports
malformed entries and duplicate titles before they reach the browser. Keep data
edits separate from code changes when practical.

## Code changes

Use the existing four-space JavaScript indentation. Keep the site deployable as
static files. Add regression coverage for behavior changes, particularly request
batching, cache invalidation, rate limits, and stale asynchronous callbacks.
Use synthetic entries in tests, and keep live-provider checks out of normal CI.

Explain the problem, resulting behavior, and validation in the pull request.
Contributions are accepted under the repository's [0BSD license](LICENSE).
