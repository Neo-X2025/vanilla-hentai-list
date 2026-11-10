// =============================================================================
// DATA
// =============================================================================
const animeData = [
    ...vanillaEntries.map(e => ({ title: e[0], note: e[1], tags: e[2], score: e[3], category: "vanilla" })),
    ...neutralEntries.map(e => ({ title: e[0], note: e[1], tags: e[2], score: e[3], category: "neutral" })),
    ...avoidEntries.map(e  => ({ title: e[0], note: e[1], tags: e[2], score: e[3], category: "avoid"   })),
];

// =============================================================================
// IMAGE LOADER
// =============================================================================
class ImageLoader {
    // Stay below Jikan's per-minute limit as well as its per-second limit.
    static MIN_INTERVAL = 1100;
    static ERROR_PAUSE = 1000;
    static REQUEST_TIMEOUT = 10000;
    static IMAGE_TIMEOUT = 15000;
    static MAX_RETRIES = 2;

    constructor() {
        this._cache = new Map();
        this._queue = [];
        this._states = [];
        this._data = [];
        this._gen = 0;
        this._inFlight = false;
        this._lastFetch = 0;
        this._pauseUntil = 0;
        this._timer = null;
        this._frame = null;
        this._observer = null;
        this._controller = null;
        this._imageTimers = new Map();
    }

    reset(data) {
        this._gen++;
        clearTimeout(this._timer);
        cancelAnimationFrame(this._frame);
        this._controller?.abort();
        this._observer?.disconnect();
        for (const timer of this._imageTimers.values()) clearTimeout(timer);
        this._imageTimers.clear();
        this._timer = this._frame = this._controller = this._observer = null;
        this._inFlight = false;
        this._queue = [];
        this._data = data;
        this._states = data.map(() => "idle");
    }

    start() {
        const gen = this._gen;
        this._frame = requestAnimationFrame(() => {
            if (this._gen !== gen) return;
            this._frame = null;
            if (typeof IntersectionObserver === "undefined") {
                this._data.forEach((_, index) => this._enqueue(index));
                this.reprioritize();
                this._kick();
                return;
            }
            const observer = new IntersectionObserver(entries => {
                if (this._gen !== gen) return;
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    this._enqueue(Number(entry.target.dataset.index));
                    observer.unobserve(entry.target);
                }
                this.reprioritize();
                this._kick();
            }, { rootMargin: "300px" });
            this._observer = observer;
            document.querySelectorAll(".card-img-container").forEach(el => observer.observe(el));
        });
    }

    _enqueue(index) {
        if (this._states[index] !== "idle") return;
        const title = this._data[index]?.title;
        if (this._cache.has(title)) {
            this._applyImage(index, this._cache.get(title));
            return;
        }
        this._states[index] = "queued";
        this._queue.push({ index, retries: 0 });
    }

    reprioritize() {
        const center = window.scrollY + window.innerHeight / 2;
        this._queue.sort((a, b) => this._priorityScore(b.index, center) - this._priorityScore(a.index, center));
    }

    _priorityScore(index, center) {
        const el = document.getElementById(`card-${index}`);
        if (!el) return -Infinity;
        const rect = el.getBoundingClientRect();
        const mid = rect.top + window.scrollY + rect.height / 2;
        const visible = rect.bottom > 0 && rect.top < window.innerHeight;
        return (visible ? 1e9 : 0) - Math.abs(mid - center);
    }

    _kick() {
        if (!this._queue.length || this._timer !== null || this._inFlight) return;
        const wait = Math.max(0, this._pauseUntil - Date.now(), this._lastFetch + ImageLoader.MIN_INTERVAL - Date.now());
        this._timer = setTimeout(() => this._process(), wait);
    }

    _process() {
        this._timer = null;
        while (this._queue.length && this._states[this._queue[0].index] !== "queued") this._queue.shift();
        if (!this._queue.length) return;
        if (Date.now() < Math.max(this._pauseUntil, this._lastFetch + ImageLoader.MIN_INTERVAL)) {
            this._kick();
            return;
        }
        const job = this._queue.shift();
        const gen = this._gen;
        this._states[job.index] = "loading";
        this._inFlight = true;
        this._fetchOne(job).catch(() => {
            if (this._gen === gen) this._retry(job.index, job.retries, "Cover unavailable");
        }).finally(() => {
            if (this._gen !== gen) return;
            this._inFlight = false;
            this._kick();
        });
    }

    async _fetchOne({ index, retries }) {
        const title = this._data[index]?.title;
        if (!title) { this._fail(index, "No cover found"); return; }
        if (this._cache.has(title)) {
            this._applyImage(index, this._cache.get(title), retries);
            return;
        }
        // Replacing punctuation with spaces avoids joining words; keep distinctive long-title suffixes.
        const query = title.normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
        if (!query) { this._fail(index, "No cover found"); return; }
        const params = new URLSearchParams({ q: query, limit: "1", sfw: "false" });
        const controller = new AbortController();
        const gen = this._gen;
        this._controller = controller;
        this._lastFetch = Date.now();
        const timeout = setTimeout(() => controller.abort(), ImageLoader.REQUEST_TIMEOUT);
        this._setSpinner(index, "Loading…");
        let response;
        try {
            response = await fetch(`https://api.jikan.moe/v4/anime?${params}`, { signal: controller.signal });
            if (this._gen !== gen) return;
            if (response.status === 429) {
                const raw = response.headers.get("Retry-After")?.trim();
                const seconds = raw ? Number(raw) : NaN;
                const delay = Number.isFinite(seconds) && seconds >= 0
                    ? seconds * 1000 : Date.parse(raw) - Date.now();
                this._retry(index, retries, "Rate limited", Math.max(
                    ImageLoader.ERROR_PAUSE * 2 ** retries,
                    Number.isFinite(delay) ? delay : 0
                ));
                return;
            }
            if (!response.ok) {
                if (response.status >= 500 || response.status === 408) this._retry(index, retries, `Error ${response.status}`);
                else this._fail(index, `Cover unavailable (${response.status})`);
                return;
            }
            const json = await response.json();
            if (this._gen !== gen) return;
            const images = json?.data?.[0]?.images;
            const imageUrl = images?.jpg?.image_url || images?.jpg?.large_image_url
                || images?.webp?.image_url || images?.webp?.large_image_url;
            if (typeof imageUrl !== "string" || !imageUrl) {
                this._fail(index, "No cover found");
                return;
            }
            this._applyImage(index, imageUrl, retries);
        } catch {
            if (this._gen !== gen) return;
            this._retry(index, retries, controller.signal.aborted ? "Request timed out" : response ? "Bad response" : "Network error");
        } finally {
            clearTimeout(timeout);
            if (this._controller === controller) this._controller = null;
        }
    }

    _retry(index, retries, message, delay = ImageLoader.ERROR_PAUSE * 2 ** retries) {
        this._pauseUntil = Math.max(this._pauseUntil, Date.now() + delay);
        if (retries >= ImageLoader.MAX_RETRIES) {
            this._fail(index, message);
            return;
        }
        this._setSpinner(index, `↻ ${message}`);
        this._states[index] = "queued";
        // A failing entry must not monopolize the front of the queue.
        this._queue.push({ index, retries: retries + 1 });
        this._kick();
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
            this._states[index] = "idle";
            this._setSpinner(index, "Waiting…");
            this._enqueue(index);
            this._kick();
        };
        spinner.replaceChildren(document.createTextNode(message), button);
    }

    _setSpinner(index, text) {
        const el = document.getElementById(`spinner-${index}`);
        if (el) { el.textContent = text; el.style.display = "flex"; }
    }

    _applyImage(index, url, retries = 0) {
        const img = document.getElementById(`img-${index}`);
        const spinner = document.getElementById(`spinner-${index}`);
        if (!img || !spinner) { this._states[index] = "error"; return; }
        const gen = this._gen;
        const title = this._data[index].title;
        this._setSpinner(index, "Loading cover…");
        const cleanup = () => {
            clearTimeout(this._imageTimers.get(index));
            this._imageTimers.delete(index);
            img.onload = img.onerror = null;
        };
        const failed = () => {
            if (this._gen !== gen) return;
            cleanup();
            this._cache.delete(title);
            img.removeAttribute("src");
            img.style.display = "none";
            this._retry(index, retries, "Cover failed to load");
        };
        img.onload = () => {
            if (this._gen !== gen) return;
            cleanup();
            img.style.display = "block";
            spinner.style.display = "none";
            this._states[index] = "done";
            // Cache only images the browser actually loaded successfully.
            this._cache.set(title, url);
            const container = img.closest(".card-img-container");
            if (container) container.style.backgroundColor = "transparent";
        };
        img.onerror = failed;
        this._states[index] = "loading";
        this._imageTimers.set(index, setTimeout(failed, ImageLoader.IMAGE_TIMEOUT));
        img.src = url;
    }
}

const loader = new ImageLoader();
let _scrollTimer;
window.addEventListener("scroll", () => {
    clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(() => loader.reprioritize(), 60);
}, { passive: true });

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
    document.querySelector('.cat-btn[data-cat="all"]')?.classList.add("active");
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
    _highlightedCard?.classList.remove("highlighted");
    clearTimeout(_highlightTimer);
    _highlightObserver?.disconnect();
    _highlightedCard = _highlightTimer = _highlightObserver = null;
}

function randomAnime() {
    if (currentData.length === 0) return;
    clearHighlight();

    const randomIndex = Math.floor(Math.random() * currentData.length);
    const card = document.getElementById(`card-${randomIndex}`);
    if (!card) return;

    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
        if (entries.some(entry => entry.isIntersecting)) {
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
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
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
    } catch {
        // The Clipboard API is absent on some browsers and insecure origins.
        const field = document.createElement("textarea");
        field.value = title;
        field.className = "clipboard-fallback";
        field.setAttribute("readonly", "");
        const focused = document.activeElement;
        document.body.appendChild(field);
        field.select();
        try { copied = document.execCommand("copy"); } catch { /* Show the failure below. */ }
        field.remove();
        focused?.focus({ preventScroll: true });
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
            span.className = `tag ${TAG_CLASS[tag] ?? "mixed"}`;
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
