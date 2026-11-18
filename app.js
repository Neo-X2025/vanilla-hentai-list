// =============================================================================
// DATA
// =============================================================================
const animeData = [
    ...vanillaEntries.map(e => ({ title: e[0], note: e[1], tags: e[2], score: e[3], category: "vanilla" })),
    ...neutralEntries.map(e => ({ title: e[0], note: e[1], tags: e[2], score: e[3], category: "neutral" })),
    ...avoidEntries.map(e  => ({ title: e[0], note: e[1], tags: e[2], score: e[3], category: "avoid"   })),
];

// Chrome 56 has Fetch but no AbortController. Use XHR there so cancelling a
// filter change or timing out a request still stops the underlying network I/O.
function createCoverRequest(body, url = "https://graphql.anilist.co") {
    const native = typeof AbortController === "function" ? new AbortController() : null;
    const control = {
        signal: native ? native.signal : { aborted: false },
        xhr: null,
        abort() {
            if (native) native.abort();
            else this.signal.aborted = true;
            if (this.xhr) this.xhr.abort();
        },
    };
    if (native && typeof fetch === "function") {
        control.promise = Promise.resolve().then(() => fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            credentials: "omit",
            body,
            signal: native.signal,
        }));
    } else {
        control.promise = new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            control.xhr = xhr;
            xhr.open("POST", url, true);
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.setRequestHeader("Accept", "application/json");
            xhr.onload = () => resolve({
                status: xhr.status,
                ok: xhr.status >= 200 && xhr.status < 300,
                headers: { get: name => xhr.getResponseHeader(name) },
                json: () => Promise.resolve().then(() => JSON.parse(xhr.responseText)),
            });
            xhr.onerror = () => reject(new Error("Network error"));
            xhr.onabort = () => reject(new Error("Request aborted"));
            xhr.send(body);
        });
    }
    return control;
}

// Chrome 51–57 implements intersectionRatio without isIntersecting.
function isVisibleIntersection(entry) {
    return typeof entry.isIntersecting === "boolean" ? entry.isIntersecting : entry.intersectionRatio > 0;
}

function scrollToTop() {
    if ("scrollBehavior" in document.documentElement.style) window.scrollTo({ top: 0, behavior: "smooth" });
    else window.scrollTo(0, 0);
}

// =============================================================================
// IMAGE LOADER
// =============================================================================
class ImageLoader {
    constructor() {
        this._cache = new Map();
        this._badURLs = new Map();
        this._hosts = new Map();
        this._providers = {};
        Object.keys(CoverSearch.providers).forEach(name => {
            this._providers[name] = { busy: false, controller: null, lastFetch: 0, pauseUntil: 0, interval: 0, failures: 0 };
        });
        this._queue = [];
        this._states = [];
        this._data = [];
        this._records = [];
        this._gen = 0;
        this._timer = this._frame = null;
        this._imageTimers = new Map();
        this._activeImages = new Map();
        this._restoreCache();
    }

    reset(data) {
        this._gen++;
        clearTimeout(this._timer);
        clearTimeout(this._frame);
        Object.values(this._providers).forEach(source => {
            if (source.controller) source.controller.abort();
            source.controller = null;
            source.busy = false;
        });
        this._activeImages.forEach(image => {
            image.onload = image.onerror = null;
            image.removeAttribute("src");
        });
        this._imageTimers.forEach(timer => clearTimeout(timer));
        this._imageTimers.clear();
        this._activeImages.clear();
        this._timer = this._frame = null;
        this._queue = [];
        this._data = data;
        this._states = data.map(() => "idle");
        this._records = data.map(entry => this._newRecord(entry.title));
    }

    _newRecord(title) {
        const tasks = [];
        CoverSearch.queries(title).forEach(query => ImageLoader.SOURCES.forEach(provider => {
            tasks.push({ provider, query, retries: 0, readyAt: 0, done: false });
        }));
        const cached = this._cache.get(title);
        const image = cached && cached.expires > Date.now() ? { url: cached.url, provider: cached.provider || "cache" } : null;
        if (!image) this._cache.delete(title);
        return { tasks, images: image ? [image] : [], seen: new Set(image ? [image.url] : []), tried: new Set(), hadMatch: !!image, errors: 0 };
    }

    start() {
        const gen = this._gen;
        // A timer also runs when the tab is in the background. No viewport event
        // or animation frame is required to start and finish preloading.
        this._frame = setTimeout(() => {
            if (this._gen !== gen) return;
            this._frame = null;
            this._data.forEach((entry, index) => this._enqueue(index));
            this.reprioritize();
            this._kick();
        }, 0);
    }

    _restoreCache() {
        try {
            const records = JSON.parse(localStorage.getItem(ImageLoader.CACHE_KEY));
            if (Array.isArray(records)) records.slice(-ImageLoader.CACHE_LIMIT).forEach(record => {
                if (!Array.isArray(record) || record.length !== 2) return;
                const [title, value] = record;
                if (typeof title === "string" && value && typeof value.url === "string" && value.url.startsWith("https://")
                    && Number.isFinite(value.expires) && value.expires > Date.now()) this._cache.set(title, value);
            });
        } catch (error) { /* Storage is optional. */ }
        try {
            const records = JSON.parse(localStorage.getItem(ImageLoader.BAD_CACHE_KEY));
            if (Array.isArray(records)) records.slice(-ImageLoader.BAD_CACHE_LIMIT).forEach(record => {
                if (Array.isArray(record) && typeof record[0] === "string" && Number.isFinite(record[1]) && record[1] > Date.now()) this._badURLs.set(record[0], record[1]);
            });
        } catch (error) { /* Bad cache data must not stop cover loading. */ }
    }

    _saveCache() {
        try {
            localStorage.setItem(ImageLoader.CACHE_KEY, JSON.stringify([...this._cache].filter(([, value]) => value.url.startsWith("https://"))));
            localStorage.setItem(ImageLoader.BAD_CACHE_KEY, JSON.stringify([...this._badURLs].filter(([url, expires]) => url.startsWith("https://") && expires > Date.now())));
        } catch (error) { /* In-memory caches work even when storage is blocked/full. */ }
    }

    _enqueue(index) {
        if (this._states[index] !== "idle") return;
        this._queueRecord(index);
    }

    _queueRecord(index) {
        this._states[index] = "queued";
        if (!this._queue.some(job => job.index === index)) this._queue.push({ index });
        this._kick();
    }

    reprioritize() {
        this._sortQueue();
        this._kick();
    }

    _sortQueue() {
        const center = window.scrollY + window.innerHeight / 2;
        const scores = [];
        this._queue.forEach(({ index }) => { scores[index] = this._priorityScore(index, center); });
        this._queue.sort((a, b) => scores[b.index] - scores[a.index] || a.index - b.index);
    }

    _priorityScore(index, center) {
        const card = document.getElementById(`card-${index}`);
        if (!card) return -Infinity;
        const rect = card.getBoundingClientRect();
        const visible = rect.bottom > 0 && rect.top < window.innerHeight;
        const nearby = rect.bottom > -window.innerHeight && rect.top < window.innerHeight * 2;
        return (visible ? 1e9 : nearby ? 1e8 : 0) - Math.abs(rect.top + window.scrollY + rect.height / 2 - center);
    }

    _host(url) {
        try {
            const name = new URL(url).hostname;
            if (!name) return null;
            if (!this._hosts.has(name)) this._hosts.set(name, { failures: 0, pauseUntil: 0 });
            return this._hosts.get(name);
        } catch (error) { return null; }
    }

    _bad(url) {
        const expires = this._badURLs.get(url) || 0;
        if (expires > Date.now()) return true;
        this._badURLs.delete(url);
        return false;
    }

    _images(record) {
        return record.images.filter(image => !record.tried.has(image.url) && !this._bad(image.url));
    }

    _interval(provider) {
        return Math.max(provider === "anilist" ? ImageLoader.MIN_INTERVAL : ImageLoader.SECONDARY_INTERVAL, this._providers[provider].interval);
    }

    _taskTime(task) {
        const source = this._providers[task.provider];
        return source.busy ? Infinity : Math.max(task.readyAt, source.pauseUntil, source.lastFetch + this._interval(task.provider));
    }

    _kick() {
        if (this._timer !== null || !this._queue.length) return;
        let next = Infinity;
        const now = Date.now();
        this._queue.forEach(({ index }) => {
            if (this._states[index] !== "queued") return;
            const record = this._records[index];
            const images = this._images(record);
            if (record.tried.size < ImageLoader.MAX_IMAGE_ATTEMPTS) {
                const ready = images.some(image => { const host = this._host(image.url); return !host || host.pauseUntil <= now; });
                if (ready) {
                    if (this._activeImages.size < ImageLoader.IMAGE_CONCURRENCY) next = now;
                    return;
                }
                if (this._activeImages.size < ImageLoader.IMAGE_CONCURRENCY) images.forEach(image => {
                    const host = this._host(image.url);
                    next = Math.min(next, host ? host.pauseUntil : now);
                });
            }
            record.tasks.filter(task => !task.done).forEach(task => { next = Math.min(next, this._taskTime(task)); });
            if ((!images.length || record.tried.size >= ImageLoader.MAX_IMAGE_ATTEMPTS) && record.tasks.every(task => task.done)) next = now;
        });
        if (Number.isFinite(next)) this._timer = setTimeout(() => this._process(), Math.min(60000, Math.max(0, next - now)));
    }

    _process() {
        this._timer = null;
        this._sortQueue();
        const batches = {};
        ImageLoader.SOURCES.forEach(provider => { batches[provider] = []; });
        const now = Date.now();
        for (const { index } of this._queue) {
            if (this._states[index] !== "queued") continue;
            const record = this._records[index];
            if (record.tried.size >= ImageLoader.MAX_IMAGE_ATTEMPTS) { this._fail(index, "Cover could not be downloaded"); continue; }
            const images = this._images(record);
            const image = images.find(candidate => { const host = this._host(candidate.url); return !host || host.pauseUntil <= now; });
            if (image) {
                if (this._activeImages.size < ImageLoader.IMAGE_CONCURRENCY) this._applyImage(index, image);
                continue;
            }
            const task = record.tasks.find(candidate => !candidate.done && this._taskTime(candidate) <= now && batches[candidate.provider].length < ImageLoader.BATCH_SIZE);
            if (task) {
                this._states[index] = "loading";
                this._setSpinner(index, "Finding cover…");
                batches[task.provider].push({ index, task, title: this._data[index].title });
            } else if (!images.length && record.tasks.every(candidate => candidate.done)) {
                this._fail(index, record.hadMatch ? "Cover could not be downloaded" : record.errors ? "Cover services unavailable" : "No cover found");
            }
        }
        this._queue = this._queue.filter(job => this._states[job.index] === "queued");
        const gen = this._gen;
        Object.keys(batches).forEach(provider => {
            const jobs = batches[provider];
            if (!jobs.length) return;
            const source = this._providers[provider];
            source.busy = true;
            const finished = () => {
                if (this._gen !== gen) return;
                source.busy = false;
                this._kick();
            };
            this._fetchBatch(provider, jobs, gen).catch(() => {
                if (this._gen === gen) jobs.forEach(job => this._queryFailure(job, true));
            }).then(finished, finished);
        });
        this._kick();
    }

    _normalizeTitle(title) { return CoverSearch.normalize(title); }

    _rateLimitDelay(headers) {
        const raw = (headers.get("Retry-After") || "").trim();
        const seconds = raw ? Number(raw) : NaN;
        const retryAfter = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(raw) - Date.now();
        const reset = Number(headers.get("X-RateLimit-Reset")) * 1000 - Date.now();
        const delays = [retryAfter, reset].filter(value => Number.isFinite(value) && value >= 0);
        return delays.length ? Math.max(...delays) : ImageLoader.RATE_LIMIT_PAUSE;
    }

    _queryFailure(job, transient, delay = ImageLoader.ERROR_PAUSE, skipProvider = false) {
        const record = this._records[job.index];
        record.errors++;
        if (!transient || job.task.retries >= ImageLoader.MAX_RETRIES || skipProvider) {
            record.tasks.forEach(task => { if (task.provider === job.task.provider) task.done = true; });
        } else {
            job.task.readyAt = Date.now() + delay * 2 ** job.task.retries;
            job.task.retries++;
        }
        this._queueRecord(job.index);
    }

    async _fetchBatch(provider, jobs, gen) {
        const source = this._providers[provider];
        source.lastFetch = Date.now();
        const controller = createCoverRequest(CoverSearch.request(provider, jobs), CoverSearch.providers[provider].url);
        source.controller = controller;
        const timeout = setTimeout(() => controller.abort(), ImageLoader.REQUEST_TIMEOUT);
        try {
            const response = await controller.promise;
            if (this._gen !== gen) return;
            const limit = Number(response.headers.get("X-RateLimit-Limit"));
            if (Number.isFinite(limit) && limit >= 1) source.interval = Math.ceil(60000 / limit) + 100;
            if (response.headers.get("X-RateLimit-Remaining") === "0" || response.status === 429) {
                source.pauseUntil = Math.max(source.pauseUntil, Date.now() + this._rateLimitDelay(response.headers));
            }
            if (!response.ok) {
                source.failures++;
                if (source.failures >= 3 || response.status === 403) source.pauseUntil = Math.max(source.pauseUntil, Date.now() + ImageLoader.SERVICE_PAUSE);
                jobs.forEach(job => this._queryFailure(job, response.status === 429 || response.status >= 500 || response.status === 408));
                return;
            }
            const json = await response.json();
            if (this._gen !== gen) return;
            source.failures = 0;
            jobs.forEach((job, index) => {
                const result = CoverSearch.result(provider, json, `c${index}`, job.title);
                if (result.error) {
                    const status = Number(result.error.status || (result.error.extensions || {}).status);
                    if (status === 429) source.pauseUntil = Math.max(source.pauseUntil, Date.now() + this._rateLimitDelay(response.headers));
                    this._queryFailure(job, ![400, 401, 403, 404].includes(status));
                    return;
                }
                job.task.done = true;
                const record = this._records[job.index];
                record.hadMatch = record.hadMatch || result.matched;
                result.images.forEach(image => {
                    if (!record.seen.has(image.url)) { record.seen.add(image.url); record.images.push(image); }
                });
                this._queueRecord(job.index);
            });
        } catch (error) {
            if (this._gen !== gen) return;
            source.failures++;
            if (source.failures >= 3) source.pauseUntil = Math.max(source.pauseUntil, Date.now() + ImageLoader.SERVICE_PAUSE);
            jobs.forEach(job => this._queryFailure(job, true));
        } finally {
            clearTimeout(timeout);
            if (source.controller === controller) source.controller = null;
        }
    }

    _fail(index, message) {
        this._states[index] = "error";
        const spinner = document.getElementById(`spinner-${index}`);
        if (!spinner) return;
        const gen = this._gen;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "image-retry";
        button.textContent = "Retry cover";
        button.setAttribute("aria-label", `Retry cover for ${this._data[index].title}`);
        button.onclick = event => {
            event.stopPropagation();
            if (this._gen !== gen || this._states[index] !== "error") return;
            this._records[index].seen.forEach(url => {
                this._badURLs.delete(url);
                const host = this._host(url);
                if (host) { host.failures = 0; host.pauseUntil = 0; }
            });
            this._saveCache();
            this._records[index] = this._newRecord(this._data[index].title);
            this._setSpinner(index, "Waiting…");
            this._queueRecord(index);
        };
        spinner.textContent = message;
        spinner.appendChild(button);
    }

    _setSpinner(index, text) {
        const spinner = document.getElementById(`spinner-${index}`);
        if (spinner) { spinner.textContent = text; spinner.style.display = "flex"; }
    }

    _applyImage(index, candidate) {
        const img = document.getElementById(`img-${index}`);
        const spinner = document.getElementById(`spinner-${index}`);
        if (!img || !spinner) { this._states[index] = "error"; return; }
        const gen = this._gen;
        const title = this._data[index].title;
        const record = this._records[index];
        record.tried.add(candidate.url);
        this._states[index] = "loading";
        this._activeImages.set(index, img);
        this._setSpinner(index, "Loading cover…");
        const cleanup = () => {
            clearTimeout(this._imageTimers.get(index));
            this._imageTimers.delete(index);
            this._activeImages.delete(index);
            img.onload = img.onerror = null;
        };
        const failed = () => {
            if (this._gen !== gen) return;
            cleanup();
            const host = this._host(candidate.url);
            if (host && ++host.failures >= 3) host.pauseUntil = Date.now() + ImageLoader.HOST_PAUSE;
            this._badURLs.set(candidate.url, Date.now() + ImageLoader.BAD_CACHE_TTL);
            while (this._badURLs.size > ImageLoader.BAD_CACHE_LIMIT) this._badURLs.delete(this._badURLs.keys().next().value);
            this._cache.delete(title);
            this._saveCache();
            img.removeAttribute("src");
            img.style.display = "none";
            this._setSpinner(index, "Trying another cover…");
            this._queueRecord(index);
        };
        img.onload = () => {
            if (this._gen !== gen) return;
            if (!img.naturalWidth) { failed(); return; }
            cleanup();
            const host = this._host(candidate.url);
            if (host) { host.failures = 0; host.pauseUntil = 0; }
            img.style.display = "block";
            spinner.style.display = "none";
            this._states[index] = "done";
            this._badURLs.delete(candidate.url);
            this._cache.delete(title);
            this._cache.set(title, { url: candidate.url, provider: candidate.provider, expires: Date.now() + ImageLoader.CACHE_TTL });
            while (this._cache.size > ImageLoader.CACHE_LIMIT) this._cache.delete(this._cache.keys().next().value);
            this._saveCache();
            const container = img.closest(".card-img-container");
            if (container) container.style.backgroundColor = "transparent";
            this._kick();
        };
        img.onerror = failed;
        this._imageTimers.set(index, setTimeout(failed, ImageLoader.IMAGE_TIMEOUT));
        img.src = candidate.url;
    }
}

ImageLoader.SOURCES = ["anilist", "shikimori"];
ImageLoader.MIN_INTERVAL = CoverSearch.providers.anilist.interval;
ImageLoader.SECONDARY_INTERVAL = CoverSearch.providers.shikimori.interval;
ImageLoader.BATCH_SIZE = 10;
ImageLoader.RATE_LIMIT_PAUSE = 60000;
ImageLoader.SERVICE_PAUSE = 30000;
ImageLoader.HOST_PAUSE = 30000;
ImageLoader.IMAGE_CONCURRENCY = 6;
ImageLoader.MAX_IMAGE_ATTEMPTS = 8;
ImageLoader.CACHE_KEY = "vanilla-list:covers:v2";
ImageLoader.CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
ImageLoader.CACHE_LIMIT = 500;
ImageLoader.BAD_CACHE_KEY = "vanilla-list:failed-covers:v1";
ImageLoader.BAD_CACHE_TTL = 30 * 60 * 1000;
ImageLoader.BAD_CACHE_LIMIT = 1000;
ImageLoader.ERROR_PAUSE = 1000;
ImageLoader.REQUEST_TIMEOUT = 10000;
ImageLoader.IMAGE_TIMEOUT = 15000;
ImageLoader.MAX_RETRIES = 2;

const loader = new ImageLoader();
let _scrollTimer;
window.addEventListener("scroll", () => {
    clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(() => loader.reprioritize(), 60);
}, { passive: true });
window.addEventListener("resize", () => loader.reprioritize());

// =============================================================================
// FILTER STATE
// =============================================================================
let activeTags      = new Set();
let activeScores    = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
let currentSearch   = "";
let currentSort     = "score_desc";
let currentTagLogic = "any";
let activeCategory  = "all";
let currentData     = [];
let _highlightedCard = null;
let _highlightTimer  = null;
let _highlightObserver = null;

const grid                  = document.getElementById("anime-grid");
const searchInput           = document.getElementById("searchInput");
const sortSelect            = document.getElementById("sortSelect");
const scoreTogglesContainer = document.getElementById("scoreToggles");
const filterTagsContainer   = document.getElementById("filterTags");
const scrollTopBtn          = document.getElementById("scrollTopBtn");

// =============================================================================
// UI CONTROLS
// =============================================================================
function toggleAdvanced() {
    const content = document.getElementById("advancedFilters");
    const toggle  = document.querySelector(".advanced-toggle");
    content.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(content.classList.contains("open")));
    toggle.textContent = content.classList.contains("open")
        ? "⚙️ Advanced Filters & Sorting ▲"
        : "⚙️ Advanced Filters & Sorting ▼";
}

function resetFilters() {
    activeTags.clear();
    currentSearch      = "";
    searchInput.value  = "";
    currentSort        = "score_desc";
    sortSelect.value   = currentSort;
    activeScores       = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    activeCategory     = "all";
    document.querySelectorAll(".tag-btn").forEach(b => {
        b.classList.remove("active", "active-avoid");
        b.setAttribute("aria-pressed", "false");
    });
    document.querySelectorAll(".score-btn").forEach(b => {
        b.classList.add("active");
        b.setAttribute("aria-pressed", "true");
    });
    document.querySelectorAll(".cat-btn").forEach(b => {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", String(b.dataset.cat === "all"));
    });
    const allButton = document.querySelector('.cat-btn[data-cat="all"]');
    if (allButton) allButton.classList.add("active");
    document.querySelector('input[name="tagLogic"][value="any"]').checked = true;
    updateDisplay();
}

function setCategory(cat) {
    activeCategory = cat;
    document.querySelectorAll(".cat-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.cat === cat);
        btn.setAttribute("aria-pressed", String(btn.dataset.cat === cat));
    });
    updateDisplay();
}

function initScoreToggles() {
    for (let i = 1; i <= 10; i++) {
        const btn         = document.createElement("button");
        btn.className     = "score-btn active";
        btn.textContent   = i;
        btn.dataset.score = i;
        btn.setAttribute("aria-pressed", "true");
        btn.onclick = () => {
            activeScores.has(i) ? activeScores.delete(i) : activeScores.add(i);
            btn.classList.toggle("active", activeScores.has(i));
            btn.setAttribute("aria-pressed", String(activeScores.has(i)));
            updateDisplay();
        };
        scoreTogglesContainer.appendChild(btn);
    }
}

function initTagFilters() {
    const tagMap = Object.create(null);
    animeData.forEach(a => a.tags.forEach(t => { tagMap[t] = (tagMap[t] || 0) + 1; }));

    Object.keys(tagMap).sort().forEach(tag => {
        const btn       = document.createElement("button");
        btn.className   = "tag-btn";
        btn.textContent = `${tag} (${tagMap[tag]})`;
        btn.dataset.tag = tag;
        btn.setAttribute("aria-pressed", "false");
        btn.onclick = () => {
            if (activeTags.has(tag)) {
                activeTags.delete(tag);
                btn.classList.remove("active", "active-avoid");
            } else {
                activeTags.add(tag);
                const isBad = ["NTR","Rape","Avoid","Appalling","Bad","Sick",
                               "Ultra Sick","Madness","Extreme","Nasty",
                               "Torture","Slavery","Force","Drugs"].includes(tag);
                btn.classList.add(isBad ? "active-avoid" : "active");
            }
            btn.setAttribute("aria-pressed", String(activeTags.has(tag)));
            updateDisplay();
        };
        filterTagsContainer.appendChild(btn);
    });
}

// =============================================================================
// RANDOM
// =============================================================================
function clearHighlight() {
    if (_highlightedCard) _highlightedCard.classList.remove("highlighted");
    clearTimeout(_highlightTimer);
    if (_highlightObserver) _highlightObserver.disconnect();
    _highlightedCard = _highlightTimer = _highlightObserver = null;
}

function randomAnime() {
    if (currentData.length === 0) return;
    clearHighlight();

    const randomIndex = Math.floor(Math.random() * currentData.length);
    const card = document.getElementById(`card-${randomIndex}`);
    if (!card) return;

    if ("scrollBehavior" in document.documentElement.style) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
        const rect = card.getBoundingClientRect();
        window.scrollTo(0, Math.max(0, rect.top + window.scrollY + (rect.height - window.innerHeight) / 2));
    }
    card.classList.add('highlighted');
    _highlightedCard = card;

    const expire = () => {
        _highlightTimer = setTimeout(() => {
            if (_highlightedCard === card) clearHighlight();
        }, 2000);
    };
    if (typeof IntersectionObserver === "undefined") { expire(); return; }
    const observer = new IntersectionObserver(entries => {
        if (_highlightedCard !== card) { observer.disconnect(); return; }
        if (entries.some(isVisibleIntersection)) {
            observer.disconnect();
            _highlightObserver = null;
            expire();
        }
    }, { threshold: 0 });
    _highlightObserver = observer;
    observer.observe(card);
}

// =============================================================================
// SCROLL-TO-TOP BUTTON
// =============================================================================
function updateScrollTopBtn() {
    if (!scrollTopBtn) return;
    const cols = parseInt(getComputedStyle(grid).getPropertyValue("--columns"), 10) || 1;
    const thresholdIndex = cols * 2;
    const sentinel = document.getElementById(`card-${thresholdIndex}`);
    if (!sentinel) {
        scrollTopBtn.classList.remove('visible');
        return;
    }
    const rect = sentinel.getBoundingClientRect();
    const absoluteTop = rect.top + window.scrollY;
    if (window.scrollY >= absoluteTop) {
        scrollTopBtn.classList.add('visible');
    } else {
        scrollTopBtn.classList.remove('visible');
    }
}

window.addEventListener('scroll', updateScrollTopBtn, { passive: true });
window.addEventListener('resize', updateScrollTopBtn);

// =============================================================================
// FILTER & SORT
// =============================================================================
function getFilteredData() {
    let data = [...animeData];

    if (activeCategory !== "all") {
        data = data.filter(a => a.category === activeCategory);
    }
    if (currentSearch) {
        const q = currentSearch.toLowerCase();
        data = data.filter(a =>
            a.title.toLowerCase().includes(q) ||
            a.note.toLowerCase().includes(q)  ||
            a.tags.some(t => t.toLowerCase().includes(q))
        );
    }

    data = data.filter(a => activeScores.has(a.score));

    if (activeTags.size > 0) {
        const tags = [...activeTags];
        data = currentTagLogic === "any"
            ? data.filter(a => tags.some(t  => a.tags.includes(t)))
            : data.filter(a => tags.every(t => a.tags.includes(t)));
    }

    switch (currentSort) {
        case "score_desc": data.sort((a, b) => b.score - a.score);              break;
        case "score_asc":  data.sort((a, b) => a.score - b.score);              break;
        case "title_asc":  data.sort((a, b) => a.title.localeCompare(b.title)); break;
        case "title_desc": data.sort((a, b) => b.title.localeCompare(a.title)); break;
    }
    return data;
}

function updateDisplay() {
    clearTimeout(_searchTimer);
    currentSearch = searchInput.value.trim();
    currentSort   = sortSelect.value;
    const logicRadio = document.querySelector('input[name="tagLogic"]:checked');
    if (logicRadio) currentTagLogic = logicRadio.value;
    currentData = getFilteredData();

    const countEl = document.getElementById('resultCount');
    if (countEl) countEl.textContent = `${currentData.length} / ${animeData.length} entries`;

    renderCards(currentData);
}

let _searchTimer;
searchInput.addEventListener("input", () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(updateDisplay, 150);
});
sortSelect.addEventListener("change",  updateDisplay);
document.querySelectorAll('input[name="tagLogic"]').forEach(radio => radio.addEventListener("change", updateDisplay));

let _copyTimer;
async function copyTitle(title) {
    let copied = false;
    try {
        await navigator.clipboard.writeText(title);
        copied = true;
    } catch (error) {
        // The Clipboard API is absent on some browsers and insecure origins.
        const field = document.createElement("textarea");
        field.value = title;
        field.className = "clipboard-fallback";
        field.setAttribute("readonly", "");
        const focused = document.activeElement;
        const x = window.scrollX, y = window.scrollY;
        document.body.appendChild(field);
        field.select();
        try { copied = document.execCommand("copy"); } catch (error) { /* Show the failure below. */ }
        field.remove();
        if (focused) focused.focus();
        if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
    }
    const status = document.getElementById("copyStatus");
    clearTimeout(_copyTimer);
    status.textContent = copied ? "Title copied" : "Could not copy title. Select the title and copy it manually.";
    status.classList.add("visible");
    _copyTimer = setTimeout(() => status.classList.remove("visible"), 3000);
}

// =============================================================================
// RENDER
// =============================================================================
const TAG_CLASS = {
    Vanilla: "vanilla", Masterpiece: "vanilla", Favorite: "vanilla", Wholesome: "vanilla",
    NTR: "ntr", Force: "ntr", Avoid: "ntr", Rape: "ntr", Revenge: "ntr",
    "Mind Control": "ntr", Slavery: "ntr", Torture: "ntr",
    "Ultra Sick": "ntr", Madness: "ntr", Extreme: "ntr", Nasty: "ntr",
    Harem: "harem", Incest: "harem", MILF: "harem", Loli: "harem",
    Gangbang: "harem", Group: "harem", Yuri: "harem", Catgirls: "harem", Underage: "harem",
    Appalling: "avoid", Bad: "avoid", Boring: "avoid", Nonsense: "avoid", Sick: "avoid",
};

function renderCards(data) {
    clearHighlight();
    loader.reset(data);
    grid.innerHTML = "";

    if (data.length === 0) {
        grid.innerHTML = '<div class="no-results">No results found. Try adjusting your search or filters.</div>';
        updateScrollTopBtn();
        return;
    }

    const fragment = document.createDocumentFragment();

    data.forEach((anime, index) => {
        const card     = document.createElement("div");
        card.className = `card ${anime.tags.includes("Avoid") ? "card-avoid" : "card-wholesome"}`;
        card.id        = `card-${index}`;
        card.style.cursor = 'pointer';
        card.title     = 'Click to copy title';
        card.onclick   = () => copyTitle(anime.title);

        // Keep data out of HTML and attributes so quotes/markup render literally.
        card.innerHTML = `
            <div class="card-img-container" data-index="${index}">
                <div class="loading-spinner" id="spinner-${index}">Waiting…</div>
                <img class="card-img" id="img-${index}" style="display:none;">
                <div class="score-badge"></div>
            </div>
            <div class="card-content">
                <h3 class="card-title"><button type="button" class="copy-title"></button></h3>
                <div class="tags"></div>
                <p class="card-note"></p>
            </div>
        `;
        card.querySelector(".card-img").alt = anime.title;
        card.querySelector(".score-badge").textContent = `★ ${anime.score}`;
        const titleButton = card.querySelector(".copy-title");
        titleButton.textContent = anime.title;
        titleButton.setAttribute("aria-label", `Copy title: ${anime.title}`);
        card.querySelector(".card-note").textContent = anime.note;
        const tags = card.querySelector(".tags");
        for (const tag of anime.tags) {
            const span = document.createElement("span");
            span.className = `tag ${TAG_CLASS[tag] || "mixed"}`;
            span.textContent = tag;
            tags.appendChild(span);
        }
        fragment.appendChild(card);
    });

    grid.appendChild(fragment);
    loader.start();
    updateScrollTopBtn();
}

// =============================================================================
// BOOT
// =============================================================================
initScoreToggles();
initTagFilters();
updateDisplay();
