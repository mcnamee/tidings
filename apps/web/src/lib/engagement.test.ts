import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clickThrough, resetEngagementForTests, sendEngagement } from './engagement';

// TID-066: the fire-and-forget sender. Through the whole app it is covered in
// reader/ArticleView.test.tsx.
const ok = () => Promise.resolve(new Response('{}', { status: 200 }));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetEngagementForTests());

describe('sendEngagement', () => {
  it('POSTs the strict body to the entry with keepalive and JSON', () => {
    const f = vi.fn(ok);
    sendEngagement('12', 'open', f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/entries/12/engagement');
    expect(init).toMatchObject({
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'open' });
  });

  it('sends each kind once per entry', () => {
    const f = vi.fn(ok);
    for (let i = 0; i < 3; i++) sendEngagement('1', 'open', f as unknown as typeof fetch);
    for (let i = 0; i < 3; i++) sendEngagement('1', 'click', f as unknown as typeof fetch);
    sendEngagement('2', 'open', f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('never throws or rejects, and a failed send (rejected, throwing or non-2xx) may be retried', async () => {
    const rejecting = vi.fn(() => Promise.reject(new TypeError('offline')));
    const throwing = vi.fn(() => {
      throw new Error('sync');
    });
    const bad = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 })));
    for (const [id, f] of [
      ['1', rejecting],
      ['2', throwing],
      ['3', bad],
    ] as const) {
      expect(() => sendEngagement(id, 'open', f as unknown as typeof fetch)).not.toThrow();
    }
    await flush();
    const good = vi.fn(ok);
    for (const id of ['1', '2', '3']) sendEngagement(id, 'open', good as unknown as typeof fetch);
    expect(good).toHaveBeenCalledTimes(3);
    await flush();
  });

  it('a successful send is not repeated', async () => {
    const f = vi.fn(ok);
    sendEngagement('9', 'click', f as unknown as typeof fetch);
    await flush();
    sendEngagement('9', 'click', f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('clickThrough', () => {
  it('counts a middle click but not a right click', () => {
    const f = vi.fn(ok);
    vi.stubGlobal('fetch', f);
    const props = clickThrough('5');
    props.onAuxClick({ button: 2 });
    expect(f).not.toHaveBeenCalled();
    props.onAuxClick({ button: 1 });
    expect(f).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
