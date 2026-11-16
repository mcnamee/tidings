import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERATED_FEEDS,
  generatedFeed,
  type GeneratedFeedName,
} from '../fixtures/generate-feeds.ts';

const FEEDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/feeds');
const LAST_MODIFIED = 'Tue, 10 Nov 2026 12:00:00 GMT';

/** What the server does for a request, instead of serving the plain fixture. */
export interface Behaviour {
  /** Respond with this status (e.g. 404, 410, 429, 500). Body is a short text unless `body` is set. */
  status?: number;
  /** Adds `Retry-After` (seconds as a number, or an HTTP date string). */
  retryAfter?: number | string;
  /** Respond 301/302/307/308 to this location (absolute or path relative to the server). */
  redirectTo?: string;
  /** Redirect status code, default 302. */
  redirectStatus?: 301 | 302 | 303 | 307 | 308;
  /** Wait this long before responding (use a value above the fetcher timeout to simulate a hang). */
  delayMs?: number;
  /** Never respond (connection stays open until the client gives up). */
  hang?: boolean;
  /** Serve this body instead of the fixture file. */
  body?: string | Uint8Array;
  contentType?: string;
  /** Extra response headers. */
  headers?: Record<string, string>;
  /** Serve a valid-looking RSS feed padded to this many bytes. */
  oversizeBytes?: number;
  /** With `oversizeBytes`: omit Content-Length and stream in chunks, so only a streaming cap can stop it. */
  chunked?: boolean;
  /** Apply this behaviour for the next N requests to the path, then fall back to the default. Default: forever. */
  times?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  /** HTTP status the server answered with ("hang" requests record 0). */
  status: number;
}

export interface FixtureServer {
  /** e.g. http://127.0.0.1:41234 */
  readonly origin: string;
  readonly port: number;
  /** URL for a path, e.g. url('/feeds/atom-basic.xml'). */
  url(pathname: string): string;
  /** Script a behaviour for a pathname (exact match). Later calls for the same path queue after earlier ones. */
  script(pathname: string, ...behaviours: Behaviour[]): void;
  /** Change what a fixture file contains on the next request (new ETag), simulating a feed update. */
  setBody(pathname: string, body: string): void;
  /** Requests received so far, optionally for one path. */
  requests(pathname?: string): RecordedRequest[];
  /** Clear scripts, body overrides and the request log. */
  reset(): void;
  close(): Promise<void>;
}

function etagFor(body: string | Uint8Array): string {
  return `"${createHash('sha1').update(body).digest('hex').slice(0, 20)}"`;
}

function contentTypeFor(name: string): string {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.opml')) return 'text/x-opml; charset=utf-8';
  if (name.endsWith('.json')) return 'application/json';
  return 'application/xml; charset=utf-8';
}

function paddedFeed(bytes: number): string {
  const head =
    '<?xml version="1.0"?><rss version="2.0"><channel><title>Oversize</title><link>https://big.example.test/</link><description>x</description>';
  const tail = '</channel></rss>';
  const item =
    '<item><title>Padding</title><link>https://big.example.test/p</link><guid>p</guid><description>';
  const itemEnd = '</description></item>';
  const fill = Math.max(bytes - head.length - tail.length - item.length - itemEnd.length, 0);
  return head + item + 'A'.repeat(fill) + itemEnd + tail;
}

export async function startFixtureServer(options: { port?: number } = {}): Promise<FixtureServer> {
  const scripts = new Map<string, Behaviour[]>();
  const overrides = new Map<string, string>();
  const log: RecordedRequest[] = [];
  const hung = new Set<ServerResponse>();
  const timers = new Set<NodeJS.Timeout>();

  async function load(
    pathname: string,
  ): Promise<{ body: string | Uint8Array; type: string } | null> {
    const override = overrides.get(pathname);
    if (override !== undefined) return { body: override, type: contentTypeFor(pathname) };

    const generated = /^\/feeds\/generated\/([a-z0-9-]+)\.xml$/.exec(pathname);
    if (generated) {
      const name = generated[1] as string;
      if (name in GENERATED_FEEDS) {
        return { body: generatedFeed(name as GeneratedFeedName), type: contentTypeFor(pathname) };
      }
      return null;
    }

    const plain = /^\/feeds\/([A-Za-z0-9._-]+)$/.exec(pathname);
    if (plain) {
      try {
        const file = plain[1] as string;
        return { body: await readFile(path.join(FEEDS_DIR, file)), type: contentTypeFor(file) };
      } catch {
        return null;
      }
    }
    return null;
  }

  function nextBehaviour(pathname: string): Behaviour | undefined {
    const queue = scripts.get(pathname);
    const head = queue?.[0];
    if (!queue || !head) return undefined;
    if (head.times !== undefined) {
      head.times -= 1;
      if (head.times <= 0) queue.shift();
    }
    return head;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fixture.local');
    const pathname = url.pathname;
    const record = (status: number) =>
      log.push({ method: req.method ?? 'GET', path: pathname, headers: req.headers, status });

    const b = nextBehaviour(pathname);

    if (b?.hang) {
      record(0);
      hung.add(res);
      res.on('close', () => hung.delete(res));
      return;
    }
    if (b?.delayMs) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          timers.delete(t);
          resolve();
        }, b.delayMs);
        timers.add(t);
        res.on('close', () => {
          clearTimeout(t);
          timers.delete(t);
          resolve();
        });
      });
      if (res.destroyed) {
        record(0);
        return;
      }
    }

    if (b?.redirectTo) {
      const status = b.redirectStatus ?? 302;
      const location = new URL(b.redirectTo, `http://${req.headers.host}`).toString();
      record(status);
      res.writeHead(status, { Location: location, ...b.headers });
      res.end();
      return;
    }

    if (b?.oversizeBytes) {
      const body = paddedFeed(b.oversizeBytes);
      record(200);
      const headers: Record<string, string> = {
        'Content-Type': b.contentType ?? 'application/xml; charset=utf-8',
        ...b.headers,
      };
      if (!b.chunked) headers['Content-Length'] = String(Buffer.byteLength(body));
      res.writeHead(200, headers);
      if (!b.chunked) {
        res.end(body);
        return;
      }
      const CHUNK = 64 * 1024;
      for (let i = 0; i < body.length && !res.destroyed; i += CHUNK) {
        if (!res.write(body.slice(i, i + CHUNK))) {
          await new Promise<void>((resolve) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.on('drain', done);
            res.on('close', done);
          });
        }
      }
      res.end();
      return;
    }

    if (b?.status !== undefined && b.status >= 400) {
      record(b.status);
      const headers: Record<string, string> = {
        'Content-Type': b.contentType ?? 'text/plain; charset=utf-8',
        ...b.headers,
      };
      if (b.retryAfter !== undefined) headers['Retry-After'] = String(b.retryAfter);
      res.writeHead(b.status, headers);
      res.end(
        typeof b.body === 'string' || b.body instanceof Uint8Array ? b.body : `status ${b.status}`,
      );
      return;
    }

    const loaded =
      b?.body !== undefined
        ? { body: b.body, type: b.contentType ?? 'application/xml; charset=utf-8' }
        : await load(pathname);

    if (!loaded) {
      record(404);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    const etag = etagFor(loaded.body);
    const common = {
      ETag: etag,
      'Last-Modified': LAST_MODIFIED,
      'Cache-Control': 'max-age=0',
      ...b?.headers,
    };
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    const notModified = inm
      ? inm.split(',').some((v) => v.trim() === etag || v.trim() === `W/${etag}`)
      : ims !== undefined && ims === LAST_MODIFIED;
    if (notModified && !b?.body) {
      record(304);
      res.writeHead(304, common);
      res.end();
      return;
    }

    const status = b?.status ?? 200;
    record(status);
    res.writeHead(status, {
      'Content-Type': loaded.type,
      'Content-Length': String(Buffer.byteLength(loaded.body)),
      ...common,
    });
    res.end(req.method === 'HEAD' ? undefined : loaded.body);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`fixture server error: ${String(err)}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    port,
    url: (p) => `${origin}${p}`,
    script(pathname, ...behaviours) {
      const queue = scripts.get(pathname) ?? [];
      queue.push(...behaviours.map((x) => ({ ...x })));
      scripts.set(pathname, queue);
    },
    setBody(pathname, body) {
      overrides.set(pathname, body);
    },
    requests: (p) => (p ? log.filter((r) => r.path === p) : [...log]),
    reset() {
      scripts.clear();
      overrides.clear();
      log.length = 0;
    },
    close() {
      for (const t of timers) clearTimeout(t);
      for (const res of hung) res.destroy();
      server.closeAllConnections();
      return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
