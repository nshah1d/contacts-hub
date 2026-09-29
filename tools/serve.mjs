import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../public/', import.meta.url));
/**
 * A local static server for inspecting the interface without PHP. It serves GET and HEAD
 * from public/ only, refuses dotfiles, backslashes, traversal and .php, and never runs an
 * endpoint.
 * @param {{base?: string}} [options]
 * @returns {import('node:http').Server}
 */
export function staticServer({ base = root } = {}) {
    return http.createServer(async (req, res) => {
        try {
            if (!['GET', 'HEAD'].includes(req.method)) {
                res.writeHead(405, { Allow: 'GET, HEAD' }).end();
                return;
            }
            let pathname;
            try {
                pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
            }
            catch {
                res.writeHead(400).end();
                return;
            }
            if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(p => p.startsWith('.')) || /\.php$/i.test(pathname)) {
                res.writeHead(404).end();
                return;
            }
            if (pathname.endsWith('/'))
                pathname += 'index.html';
            const full = path.resolve(base, '.' + pathname);
            if (!full.startsWith(path.resolve(base) + path.sep)) {
                res.writeHead(404).end();
                return;
            }
            const ext = path.extname(full).toLowerCase(), types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain;charset=utf-8', '.md': 'text/plain;charset=utf-8', '.sql': 'text/plain;charset=utf-8', '.tap': 'text/plain;charset=utf-8' };
            if (!types[ext] || !(await stat(full)).isFile()) {
                res.writeHead(404).end();
                return;
            }
            const data = await readFile(full);
            res.writeHead(200, { 'Content-Type': types[ext], 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
            res.end(req.method === 'HEAD' ? undefined : data);
        }
        catch {
            res.writeHead(404).end();
        }
    });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.PORT || 8080), server = staticServer();
    server.listen(port, '127.0.0.1', () => console.log(`Nexus static inspection: http://127.0.0.1:${port}/\nPHP endpoints are not executed by this server.`));
}
