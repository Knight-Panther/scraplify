// Phase 8A Stage 5/6: a minimal static file server for the browser parity/
// isolation harness. Not a shipped screen — no route exists in web/, this
// only serves a few files from disk for a local Playwright-driven check.
// No third-party static-file-server dependency: routes are few and fixed.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * @param {{ routes: Record<string, string> }} options routes maps a URL path
 *   prefix to an absolute directory on disk it serves from.
 */
export function createParityServer({ routes }) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const prefix = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((p) => url.pathname === p || url.pathname.startsWith(`${p}/`));

    if (!prefix) {
      res.writeHead(404).end('not found');
      return;
    }

    const relative = url.pathname.slice(prefix.length).replace(/^\/+/, '');
    const filePath = normalize(join(routes[prefix], relative || 'index.html'));
    if (!filePath.startsWith(normalize(routes[prefix])) || !existsSync(filePath)) {
      res.writeHead(404).end('not found');
      return;
    }

    const stat = statSync(filePath);
    if (!stat.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }

    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'content-length': stat.size,
    });
    createReadStream(filePath).pipe(res);
  });
}
