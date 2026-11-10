const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const files = new Set([
    'index.html', 'app.js', 'styles.css', 'favicon.png',
    'data-vanilla.js', 'data-neutral.js', 'data-avoid.js',
]);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

function createServer() {
    return http.createServer(async (req, res) => {
        if (!['GET', 'HEAD'].includes(req.method)) {
            res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
            return;
        }
        try {
            const pathname = new URL(req.url, 'http://localhost').pathname;
            const file = pathname === '/' ? 'index.html' : pathname.slice(1);
            if (!files.has(file)) { res.writeHead(404).end('Not found'); return; }
            const body = await fs.readFile(path.join(root, file));
            res.writeHead(200, {
                'Content-Type': types[path.extname(file)],
                'Content-Length': body.length,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            });
            res.end(req.method === 'HEAD' ? undefined : body);
        } catch {
            res.writeHead(500).end('Unable to read file');
        }
    });
}

if (require.main === module) {
    const port = Number(process.argv[2] ?? 8080);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error('Usage: npm start -- [port between 0 and 65535]');
        process.exitCode = 1;
    } else {
        const server = createServer();
        server.on('error', error => { console.error(error.message); process.exitCode = 1; });
        server.listen(port, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${server.address().port}`));
    }
}

module.exports = { createServer };
