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
    static MIN_INTERVAL  = 500;
    static ERROR_PAUSE   = 1000;

    constructor() {
        this._cache      = new Map();
        this._queue      = [];
        this._states     = [];
        this._data       = [];
        this._gen        = 0;
        this._inFlight   = false;
        this._lastFetch  = 0;
        this._pauseUntil = 0;
        this._timer      = null;
        this._observer   = null;
    }

    reset(data) {
        this._gen++;
        clearTimeout(this._timer);
        this._timer    = null;
        this._inFlight = false;
        this._queue    = [];
        this._data     = data;
        this._states   = data.map(() => "idle");
        if (this._observer) this._observer.disconnect();
    }

    seedAll() {
        requestAnimationFrame(() => {
            this._setupObserver();
            const center = window.scrollY + window.innerHeight / 2;
            const scored = this._data.map((_, i) => ({
                index: i,
                score: this._priorityScore(i, center),
            }));
            scored.sort((a, b) => b.score - a.score);
            for (const { index } of scored) this._enqueue(index);
            this._kick();
        });
    }

    _enqueue(index) {
        if (this._states[index] !== "idle") return;
        const title = this._data[index]?.title;
        if (title && this._cache.has(title)) {
            this._applyImage(index, this._cache.get(title));
            return;
        }
        this._states[index] = "queued";
        this._queue.push({ index, retries: 0 });
    }

    reprioritize() {
        const center = window.scrollY + window.innerHeight / 2;
        this._queue.sort((a, b) =>
            this._priorityScore(b.index, center) - this._priorityScore(a.index, center)
        );
    }

    _priorityScore(index, center) {
        const el = document.getElementById(`card-${index}`);
        if (!el) return -Infinity;
        const mid  = el.offsetTop + el.offsetHeight / 2;
        const dist = Math.abs(mid - center);
        const visBonus = this._states[index] === "queued" && el.getBoundingClientRect().top < window.innerHeight ? 1e9 : 0;
        return visBonus - dist;
    }

    _kick() {
        if (this._timer !== null || this._inFlight) return;
        const now   = Date.now();
        const wait  = Math.max(0, this._pauseUntil - now, this._lastFetch + ImageLoader.MIN_INTERVAL - now);
        this._timer = setTimeout(() => this._process(), wait);
    }

    _process() {
        this._timer = null;
        while (this._queue.length > 0 && this._states[this._queue[0].index] !== "queued") {
            this._queue.shift();
        }
        if (this._queue.length === 0) return;

        const now = Date.now();
        if (now < this._pauseUntil) {
            this._timer = setTimeout(() => this._process(), this._pauseUntil - now + 10);
            return;
        }

        const job = this._queue.shift();
        this._states[job.index] = "loading";
        this._inFlight  = true;
        this._lastFetch = Date.now();

        const gen = this._gen;
        this._fetchOne(job).then(() => {
            if (this._gen !== gen) return;
            this._inFlight = false;
            this._kick();
        });
    }

    async _fetchOne(job) {
        const { index, retries } = job;
        const title = this._data[index]?.title;
        if (!title) { this._states[index] = "error"; return; }

        const gen = this._gen;
        if (this._cache.has(title)) {
            if (this._gen === gen) this._applyImage(index, this._cache.get(title));
            return;
        }

        this._setSpinner(index, "Loading…");
        const query = title.replace(/[^\p{L}\p{N}\s]/gu, "").substring(0, 40).trim();
        const url   = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1&sfw=false`;

        let response;
        try {
            response = await fetch(url);
        } catch (err) {
            if (this._gen !== gen) return;
            this._retry(index, retries, "Network error");
            return;
        }

        if (this._gen !== gen) return;

        const retryAfterRaw = response.headers.get("Retry-After");
        if (retryAfterRaw) {
            const secs = parseInt(retryAfterRaw, 10);
            if (secs > 0) this._pauseUntil = Math.max(this._pauseUntil, Date.now() + secs * 1000);
        }

        if (response.status === 429) {
            if (!retryAfterRaw) this._pauseUntil = Math.max(this._pauseUntil, Date.now() + ImageLoader.MIN_INTERVAL);
            this._states[index] = "queued";
            this._queue.unshift({ index, retries });
            this._setSpinner(index, "Rate limited…");
            return;
        }

        if (!response.ok) {
            this._retry(index, retries, `Error ${response.status}`);
            return;
        }

        let json;
        try {
            json = await response.json();
        } catch {
            this._retry(index, retries, "Bad response");
            return;
        }

        if (this._gen !== gen) return;

        const imageUrl = json?.data?.[0]?.images?.jpg?.image_url;
        if (!imageUrl) {
            this._retry(index, retries, "No image yet");
            return;
        }

        this._cache.set(title, imageUrl);
        this._applyImage(index, imageUrl);
    }

    _retry(index, retries, spinnerText, pause = true) {
        this._setSpinner(index, `↻ ${spinnerText}`);
        if (pause) this._pauseUntil = Math.max(this._pauseUntil, Date.now() + ImageLoader.ERROR_PAUSE);
        this._states[index] = "queued";
        this._queue.unshift({ index, retries: retries + 1 });
    }

    _setSpinner(index, text) {
        const el = document.getElementById(`spinner-${index}`);
        if (el) el.textContent = text;
    }

    _applyImage(index, url) {
        const img     = document.getElementById(`img-${index}`);
        const spinner = document.getElementById(`spinner-${index}`);
        if (!img || !spinner) { this._states[index] = "error"; return; }

        img.onload = () => {
            img.style.display     = "block";
            spinner.style.display = "none";
            this._states[index]   = "done";
            const container = img.closest('.card-img-container');
            if (container) container.style.backgroundColor = 'transparent';
        };
        img.onerror = () => {
            img.src = "";
            this._retry(index, 0, "Image error");
        };
        img.src = url;
        this._states[index] = "done";
    }

    _setupObserver() {
        if (this._observer) this._observer.disconnect();
        this._observer = new IntersectionObserver((entries) => {
            let anyNew = false;
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const idx = parseInt(entry.target.dataset.index, 10);
                if (this._states[idx] === "idle") {
                    this._enqueue(idx);
                    anyNew = true;
                }
            }
            if (anyNew) {
                this.reprioritize();
                this._kick();
            }
        }, { rootMargin: "300px" });

        document.querySelectorAll(".card-img-container").forEach(el => {
            this._observer.observe(el);
        });
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
    toggle.innerHTML = content.classList.contains("open")
        ? "⚙️ Advanced Filters & Sorting ▲"
        : "⚙️ Advanced Filters & Sorting ▼";
}

function resetFilters() {
    activeTags.clear();
    currentSearch      = "";
    searchInput.value  = "";
    activeScores       = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    activeCategory     = "all";
    document.querySelectorAll(".tag-btn").forEach(b  => b.classList.remove("active", "active-avoid"));
    document.querySelectorAll(".score-btn").forEach(b => b.classList.add("active"));
    document.querySelectorAll(".cat-btn").forEach(b  => b.classList.remove("active"));
    document.querySelector('.cat-btn[data-cat="all"]')?.classList.add("active");
    document.querySelector('input[name="tagLogic"][value="any"]').checked = true;
    updateDisplay();
}

function setCategory(cat) {
    activeCategory = cat;
    document.querySelectorAll(".cat-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.cat === cat);
    });
    updateDisplay();
}

function initScoreToggles() {
    for (let i = 1; i <= 10; i++) {
        const btn         = document.createElement("button");
        btn.className     = "score-btn active";
        btn.textContent   = i;
        btn.dataset.score = i;
        btn.onclick = () => {
            activeScores.has(i) ? activeScores.delete(i) : activeScores.add(i);
            btn.classList.toggle("active", activeScores.has(i));
            updateDisplay();
        };
        scoreTogglesContainer.appendChild(btn);
    }
}

function initTagFilters() {
    const tagMap = {};
    animeData.forEach(a => a.tags.forEach(t => { tagMap[t] = (tagMap[t] || 0) + 1; }));

    Object.keys(tagMap).sort().forEach(tag => {
        const btn       = document.createElement("button");
        btn.className   = "tag-btn";
        btn.textContent = `${tag} (${tagMap[tag]})`;
        btn.dataset.tag = tag;
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
            updateDisplay();
        };
        filterTagsContainer.appendChild(btn);
    });
}

// =============================================================================
// RANDOM
// =============================================================================
function randomAnime() {
    if (currentData.length === 0) return;

    if (_highlightedCard) {
        _highlightedCard.classList.remove('highlighted');
        clearTimeout(_highlightTimer);
        if (_highlightObserver) { _highlightObserver.disconnect(); _highlightObserver = null; }
    }

    const randomIndex = Math.floor(Math.random() * currentData.length);
    const card = document.getElementById(`card-${randomIndex}`);
    if (!card) return;

    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('highlighted');
    _highlightedCard = card;

    _highlightObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                _highlightTimer = setTimeout(() => {
                    card.classList.remove('highlighted');
                    if (_highlightedCard === card) _highlightedCard = null;
                    if (_highlightObserver) { _highlightObserver.disconnect(); _highlightObserver = null; }
                }, 2000);
                if (_highlightObserver) { _highlightObserver.disconnect(); _highlightObserver = null; }
            }
        }
    }, { threshold: 0.5 });

    _highlightObserver.observe(card);
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
    currentSearch = searchInput.value;
    currentSort   = sortSelect.value;
    const logicRadio = document.querySelector('input[name="tagLogic"]:checked');
    if (logicRadio) currentTagLogic = logicRadio.value;
    currentData = getFilteredData();

    const countEl = document.getElementById('resultCount');
    if (countEl) countEl.textContent = `${currentData.length} / ${animeData.length} entries`;

    renderCards(currentData);
}

searchInput.addEventListener("input",  updateDisplay);
sortSelect.addEventListener("change",  updateDisplay);

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
        card.onclick   = () => {
            navigator.clipboard.writeText(anime.title).catch(() => {});
        };

        const tagsHTML = anime.tags
            .map(tag => `<span class="tag ${TAG_CLASS[tag] ?? "mixed"}">${tag}</span>`)
            .join("");

        card.innerHTML = `
            <div class="card-img-container" data-index="${index}">
                <div class="loading-spinner" id="spinner-${index}">Waiting…</div>
                <img class="card-img" id="img-${index}" alt="${anime.title}" style="display:none;">
                <div class="score-badge">★ ${anime.score}</div>
            </div>
            <div class="card-content">
                <h3 class="card-title">${anime.title}</h3>
                <div class="tags">${tagsHTML}</div>
                <p class="card-note">${anime.note}</p>
            </div>
        `;
        fragment.appendChild(card);
    });

    grid.appendChild(fragment);
    loader.seedAll();
    updateScrollTopBtn();
}

// =============================================================================
// BOOT
// =============================================================================
initScoreToggles();
initTagFilters();
updateDisplay();
