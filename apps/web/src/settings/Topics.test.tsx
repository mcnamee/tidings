import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOPICS, type SessionResponse } from '@tidings/shared';
import { App } from '../App';
import { reportReachable } from '../lib/connectivity';
import { SESSION_KEY } from '../lib/session';
import { toastStore } from '../lib/toast';
import { installFakeApi, type FakeApi } from '../test-api';
import { installMatchMedia } from '../test-utils';
import { TOPIC_SAVE_DELAY_MS } from './useTopicChips';

// TID-078 (AC6, AC8, AC10 at unit level): the Topics setting, through the whole app against a fake API.
// The server side (validation, whole-array replace) is in apps/worker/test/topic-filter.test.ts.

const TOPIC_LIST = {
  body: { items: TOPICS.map((t) => ({ id: t.slug, name: t.name })), version: 1 },
};
const NAME = Object.fromEntries(TOPICS.map((t) => [t.slug, t.name]));

let api: FakeApi;
let client: QueryClient;

function renderTopics(
  chips: string[] | null = ['ai', 'formula-1', 'uk-politics'],
  path = '/settings/topics',
) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session: SessionResponse = {
    user: {
      id: 'u1',
      displayName: 'Matt',
      role: 'owner',
      settings: chips === null ? {} : { topicChips: chips },
    },
    setupRequired: false,
    mustAddPasskey: false,
    emailSignIn: false,
  };
  client.setQueryData(SESSION_KEY, session);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const patches = () => api.calls.filter((c) => c.method === 'PATCH' && c.path === '/api/me');
const savedChips = () =>
  client.getQueryData<SessionResponse>(SESSION_KEY)?.user?.settings.topicChips;
const chosenList = () => screen.getByRole('list', { name: 'On the chips' });
const chosenNames = () =>
  within(chosenList())
    .getAllByRole('listitem')
    .map((li) => li.querySelector('span.flex-1')?.textContent);
const status = () => screen.getByTestId('topics-status');
const move = (name: string, dir: 'up' | 'down') =>
  screen.getByRole('button', { name: `Move ${name} ${dir}` });
const settle = () => waitFor(() => expect(patches().length).toBeGreaterThan(0), { timeout: 2500 });

beforeEach(() => {
  localStorage.clear();
  installMatchMedia();
  api = installFakeApi();
  api.set('GET /api/topics', TOPIC_LIST);
  api.set('GET /api/auth/passkeys', { body: { items: [] } });
  api.set('GET /api/health', { body: { ok: true, version: '1' } });
  api.set('PATCH /api/me', (body) => ({ body: { id: 'u1', ...(body as object) } }));
  reportReachable(true);
  toastStore.dismiss();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the lists', () => {
  it('shows the chosen topics in their order and every other topic alphabetically, with counts', async () => {
    renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    expect(chosenNames()).toEqual(['AI', 'Formula 1', 'UK politics']);
    const others = within(
      screen.getByRole('heading', { name: 'Other topics' }).closest('section') as HTMLElement,
    )
      .getAllByRole('listitem')
      .map((li) => li.querySelector('span.flex-1')?.textContent as string);
    expect(others).toHaveLength(25);
    expect(others).toEqual([...others].sort((a, b) => a.localeCompare(b)));
    expect(others).not.toContain('AI');
    const counts = screen.getAllByText(/^(3|25)$/).map((n) => n.textContent);
    expect(counts).toEqual(['3', '25']);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Topics');
    expect(document.title).toBe('Topics - Tidings');
  });

  it('says so when none are chosen, and when every topic is chosen', async () => {
    const view = renderTopics([]);
    expect(
      await screen.findByText('No topics chosen. All articles has no chip row.'),
    ).toBeInTheDocument();
    view.unmount();
    renderTopics(TOPICS.map((t) => t.slug));
    expect(await screen.findByText('Every topic is on the chips.')).toBeInTheDocument();
  });

  it('every control is at least 44 px and the arrows at the ends are aria-disabled, not removed', async () => {
    renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    expect(move('AI', 'up')).toHaveAttribute('aria-disabled', 'true');
    expect(move('AI', 'down')).not.toHaveAttribute('aria-disabled');
    expect(move('UK politics', 'down')).toHaveAttribute('aria-disabled', 'true');
    for (const b of [
      screen.getByRole('button', { name: 'Remove AI from chips' }),
      move('AI', 'down'),
      screen.getByRole('button', { name: 'Add Apple to chips' }),
    ]) {
      expect(b.className).toMatch(/size-11|min-h-11/);
    }
  });

  it('shows a skeleton while loading, and an error with Try again when the names fail', async () => {
    api.set('GET /api/topics', () => new Promise(() => undefined));
    const view = renderTopics();
    expect(await screen.findByLabelText('Loading topics')).toHaveAttribute('aria-busy', 'true');
    view.unmount();

    api.set('GET /api/topics', {
      status: 500,
      body: { error: { code: 'internal', message: 'x' } },
    });
    renderTopics();
    // The names query retries once (about a second) before it gives up.
    expect(
      await screen.findByText("Couldn't load topics.", {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    api.set('GET /api/topics', TOPIC_LIST);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'On the chips' })).toBeInTheDocument();
  });
});

describe('AC6: keyboard and screen reader path', () => {
  it('Move down reorders, announces the new position and keeps focus on the same button; one PATCH carries the whole list', async () => {
    const user = userEvent.setup();
    renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    await user.click(move('AI', 'down'));
    expect(chosenNames()).toEqual(['Formula 1', 'AI', 'UK politics']);
    expect(status()).toHaveTextContent('AI moved to position 2 of 3.');
    expect(move('AI', 'down')).toHaveFocus();
    // It shows at once (the chip row reads the same setting), before anything is sent.
    expect(savedChips()).toEqual(['formula-1', 'ai', 'uk-politics']);
    expect(patches()).toHaveLength(0);

    await user.click(move('AI', 'down'));
    // The arrow that reached the end is now disabled: focus moves to the other arrow of the row.
    expect(chosenNames()).toEqual(['Formula 1', 'UK politics', 'AI']);
    expect(move('AI', 'up')).toHaveFocus();
    await user.click(move('AI', 'up'));
    expect(move('AI', 'up')).toHaveFocus();

    await settle();
    // Three presses, one request, the last order.
    await new Promise((r) => setTimeout(r, TOPIC_SAVE_DELAY_MS + 100));
    expect(patches()).toHaveLength(1);
    expect(patches()[0]?.body).toEqual({
      settings: { topicChips: ['formula-1', 'ai', 'uk-politics'] },
    });
  });

  it('Move up at the top does nothing; Add appends and focuses its Move up; Remove returns it to Other topics', async () => {
    const user = userEvent.setup();
    renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    await user.click(move('AI', 'up'));
    expect(chosenNames()).toEqual(['AI', 'Formula 1', 'UK politics']);

    await user.click(screen.getByRole('button', { name: 'Add Apple to chips' }));
    expect(chosenNames()).toEqual(['AI', 'Formula 1', 'UK politics', 'Apple']);
    expect(status()).toHaveTextContent('Apple added to chips, position 4 of 4.');
    expect(move('Apple', 'up')).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Add Apple to chips' })).toBeNull();

    // Remove from the middle: focus goes to the Remove button of the row now in its place.
    await user.click(screen.getByRole('button', { name: 'Remove Formula 1 from chips' }));
    expect(chosenNames()).toEqual(['AI', 'UK politics', 'Apple']);
    expect(status()).toHaveTextContent('Formula 1 removed from chips.');
    expect(screen.getByRole('button', { name: 'Remove UK politics from chips' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Add Formula 1 to chips' })).toBeInTheDocument();
    // Removing the last one moves focus to the previous row.
    await user.click(screen.getByRole('button', { name: 'Remove Apple from chips' }));
    expect(screen.getByRole('button', { name: 'Remove UK politics from chips' })).toHaveFocus();

    await settle();
    await waitFor(() => expect(savedChips()).toEqual(['ai', 'uk-politics']));
  });

  it('removing the only chip focuses the Other topics heading', async () => {
    const user = userEvent.setup();
    renderTopics(['ai']);
    await user.click(await screen.findByRole('button', { name: 'Remove AI from chips' }));
    expect(screen.getByRole('heading', { name: 'Other topics' })).toHaveFocus();
    await waitFor(() => expect(patches()[0]?.body).toEqual({ settings: { topicChips: [] } }));
  });
});

describe('AC6: saving and failure', () => {
  it('a failed save puts the chips back and says so with a toast and in the live region', async () => {
    const user = userEvent.setup();
    api.set('PATCH /api/me', { status: 500, body: { error: { code: 'internal', message: 'x' } } });
    renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    await user.click(move('AI', 'down'));
    expect(savedChips()).toEqual(['formula-1', 'ai', 'uk-politics']);
    await waitFor(() => expect(savedChips()).toEqual(['ai', 'formula-1', 'uk-politics']), {
      timeout: 2500,
    });
    expect(chosenNames()).toEqual(['AI', 'Formula 1', 'UK politics']);
    expect(toastStore.getSnapshot()?.message).toBe("Couldn't save your topics. Try again.");
    expect(status()).toHaveTextContent("Couldn't save. Topics put back.");
  });

  it('a later change after a failure rolls back to the last list the server accepted', async () => {
    const user = userEvent.setup();
    renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    await user.click(move('AI', 'down'));
    await waitFor(() => expect(patches()).toHaveLength(1), { timeout: 2500 });
    api.set('PATCH /api/me', { status: 500, body: { error: { code: 'internal', message: 'x' } } });
    await user.click(move('AI', 'down'));
    await waitFor(() => expect(savedChips()).toEqual(['formula-1', 'ai', 'uk-politics']), {
      timeout: 2500,
    });
    expect(chosenNames()).toEqual(['Formula 1', 'AI', 'UK politics']);
  });

  it('leaving the screen sends a save that is still waiting', async () => {
    const user = userEvent.setup();
    const view = renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    await user.click(screen.getByRole('button', { name: 'Add Apple to chips' }));
    expect(patches()).toHaveLength(0);
    view.unmount();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]?.body).toEqual({
      settings: { topicChips: ['ai', 'formula-1', 'uk-politics', 'apple'] },
    });
  });

  it('offline: Move, Add and Remove are aria-disabled, nothing is sent, and a press says so', async () => {
    const user = userEvent.setup();
    renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    const { onlineManager } = await import('@tanstack/react-query');
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    act(() => void window.dispatchEvent(new Event('offline')));
    try {
      await waitFor(() => expect(move('AI', 'down')).toHaveAttribute('aria-disabled', 'true'));
      await user.click(move('AI', 'down'));
      await user.click(screen.getByRole('button', { name: 'Add Apple to chips' }));
      expect(toastStore.getSnapshot()?.message).toBe("You're offline. That change wasn't saved.");
      expect(chosenNames()).toEqual(['AI', 'Formula 1', 'UK politics']);
      await new Promise((r) => setTimeout(r, TOPIC_SAVE_DELAY_MS + 100));
      expect(patches()).toHaveLength(0);
    } finally {
      Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
      window.dispatchEvent(new Event('online'));
      onlineManager.setOnline(true);
    }
  });
});

describe('AC6: dragging by the grip', () => {
  /** jsdom has no layout: give the three rows 56 px boxes, one under another. */
  function layOut() {
    const rows = within(chosenList()).getAllByRole('listitem');
    rows.forEach((li, i) => {
      li.getBoundingClientRect = () =>
        ({
          top: i * 56,
          bottom: (i + 1) * 56,
          height: 56,
          left: 0,
          right: 343,
          width: 343,
          x: 0,
          y: i * 56,
        }) as DOMRect;
    });
    return rows;
  }
  const grip = (slug: string) => screen.getByTestId(`grip-${slug}`);
  const raf = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => raf(cb) as number);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  it('dragging a row to a new slot moves it, announces it, and saves the new order; the others slide aside while it moves', async () => {
    renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    const rows = layOut();
    fireEvent.pointerDown(grip('ai'), {
      pointerId: 1,
      pointerType: 'touch',
      clientY: 28,
      button: 0,
    });
    // The row is lifted while dragged.
    expect(rows[0]).toHaveClass('shadow-raised');
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 130 });
    expect(rows[0]?.style.transform).toBe('translateY(102px)');
    expect(rows[1]?.style.transform).toBe('translateY(-56px)');
    expect(rows[2]?.style.transform).toBe('translateY(-56px)');
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 130 });

    expect(chosenNames()).toEqual(['Formula 1', 'UK politics', 'AI']);
    expect(status()).toHaveTextContent('AI moved to position 3 of 3.');
    // Nothing is left on the rows.
    for (const li of within(chosenList()).getAllByRole('listitem'))
      expect(li.style.transform).toBe('');
    await settle();
    expect(patches()[0]?.body).toEqual({
      settings: { topicChips: ['formula-1', 'uk-politics', 'ai'] },
    });
  });

  it('dragging up works too, and a drop where the order did not change saves nothing and says nothing', async () => {
    renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    layOut();
    fireEvent.pointerDown(grip('uk-politics'), {
      pointerId: 1,
      pointerType: 'mouse',
      clientY: 140,
      button: 0,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 10 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(chosenNames()).toEqual(['UK politics', 'AI', 'Formula 1']);
    await settle();

    const before = patches().length;
    layOut();
    fireEvent.pointerDown(grip('ai'), {
      pointerId: 2,
      pointerType: 'mouse',
      clientY: 84,
      button: 0,
    });
    fireEvent.pointerMove(window, { pointerId: 2, clientY: 90 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(chosenNames()).toEqual(['UK politics', 'AI', 'Formula 1']);
    await new Promise((r) => setTimeout(r, TOPIC_SAVE_DELAY_MS + 100));
    expect(patches()).toHaveLength(before);
  });

  it('Escape and a cancelled pointer put the row back and say "Move cancelled"', async () => {
    renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    layOut();
    fireEvent.pointerDown(grip('ai'), {
      pointerId: 1,
      pointerType: 'touch',
      clientY: 28,
      button: 0,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 130 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(chosenNames()).toEqual(['AI', 'Formula 1', 'UK politics']);
    expect(status()).toHaveTextContent('Move cancelled.');
    for (const li of within(chosenList()).getAllByRole('listitem'))
      expect(li.style.transform).toBe('');

    layOut();
    fireEvent.pointerDown(grip('ai'), {
      pointerId: 3,
      pointerType: 'touch',
      clientY: 28,
      button: 0,
    });
    fireEvent.pointerMove(window, { pointerId: 3, clientY: 130 });
    fireEvent.pointerCancel(window, { pointerId: 3 });
    expect(chosenNames()).toEqual(['AI', 'Formula 1', 'UK politics']);
    await new Promise((r) => setTimeout(r, TOPIC_SAVE_DELAY_MS + 100));
    expect(patches()).toHaveLength(0);
  });

  it('only the grip drags: pressing a row’s name does nothing', async () => {
    renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    const rows = layOut();
    fireEvent.pointerDown(rows[0]?.querySelector('span.flex-1') as Element, {
      pointerId: 1,
      clientY: 28,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 130 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(chosenNames()).toEqual(['AI', 'Formula 1', 'UK politics']);
  });

  it('the grip is hidden from assistive tech and the tab order, and is the only element with touch-action: none', async () => {
    renderTopics();
    await screen.findByRole('list', { name: 'On the chips' });
    const g = grip('ai');
    expect(g).toHaveAttribute('aria-hidden', 'true');
    expect(g).toHaveClass('touch-none');
    expect(
      within(chosenList())
        .getAllByRole('button')
        .every((b) => !b.className.includes('touch-none')),
    ).toBe(true);
    expect(chosenList().className).not.toContain('touch-none');
    // Tab order inside a row: Remove, Move up, Move down.
    const row = within(chosenList()).getAllByRole('listitem')[0] as HTMLElement;
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.getAttribute('data-control')),
    ).toEqual(['remove', 'up', 'down']);
  });
});

describe('Settings links to Topics', () => {
  it('shows the count and names chosen, or None chosen, and opens /settings/topics', async () => {
    const user = userEvent.setup();
    const view = renderTopics(['ai', 'formula-1', 'uk-politics'], '/settings');
    const link = await screen.findByRole('link', {
      name: /^Topics\s*3 chosen: AI, Formula 1, UK politics$/,
    });
    expect(link).toHaveAttribute('href', '/settings/topics');
    expect(screen.getByTestId('topics-summary')).toHaveTextContent(
      '3 chosen: AI, Formula 1, UK politics',
    );
    await user.click(link);
    expect(await screen.findByRole('list', { name: 'On the chips' })).toBeInTheDocument();
    view.unmount();

    renderTopics(null, '/settings');
    expect(await screen.findByRole('link', { name: /^Topics\s*None chosen$/ })).toBeInTheDocument();
    expect(NAME['ai']).toBe('AI');
  });
});
