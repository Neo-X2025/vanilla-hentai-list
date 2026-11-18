const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../cover-search.js'), 'utf8'), context);
const search = vm.runInContext('CoverSearch', context);
const cover = 'https://covers.example/right.jpg';

test('search variants remove wrappers while preserving sequel numbers and Unicode', () => {
    const variants = Array.from(search.queries('Example 2: Café The Animation'));
    assert.ok(variants.includes('Example 2 Café The Animation'));
    assert.ok(variants.includes('Example 2 Café'));
    assert.ok(variants.every(value => value.includes('2')));
    assert.ok(variants.length <= 3);
    assert.equal(search.normalize('東京々〆〇 café—❶'), '東京々〆〇 café ❶');
    assert.deepEqual(Array.from(search.queries('Example')), ['Example']);
});

test('both API requests use variables rather than interpolating title text', () => {
    for (const provider of ['anilist', 'shikimori']) {
        const query = 'title" } mutation { hostile';
        const request = JSON.parse(search.request(provider, [{ task: { query } }]));
        assert.equal(request.variables.q0, query);
        assert.ok(!request.query.includes('hostile'));
        assert.match(request.query, /c0:/);
    }
});

test('matching rejects unrelated first hits and conflicting sequels', () => {
    const result = search.result('anilist', { data: { c0: { media: [
        { title: { romaji: 'Completely unrelated' }, coverImage: { large: 'https://covers.example/wrong.jpg' } },
        { title: { romaji: 'Example 2' }, coverImage: { large: cover } },
    ] } } }, 'c0', 'Example 2 The Animation');
    assert.equal(result.images[0].url, cover);
    const wrong = search.result('anilist', { data: { c0: { media: [{ title: { romaji: 'Example 3' }, coverImage: { large: cover } }] } } }, 'c0', 'Example 2');
    assert.equal(wrong.images.length, 0);
});

test('localized aliases, spacing and small romanization differences can match', () => {
    assert.ok(search.similarity('Mushishi', 'Mushi-shi') >= 0.99);
    assert.ok(search.similarity('Yuujinchou', 'Yujinchou') >= 0.86);
    const result = search.result('shikimori', { data: { c0: [{ name: 'Romanized Name', english: 'English Name', poster: { originalUrl: cover } }] } }, 'c0', 'English Name');
    assert.equal(result.images[0].url, cover);
});

test('a short catalogue title finds its closest subtitle rather than the first movie', () => {
    assert.ok(search.similarity('Kino no Tabi', 'Kino no Tabi：The Beautiful World') >= 0.9);
    const result = search.result('shikimori', { data: { c0: [
        { name: 'Kino no Tabi: The Beautiful World - For You', kind: 'movie', poster: { originalUrl: 'https://covers.example/movie.jpg' } },
        { name: 'Kino no Tabi: The Beautiful World - The Animated Series', kind: 'tv', poster: { originalUrl: 'https://covers.example/remake.jpg' } },
        { name: 'Kino no Tabi: The Beautiful World', kind: 'tv', poster: { originalUrl: cover } },
    ] } }, 'c0', 'Kino no Tabi');
    assert.equal(result.images[0].url, cover);
});

test('movie wrappers do not silently select a TV series', () => {
    const result = search.result('anilist', { data: { c0: { media: [{ title: { romaji: 'Example' }, format: 'TV', coverImage: { large: cover } }] } } }, 'c0', 'Example The Movie');
    assert.equal(result.images.length, 0);
});

test('all usable poster sizes are kept in download order and duplicates removed', () => {
    const result = search.result('anilist', { data: { c0: { media: [{ title: { romaji: 'Example' }, coverImage: { large: cover, medium: 'https://covers.example/small.jpg', extraLarge: cover } }] } } }, 'c0', 'Example');
    assert.deepEqual(Array.from(result.images, entry => entry.url), [cover, 'https://covers.example/small.jpg']);
});

test('placeholder, empty and unsafe URLs are excluded and relative posters resolved', () => {
    for (const value of [null, '', 'javascript:alert(1)', 'data:text/html;base64,AAAA', 'https://covers.example/missing_original.jpg', 'https://covers.example/default.jpg']) {
        assert.equal(search.imageURL(value, 'anilist'), null);
    }
    assert.equal(search.imageURL('/uploads/poster.jpg', 'shikimori'), 'https://shikimori.io/uploads/poster.jpg');
});

test('partial errors remain associated with their requested alias', () => {
    const json = { data: { c0: null, c1: [] }, errors: [{ path: ['c0'], status: 503 }] };
    assert.equal(search.result('shikimori', json, 'c0', 'First').error.status, 503);
    assert.equal(search.result('shikimori', json, 'c1', 'Second').images.length, 0);
});
