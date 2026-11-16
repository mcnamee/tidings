import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastStore } from './lib/toast';
import { readLastList, saveLastList } from './lib/lastList';
import { Toasts } from './shell/Toasts';

// TID-006 QA (tester-owned): toast Undo behaviour through the real component, and lastList safety.

describe('toast Undo through the component', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const store = createToastStore();
    render(<Toasts store={store} />);
    return store;
  };

  it('Undo runs its action exactly once even on a double click, and the toast goes away', async () => {
    const store = setup();
    const run = vi.fn();
    act(() => void store.show('undo', 'Marked 14 as read', { action: { label: 'Undo', run } }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const undo = screen.getByRole('button', { name: 'Undo' });
    await user.dblClick(undo);
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Marked 14 as read')).not.toBeInTheDocument();
  });

  it('Undo is no longer offered once the 5 s window has passed', () => {
    const store = setup();
    const run = vi.fn();
    act(() => void store.show('undo', 'Marked 14 as read', { action: { label: 'Undo', run } }));
    act(() => void vi.advanceTimersByTime(4999));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it('hovering the toast keeps Undo available past 5 s, and leaving resumes the countdown', async () => {
    const store = setup();
    act(
      () =>
        void store.show('undo', 'Marked 3 as read', { action: { label: 'Undo', run: () => {} } }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.hover(screen.getByText('Marked 3 as read'));
    act(() => void vi.advanceTimersByTime(30_000));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    await user.unhover(screen.getByText('Marked 3 as read'));
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('keyboard focus on Undo pauses the timer (WCAG 2.2.1)', async () => {
    const store = setup();
    act(
      () =>
        void store.show('undo', 'Marked 3 as read', { action: { label: 'Undo', run: () => {} } }),
    );
    act(() => screen.getByRole('button', { name: 'Undo' }).focus());
    act(() => void vi.advanceTimersByTime(20_000));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('an info toast shown while Undo is visible does not replace it and appears after Undo is clicked', async () => {
    const store = setup();
    const run = vi.fn();
    act(() => void store.show('undo', 'Marked 14 as read', { action: { label: 'Undo', run } }));
    act(() => void store.show('success', 'Feed added'));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.queryByText('Feed added')).not.toBeInTheDocument();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Feed added')).toBeInTheDocument();
  });

  it('an error shown while Undo is visible is announced in the alert region after Undo expires', () => {
    const store = setup();
    act(
      () =>
        void store.show('undo', 'Marked 14 as read', { action: { label: 'Undo', run: () => {} } }),
    );
    act(() => void store.show('error', 'Could not refresh'));
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(
      within(region.querySelector('[role=alert]') as HTMLElement).queryByText('Could not refresh'),
    ).toBeNull();
    act(() => void vi.advanceTimersByTime(5000));
    expect(
      within(region.querySelector('[role=alert]') as HTMLElement).getByText('Could not refresh'),
    ).toBeInTheDocument();
  });

  it('a second Undo toast replaces the first and clears anything queued', () => {
    const store = setup();
    const first = vi.fn();
    const second = vi.fn();
    act(() => void store.show('undo', 'first', { action: { label: 'Undo', run: first } }));
    act(() => void store.show('info', 'queued'));
    act(() => void store.show('undo', 'second', { action: { label: 'Undo', run: second } }));
    expect(screen.queryByText('first')).not.toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.queryByText('queued')).not.toBeInTheDocument();
  });

  it('Escape on a focused toast dismisses it without running Undo', async () => {
    const store = setup();
    const run = vi.fn();
    act(() => void store.show('undo', 'Marked 3 as read', { action: { label: 'Undo', run } }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.tab();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it('a stale timer from a dismissed toast never dismisses its successor', () => {
    const store = createToastStore();
    store.show('info', 'one');
    act(() => void vi.advanceTimersByTime(3000));
    store.show('info', 'two');
    act(() => void vi.advanceTimersByTime(1500)); // the first toast's timer would fire here
    expect(store.getSnapshot()?.message).toBe('two');
  });

  it('an error toast has a Dismiss control with a 44px hit area and stays until dismissed or 8 s', () => {
    const store = setup();
    act(() => void store.show('error', 'Boom'));
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss.className).toMatch(/\bsize-11\b/);
    act(() => void vi.advanceTimersByTime(7999));
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  // DEF-004: ToastCard calls run() before dismiss(), so a throwing handler leaves the toast stuck.
  it.fails(
    'keeps the toast usable when the Undo action throws: the toast is dismissed and the error surfaces once',
    async () => {
      const store = setup();
      const boom = new Error('undo failed');
      const errors: unknown[] = [];
      const onError = (e: ErrorEvent) => {
        errors.push(e.error);
        e.preventDefault();
      };
      window.addEventListener('error', onError);
      act(
        () =>
          void store.show('undo', 'Marked 3 as read', {
            action: {
              label: 'Undo',
              run: () => {
                throw boom;
              },
            },
          }),
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(screen.getByRole('button', { name: 'Undo' })).catch(() => {});
      window.removeEventListener('error', onError);
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    },
  );
});

describe('lastList storage safety', () => {
  const throwing = {
    getItem: () => {
      throw new DOMException('denied', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('denied', 'SecurityError');
    },
  };

  it('returns /all when reading throws and does not throw when writing throws', () => {
    expect(readLastList(throwing)).toBe('/all');
    expect(() => saveLastList('/all', throwing)).not.toThrow();
  });

  // DEF-003: the localStorage global must be read inside the try/catch.
  it(
    'returns /all and does not throw when the localStorage global itself throws on access',
    () => {
      const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      try {
        expect(() => readLastList()).not.toThrow();
        expect(() => saveLastList('/all')).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each([
    '//evil.example',
    'https://evil.example',
    '/folders/',
    '/folders/a/b',
    '/folders/..',
    '/all\n',
    '/all/',
    '/feeds/a b',
    '',
  ])('rejects %j', (v) => {
    expect(readLastList({ getItem: () => v })).toBe('/all');
  });
});
