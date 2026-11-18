import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Counts, EntriesResponse, EntrySummary, Subscription } from '@tidings/shared';
import { COUNTS_KEY, SUBSCRIPTIONS_KEY } from './queries';
import { createReadBatcher, SCROLL_READ_ERROR } from './readOnScroll';
import { toastStore } from './toast';

// TID-026: the batching rules, with an injected sender and fake timers.

const entry = (id: string, isRead = false): EntrySummary =>
  ({ id, subscriptionId: 's1', isRead, title: id }) as EntrySummary;

let client: QueryClient;
const LIST_KEY = ['entries', 'all', null, 'unread'];
beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient();
  client.setQueryData(SUBSCRIPTIONS_KEY, [{ id: 's1', folderId: null } as Subscription]);
  client.setQueryData<Counts>(COUNTS_KEY, { total: 3, folders: {}, subscriptions: { s1: 3 } });
  client.setQueryData(LIST_KEY, {
    pages: [{ items: ['1', '2', '3'].map((i) => entry(i)), nextCursor: null, asOf: '' }],
    pageParams: [null],
  });
  toastStore.dismiss();
});
afterEach(() => vi.useRealTimers());

const flags = () =>
  client.getQueryData<{ pages: EntriesResponse[] }>(LIST_KEY)!.pages[0]!.items.map((i) => i.isRead);
const unread = () => client.getQueryData<Counts>(COUNTS_KEY)!.total;

describe('read batcher', () => {
  it('marks optimistically at once and sends one call after the interval', async () => {
    const send = vi.fn().mockResolvedValue({ updated: 2 });
    const b = createReadBatcher(client, { send });
    b.add(entry('1'));
    b.add(entry('2'));
    b.add(entry('2')); // twice: counted once
    expect(flags()).toEqual([true, true, false]);
    expect(unread()).toBe(1);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ entryIds: ['1', '2'], isRead: true }, false);
  });

  it('sends at most one call per 2 s window however many rows pass', async () => {
    const send = vi.fn().mockResolvedValue({ updated: 1 });
    const b = createReadBatcher(client, { send });
    b.add(entry('1'));
    await vi.advanceTimersByTimeAsync(1000);
    b.add(entry('2'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].entryIds).toEqual(['1', '2']);
    b.add(entry('3'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('ignores rows that are already read, and sends nothing when there is nothing', async () => {
    const send = vi.fn().mockResolvedValue({ updated: 0 });
    const b = createReadBatcher(client, { send });
    b.add(entry('9', true));
    await b.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();
  });

  it('flush sends right away (keepalive when the page is going away) and cancels the timer', async () => {
    const send = vi.fn().mockResolvedValue({ updated: 1 });
    const b = createReadBatcher(client, { send });
    b.add(entry('1'));
    await b.flush(true);
    expect(send).toHaveBeenCalledWith({ entryIds: ['1'], isRead: true }, true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('dispose (unmount) flushes what is waiting', async () => {
    const send = vi.fn().mockResolvedValue({ updated: 1 });
    const b = createReadBatcher(client, { send });
    b.add(entry('3'));
    b.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a failed batch is put back and one toast says so', async () => {
    const send = vi.fn().mockRejectedValue(new Error('boom'));
    const b = createReadBatcher(client, { send });
    b.add(entry('1'));
    b.add(entry('2'));
    expect(unread()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(flags()).toEqual([false, false, false]);
    expect(unread()).toBe(3);
    expect(toastStore.getSnapshot()).toMatchObject({ kind: 'error', message: SCROLL_READ_ERROR });
  });

  it('splits into calls of at most 1,000 IDs, with one toast if any fail', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue({ updated: 1 });
    const b = createReadBatcher(client, { send });
    for (let i = 0; i < 1001; i++) b.add(entry(`e${i}`));
    await b.flush();
    expect(send.mock.calls.map((c) => c[0].entryIds.length)).toEqual([1000, 1]);
  });
});
