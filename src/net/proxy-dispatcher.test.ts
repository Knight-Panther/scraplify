import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpFetcher } from './http-fetcher.js';
import { proxyDispatcherFromEnv } from './proxy-dispatcher.js';
import { createRateLimiter } from './rate-limiter.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    closers.push(
      () =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
  });
}

describe('proxyDispatcherFromEnv', () => {
  it('is null when the variable is unset or blank', () => {
    expect(proxyDispatcherFromEnv('SS_GE_PROXY_URL', {})).toBeNull();
    expect(proxyDispatcherFromEnv('SS_GE_PROXY_URL', { SS_GE_PROXY_URL: '  ' })).toBeNull();
  });

  it('labels the proxy without its credentials', async () => {
    const proxy = proxyDispatcherFromEnv('SS_GE_PROXY_URL', {
      SS_GE_PROXY_URL: 'http://user:secret@proxy.example:8080',
    });
    expect(proxy?.label).toBe('http://proxy.example:8080');
    await proxy?.dispatcher.close();
  });

  it.each([
    ['not a url', 'is not a URL'],
    ['socks5://127.0.0.1:1080', 'must be an http:// or https:// proxy'],
    ['http://127.0.0.1', "must name the proxy's port"],
  ])('refuses %s', (value, message) => {
    expect(() => proxyDispatcherFromEnv('SS_GE_PROXY_URL', { SS_GE_PROXY_URL: value })).toThrow(
      message,
    );
  });

  it("sends the fetcher's requests through the proxy", async () => {
    // The origin the proxy reaches; the fetched host name never resolves.
    const origin = http.createServer((req, res) => {
      res.end(`origin saw ${req.headers.host}${req.url} as ${req.headers['user-agent']}`);
    });
    const originPort = await listen(origin);

    // A minimal forward proxy: it records each request and sends it to the
    // origin, whether as an absolute-form request (what undici sends for an
    // http:// target) or a CONNECT tunnel (an https:// target, such as ss.ge).
    const seen: string[] = [];
    const proxyServer = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const target = new URL(req.url ?? '');
      const upstream = http.request(
        { host: '127.0.0.1', port: originPort, path: target.pathname, headers: req.headers },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      req.pipe(upstream);
    });
    proxyServer.on('connect', (req, socket: net.Socket, head) => {
      seen.push(`CONNECT ${req.url}`);
      const upstream = net.connect(originPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    const proxyPort = await listen(proxyServer);

    const proxy = proxyDispatcherFromEnv('SS_GE_PROXY_URL', {
      SS_GE_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
    });
    if (proxy === null) throw new Error('expected a proxy');
    closers.push(() => proxy.dispatcher.close());
    const fetcher = createHttpFetcher({
      isUrlAllowed: () => true,
      rateLimiter: createRateLimiter({ crawlDelaySeconds: null, maxConcurrency: 1 }),
      userAgent: 'scraplify-test/1.0',
      dispatcher: proxy.dispatcher,
    });

    const result = await fetcher.fetch('http://home.ss.ge.invalid/ka/list');
    expect(seen).toEqual(['GET http://home.ss.ge.invalid/ka/list']);
    expect(result.status).toBe(200);
    expect(result.body).toBe('origin saw home.ss.ge.invalid/ka/list as scraplify-test/1.0');
  });
});
