const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Chromium's branch point for Chrome 56 is revision 433059. This immediately
// following official snapshot identifies itself as Chromium 56.0.2924.0.
const browserURL = 'https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/433062/chrome-linux.zip';
const browserHash = '5e2e38ffbed6ff9bef287026c8d2628b12b5a43b5bf7c235bfa182e7fd5d213f';
const libraries = [
    ['https://deb.debian.org/debian/pool/main/g/gconf/libgconf-2-4_3.2.6-8_amd64.deb', '0fad57869b4074899625e2747afefbf32318224ede8e17c59d0ed2a703d0f095'],
    ['https://deb.debian.org/debian/pool/main/g/gtk+2.0/libgtk2.0-0_2.24.33-2+deb12u1_amd64.deb', 'd1e9a26a5961748f220c5989c89516fead2a5054b80914f94c71c3fee6fdebe3'],
    ['https://deb.debian.org/debian/pool/main/d/dbus-glib/libdbus-glib-1-2_0.112-3_amd64.deb', '1cddce2ec5231fcfc12eb9daaa5a99bcdbe69373bff5362d9e38e54153d552fd'],
    ['https://deb.debian.org/debian/pool/main/g/gdk-pixbuf-xlib/libgdk-pixbuf-xlib-2.0-0_2.40.2-2_amd64.deb', 'c11e9c92534e1e8036ad33a7ee1962b120834a02c41594cdf90ce01855ba84a4'],
    // Matching font-stack ABIs prevent the 2016 browser from crashing against
    // the host's modern FreeType/Pango libraries. These remain test-local.
    ['https://archive.debian.org/debian/pool/main/f/fontconfig/libfontconfig1_2.11.0-6.7+b1_amd64.deb', '8e4ac54fe770ff84c4b596e5e66dacc94efad08940fa354a8c112db06c67d588'],
    ['https://archive.debian.org/debian/pool/main/f/freetype/libfreetype6_2.6.3-3.2+deb9u1_amd64.deb', '23e7b546543df1ad80a34e9ecdec725e71a5e48b607ef026657aa7687b229791'],
    ['https://archive.debian.org/debian/pool/main/h/harfbuzz/libharfbuzz0b_1.4.2-1_amd64.deb', '7d66151e6f07835f707a073a08e449e1ce971885af71ad6c474e0e85a2439610'],
    ['https://archive.debian.org/debian/pool/main/p/pango1.0/libpango-1.0-0_1.40.5-1_amd64.deb', '2973a15ad26aa1051dce9fa4c0ee7e06e4b03e99cf74b6e8697cb7384b346e8d'],
    ['https://archive.debian.org/debian/pool/main/p/pango1.0/libpangocairo-1.0-0_1.40.5-1_amd64.deb', 'c7bb62778c4e6c8086028e50656c3eff6e238c1467da6f3020c3d843668060d9'],
    ['https://archive.debian.org/debian/pool/main/p/pango1.0/libpangoft2-1.0-0_1.40.5-1_amd64.deb', 'd668b89229869a68cc411a25feff5016ff76c5ed0ae23855196f2a46f8f88e75'],
    ['https://archive.debian.org/debian/pool/main/c/cairo/libcairo2_1.14.8-1_amd64.deb', '1f6ebf5f89c05c2e4aae96343f41446e2a847a3686c1dd22db39922df1e60f73'],
];

async function download(url, filename, hash) {
    let body;
    try { body = await fs.readFile(filename); } catch { /* Download a missing cache entry. */ }
    if (!body || crypto.createHash('sha256').update(body).digest('hex') !== hash) {
        const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
        body = Buffer.from(await response.arrayBuffer());
        if (crypto.createHash('sha256').update(body).digest('hex') !== hash) throw new Error(`Checksum mismatch: ${url}`);
        await fs.writeFile(filename, body);
    }
}

async function main() {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The archived Chromium 56 test runs on Linux x64; CI provides this environment.');
    const directory = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'vanilla-list-chrome56'));
    await fs.mkdir(directory, { recursive: true });
    const archive = path.join(directory, 'chrome-linux.zip');
    await download(browserURL, archive, browserHash);
    execFileSync('python3', ['-c', [
        'import zipfile,os,sys',
        'from pathlib import Path',
        'with zipfile.ZipFile(sys.argv[1]) as z:',
        ' z.extractall(sys.argv[2])',
        ' for item in z.infolist():',
        '  mode=item.external_attr >> 16',
        '  if mode: os.chmod(Path(sys.argv[2])/item.filename,mode)',
    ].join('\n'), archive, directory]);
    const runtime = path.join(directory, 'libs');
    await fs.mkdir(runtime, { recursive: true });
    for (const [source, hash] of libraries) {
        const filename = path.join(directory, path.basename(source));
        await download(source, filename, hash);
        execFileSync('dpkg-deb', ['-x', filename, runtime]);
    }
    console.log(`CHROME56_PATH=${path.join(directory, 'chrome-linux', 'chrome')}`);
    console.log(`LD_LIBRARY_PATH=${path.join(runtime, 'usr/lib/x86_64-linux-gnu')}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
