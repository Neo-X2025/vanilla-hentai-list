// --- STATE ---
let activeTags = new Set();
let activeScores = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
let currentSearch = "";
let currentSort = "score_desc";
let currentTagLogic = "any";
let imageStates = [];
let currentData = [];
let lastFetchTime = 0;
let isFetching = false;
const NORMAL_INTERVAL = 400;
const RATE_LIMIT_INTERVAL = 1000;

const grid = document.getElementById('anime-grid');
const searchInput = document.getElementById('searchInput');
const sortSelect = document.getElementById('sortSelect');
const scoreTogglesContainer = document.getElementById('scoreToggles');
const filterTagsContainer = document.getElementById('filterTags');

function toggleAdvanced() {
    const content = document.getElementById('advancedFilters');
    const toggle = document.querySelector('.advanced-toggle');
    if (content.classList.contains('open')) {
        content.classList.remove('open');
        toggle.innerHTML = "⚙️ Advanced Filters & Sorting ▼";
    } else {
        content.classList.add('open');
        toggle.innerHTML = "⚙️ Advanced Filters & Sorting ▲";
    }
}

function resetFilters() {
    activeTags.clear();
    currentSearch = "";
    searchInput.value = "";
    activeScores = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    document.querySelectorAll('.tag-btn').forEach(btn => btn.classList.remove('active', 'active-avoid'));
    document.querySelectorAll('.score-btn').forEach(btn => btn.classList.add('active'));
    document.querySelector('input[name="tagLogic"][value="any"]').checked = true;
    updateDisplay();
}

// --- INIT CONTROLS ---
function initScoreToggles() {
    for (let i = 1; i <= 10; i++) {
        const btn = document.createElement('button');
        btn.className = 'score-btn active';
        btn.innerText = i;
        btn.dataset.score = i;
        btn.onclick = () => {
            if (activeScores.has(i)) {
                activeScores.delete(i);
                btn.classList.remove('active');
            } else {
                activeScores.add(i);
                btn.classList.add('active');
            }
            updateDisplay();
        };
        scoreTogglesContainer.appendChild(btn);
    }
}

function initTagFilters() {
    const tagMap = {};
    animeData.forEach(a => a.tags.forEach(t => tagMap[t] = (tagMap[t] || 0) + 1));
    const allTags = Object.keys(tagMap).sort();

    allTags.forEach(tag => {
        const btn = document.createElement('button');
        btn.className = 'tag-btn';
        btn.innerText = `${tag} (${tagMap[tag]})`;
        btn.dataset.tag = tag;
        btn.onclick = () => {
            if (activeTags.has(tag)) {
                activeTags.delete(tag);
                btn.classList.remove('active', 'active-avoid');
            } else {
                activeTags.add(tag);
                if (["NTR", "Rape", "Avoid", "Appalling", "Bad", "Sick", "Ultra Sick", "Madness", "Extreme", "Nasty", "Torture", "Slavery", "Sex Slave"].includes(tag)) {
                    btn.classList.add('active-avoid');
                } else {
                    btn.classList.add('active');
                }
            }
            updateDisplay();
        };
        filterTagsContainer.appendChild(btn);
    });
}

// --- FILTER & SORT LOGIC ---
function getFilteredData() {
    let data = [...animeData];

    if (currentSearch) {
        const q = currentSearch.toLowerCase();
        data = data.filter(a => a.title.toLowerCase().includes(q) || a.note.toLowerCase().includes(q) || a.tags.some(t => t.toLowerCase().includes(q)));
    }

    data = data.filter(a => activeScores.has(a.score));

    if (activeTags.size > 0) {
        if (currentTagLogic === 'any') {
            data = data.filter(a => [...activeTags].some(tag => a.tags.includes(tag)));
        } else {
            data = data.filter(a => [...activeTags].every(tag => a.tags.includes(tag)));
        }
    }

    switch (currentSort) {
        case 'score_desc': data.sort((a, b) => b.score - a.score); break;
        case 'score_asc': data.sort((a, b) => a.score - b.score); break;
        case 'title_asc': data.sort((a, b) => a.title.localeCompare(b.title)); break;
        case 'title_desc': data.sort((a, b) => b.title.localeCompare(a.title)); break;
    }

    return data;
}

function updateDisplay() {
    currentSearch = searchInput.value;
    currentSort = sortSelect.value;
    const logicRadio = document.querySelector('input[name="tagLogic"]:checked');
    if (logicRadio) currentTagLogic = logicRadio.value;

    currentData = getFilteredData();
    renderCards(currentData);
}

searchInput.addEventListener('input', updateDisplay);
sortSelect.addEventListener('change', updateDisplay);

// --- RENDER ---
function renderCards(data) {
    grid.innerHTML = '';
    imageStates = data.map(() => ({ status: 'unloaded', visible: false }));

    if (data.length === 0) {
        grid.innerHTML = '<div class="no-results">No results found. Try adjusting your search or filters.</div>';
        return;
    }

    data.forEach((anime, index) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.id = `card-${index}`;

        const isAvoid = anime.tags.includes('NTR') || anime.tags.includes('Force') || anime.tags.includes('Avoid') || anime.tags.includes('Rape');
        card.classList.add(isAvoid ? 'card-avoid' : 'card-wholesome');

        const tagsHTML = anime.tags.map(tag => {
            let tagClass = 'mixed';
            if (['Vanilla', 'Masterpiece', 'Favorite', 'Wholesome'].includes(tag)) tagClass = 'vanilla';
            else if (['NTR', 'Force', 'Avoid', 'Rape', 'Revenge', 'Mind Control', 'Slavery', 'Torture', 'Ultra Sick', 'Madness', 'Extreme', 'Nasty', 'Sex Slave'].includes(tag)) tagClass = 'ntr';
            else if (['Harem', 'Incest', 'MILF', 'Stepmom', 'Loli', 'Gangbang', 'Group', 'Yuri', 'Catgirls'].includes(tag)) tagClass = 'harem';
            else if (['Appalling', 'Bad', 'Boring', 'Nonsense', 'Sick'].includes(tag)) tagClass = 'avoid';
            return `<span class="tag ${tagClass}">${tag}</span>`;
        }).join('');

        card.innerHTML = `
            <div class="card-img-container" data-index="${index}">
                <div class="loading-spinner" id="spinner-${index}">Waiting...</div>
                <img class="card-img" id="img-${index}" src="" alt="${anime.title}" style="display:none;">
                <div class="score-badge">★ ${anime.score}</div>
            </div>
            <div class="card-content">
                <h3 class="card-title">${anime.title}</h3>
                <div class="tags">${tagsHTML}</div>
                <p class="card-note">${anime.note}</p>
            </div>
        `;
        grid.appendChild(card);

        const imgContainer = card.querySelector('.card-img-container');
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const idx = parseInt(entry.target.dataset.index);
                imageStates[idx].visible = entry.isIntersecting;
            });
        }, { rootMargin: '300px' });
        observer.observe(imgContainer);
    });
}

// --- PRIORITY STATE MACHINE ENGINE ---
function loaderLoop() {
    const now = Date.now();
    let targetIndex = null;
    let requiredInterval = NORMAL_INTERVAL;

    if (!isFetching) {
        const vpRateLimited = imageStates.findIndex(s => s.visible && s.status === 'rate_limited');
        if (vpRateLimited !== -1) {
            targetIndex = vpRateLimited;
            requiredInterval = RATE_LIMIT_INTERVAL;
        } else {
            const outRateLimited = imageStates.findIndex(s => !s.visible && s.status === 'rate_limited');
            if (outRateLimited !== -1) {
                targetIndex = outRateLimited;
                requiredInterval = RATE_LIMIT_INTERVAL;
            } else {
                targetIndex = getNextImageToLoad();
                requiredInterval = NORMAL_INTERVAL;
            }
        }

        if (targetIndex !== null && (now - lastFetchTime >= requiredInterval)) {
            isFetching = true;
            lastFetchTime = now;
            imageStates[targetIndex].status = 'loading';
            fetchImage(currentData[targetIndex].title, targetIndex);
        }
    }
    requestAnimationFrame(loaderLoop);
}

function getNextImageToLoad() {
    const visibleUnloaded = imageStates.findIndex(s => s.visible && s.status === 'unloaded');
    if (visibleUnloaded !== -1) return visibleUnloaded;

    let closestIndex = null;
    let closestDistance = Infinity;
    const viewportCenter = window.innerHeight / 2;

    for (let i = 0; i < imageStates.length; i++) {
        if (imageStates[i].status !== 'unloaded') continue;
        const el = document.getElementById(`card-${i}`);
        if (!el) continue;

        const rect = el.getBoundingClientRect();
        const elCenter = rect.top + rect.height / 2;
        const distance = Math.abs(elCenter - viewportCenter);

        if (distance < closestDistance) {
            closestDistance = distance;
            closestIndex = i;
        }
    }
    return closestIndex;
}

// --- API FETCH ---
async function fetchImage(title, index) {
    const imgElement = document.getElementById(`img-${index}`);
    const spinner = document.getElementById(`spinner-${index}`);
    if (!spinner || !imgElement) { isFetching = false; return; }

    spinner.innerText = 'Loading...';
    const sanitizedTitle = title.replace(/[^\p{L}\p{N}\s]/gu, '').substring(0, 40);

    try {
        const response = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(sanitizedTitle)}&limit=1&sfw=false`);

        if (response.status === 429) {
            spinner.innerText = 'Rate Limited...';
            imageStates[index].status = 'rate_limited';
        } else if (!response.ok) {
            throw new Error('API error');
        } else {
            const data = await response.json();
            if (data.data && data.data.length > 0) {
                const imageUrl = data.data[0].images.jpg.image_url;
                imgElement.src = imageUrl;
                imgElement.onload = () => {
                    imgElement.style.display = 'block';
                    spinner.style.display = 'none';
                    imageStates[index].status = 'loaded';
                };
                imgElement.onerror = () => {
                    spinner.innerText = 'Image Error';
                    imageStates[index].status = 'error';
                };
            } else {
                spinner.innerText = 'No Image Found';
                imageStates[index].status = 'error';
            }
        }
    } catch (error) {
        console.error("Failed to fetch image for " + title, error);
        spinner.innerText = 'Fetch Error';
        imageStates[index].status = 'error';
    } finally {
        isFetching = false;
    }
}

// Initialize
initScoreToggles();
initTagFilters();
updateDisplay();
requestAnimationFrame(loaderLoop);