// Shared search/matching rules. Keep this classic script compatible with Chrome 56.
const CoverSearch = (() => {
    const providers = {
        anilist: { url: "https://graphql.anilist.co", interval: 2100 },
        shikimori: { url: "https://shikimori.io/api/graphql", interval: 750 },
    };
    function normalize(title) {
        return title.normalize("NFKC").replace(/[\u0000-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u00BF\u2000-\u206F\u2600-\u2775\u2794-\u27BF\u3000-\u3004\u3008-\u3020\u302A-\u3030\u3036-\u3037\u303D-\u303F\u30FB]+/g, " ").replace(/\s+/g, " ").trim();
    }
    function fold(title) { return normalize(title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")).toLowerCase(); }
    function base(title) { return title.replace(/(?:\s+(?:the\s+)?(?:animation|movie|ova|series))+$/i, "").trim(); }
    function queries(title) {
        const full = normalize(title);
        const prefix = title.split(/[:\uFF1A]/)[0];
        const values = [full, base(full), fold(full), normalize(title.replace(/\([^)]*\)|\[[^\]]*\]/g, ""))];
        if (prefix.length >= 7 && prefix !== title) values.push(normalize(prefix));
        values.push(title.normalize("NFKC").trim());
        const seen = new Set();
        return values.filter(value => {
            const key = value.toLowerCase();
            if (!value || seen.has(key)) return false;
            seen.add(key);
            return true;
        }).slice(0, 3);
    }
    function distance(a, b) {
        let row = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
            const next = [i];
            for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            row = next;
        }
        return row[b.length];
    }
    function numbers(title) {
        const values = title.match(/\d+/g) || [];
        const roman = /\s(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i.exec(title);
        if (roman) values.push(String(['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'].indexOf(roman[1].toLowerCase()) + 1));
        return values.join(",");
    }
    function similarity(expected, candidate) {
        const a = fold(expected), b = fold(candidate);
        if (!a || !b) return 0;
        if (a === b || a.replace(/\s/g, "") === b.replace(/\s/g, "")) return 1;
        if (numbers(a) !== numbers(b)) return 0;
        const x = base(a), y = base(b);
        if (x === y || x.replace(/\s/g, "") === y.replace(/\s/g, "")) return 0.98;
        const prefix = fold(candidate.split(/[:\uFF1A]/)[0]);
        if (/[:\uFF1A]/.test(candidate) && prefix === x && x.length >= 7 && x.split(" ").length >= 2) {
            return 0.9 + 0.05 * (x.length / b.length);
        }
        const compactA = x.replace(/\s/g, ""), compactB = y.replace(/\s/g, "");
        if (Math.min(compactA.length, compactB.length) < 6) return 0;
        const edit = 1 - distance(compactA, compactB) / Math.max(compactA.length, compactB.length);
        const at = new Set(x.split(" ")), bt = new Set(y.split(" "));
        const common = [...at].filter(word => bt.has(word)).length;
        return Math.max(edit * 0.99, 0.85 * (2 * common / (at.size + bt.size)) + 0.15 * edit);
    }
    function imageURL(value, provider) {
        if (typeof value !== "string" || !value.trim()) return null;
        if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value)) return value;
        try {
            const url = new URL(value.trim(), providers[provider].url);
            if (url.protocol === "http:") url.protocol = "https:";
            if (url.protocol !== "https:" || /(?:^|[/_.-])(?:missing|default|placeholder|no[-_]?image)(?:[/_.-]|$)/i.test(url.pathname)) return null;
            return url.href;
        } catch (error) { return null; }
    }
    function request(provider, jobs) {
        const variables = {};
        const definitions = jobs.map((job, i) => { variables[`q${i}`] = job.task.query; return `$q${i}: String`; }).join(", ");
        const fields = jobs.map((job, i) => provider === "anilist"
            ? `c${i}: Page(page:1, perPage:5) { media(search:$q${i}, type:ANIME) { id idMal format title { romaji english native } synonyms coverImage { large medium extraLarge } } }`
            : `c${i}: animes(search:$q${i}, limit:5, censored:false) { id malId kind name english russian synonyms poster { originalUrl mainUrl previewUrl } }`).join("\n");
        return JSON.stringify({ query: `query (${definitions}) { ${fields} }`, variables });
    }
    function result(provider, json, alias, title) {
        const errors = json && Array.isArray(json.errors) ? json.errors : [];
        const error = errors.find(entry => entry && entry.path && entry.path[0] === alias) || errors.find(entry => entry && (!entry.path || !entry.path.length));
        const slot = json && json.data && json.data[alias];
        const entries = provider === "anilist" ? slot && slot.media : slot;
        if (!Array.isArray(entries)) return { error: error || { status: 500 } };
        let best = null, bestScore = 0;
        for (const entry of entries) {
            if (!entry || typeof entry !== "object") continue;
            const aliases = provider === "anilist" ? Object.values(entry.title || {}) : [entry.name, entry.english, entry.russian];
            if (Array.isArray(entry.synonyms)) aliases.push(...entry.synonyms);
            const score = Math.max(0, ...aliases.filter(value => typeof value === "string").map(value => similarity(title, value)));
            const movie = /\bmovie\b/i.test(title);
            const format = entry.format || entry.kind || "";
            if (score < 1 && ((movie && /^(?:TV|TV_SHORT)$/i.test(format)) || (!movie && /^movie$/i.test(format)))) continue;
            if (score >= 0.86 && score > bestScore) { best = entry; bestScore = score; }
        }
        if (!best) return error ? { error } : { images: [] };
        const cover = (provider === "anilist" ? best.coverImage : best.poster) || {};
        const urls = provider === "anilist" ? [cover.large, cover.medium, cover.extraLarge] : [cover.originalUrl, cover.mainUrl, cover.previewUrl];
        const images = urls.map(value => imageURL(value, provider)).filter((value, i, values) => value && values.indexOf(value) === i)
            .map(url => ({ url, provider }));
        return { images, matched: true, score: bestScore };
    }
    return { providers, normalize, queries, similarity, imageURL, request, result };
})();
