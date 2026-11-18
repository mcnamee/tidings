import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CheckCheck, Filter, Loader2, RefreshCw } from 'lucide-react';
import {
  MARK_ALL_CONFIRM_OVER,
  type EntryListState,
  type EntryListView,
  type Subscription,
} from '@tidings/shared';
import { ApiRequestError } from '../api';
import {
  COUNTS_KEY,
  entriesKey,
  trimToFirstPage,
  useCounts,
  useEntries,
  useSubscriptions,
} from '../lib/queries';
import { markAllRead } from '../lib/markAllRead';
import { useSession } from '../lib/session';
import { markReadOnScroll, unreadOnlyDefault } from '../lib/settings';
import { useMarkReadOnScroll } from '../lib/readOnScroll';
import { prefersReducedMotion } from '../lib/useSwipe';
import { usePullToRefresh } from '../lib/usePullToRefresh';
import { SHEET_BUTTON, Sheet } from '../manage/Sheet';
import { BottomBar, HeaderActions } from '../shell/slots';
import { ArticleRow } from './ArticleRow';

const COUNT_FORMAT = new Intl.NumberFormat('en-US');
const formatCount = (n: number) => COUNT_FORMAT.format(n);

const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg active:bg-sunken';

function State({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-2 py-10 text-center">
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      <div className="mt-2 flex flex-col items-center gap-2 text-base text-fg-muted">
        {children}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading articles" data-testid="list-skeleton">
      {[0, 1, 2, 3, 4, 5].map((n) => (
        <li key={n} className="flex gap-3 border-b border-line py-4">
          <div className="flex-1 space-y-2">
            <div className="h-4 w-1/3 animate-skeleton rounded-sm bg-sunken" />
            <div className="h-5 w-11/12 animate-skeleton rounded-sm bg-sunken" />
            <div className="h-4 w-4/5 animate-skeleton rounded-sm bg-sunken" />
          </div>
          <div className="order-first size-24 animate-skeleton rounded-lg bg-sunken" />
        </li>
      ))}
    </ul>
  );
}

/** What an empty list says, in order of how specific it is (FR-RD-12). */
function Empty({
  view,
  state,
  subscription,
  noSubscriptions,
  onShowAll,
}: {
  view: EntryListView;
  state: EntryListState;
  subscription: Subscription | undefined;
  noSubscriptions: boolean;
  onShowAll: () => void;
}) {
  if (noSubscriptions) {
    return (
      <State title="No feeds yet">
        <p>Add a feed or import your OPML file.</p>
        <Link to="/manage/add" className="inline-flex min-h-11 items-center text-accent underline">
          Add a feed
        </Link>
        <Link
          to="/manage/import"
          className="inline-flex min-h-11 items-center text-accent underline"
        >
          Import from Inoreader
        </Link>
      </State>
    );
  }
  if (subscription) {
    const { state: feedState, errorMessage, lastSuccessAt } = subscription.health;
    if (feedState === 'failing' || feedState === 'dead' || feedState === 'gone') {
      return (
        <State title="This feed has problems">
          {errorMessage && <p>{errorMessage}</p>}
          <Link to="/manage" className="inline-flex min-h-11 items-center text-accent underline">
            Manage feeds
          </Link>
        </State>
      );
    }
    if (feedState === 'pending' && lastSuccessAt === null) {
      return (
        <State title="Waiting for the first fetch">
          <p>This feed hasn&apos;t been fetched yet. Articles will appear here soon.</p>
        </State>
      );
    }
  }
  if (state === 'unread') {
    return (
      <State title="All caught up">
        <p>No unread articles here.</p>
        <button type="button" onClick={onShowAll} className={BUTTON}>
          Show all articles
        </button>
      </State>
    );
  }
  return (
    <State title={view === 'feed' ? 'No articles yet' : 'Nothing here yet'}>
      <p>
        {view === 'feed' ? 'This feed has no articles.' : 'There are no articles in this view.'}
      </p>
    </State>
  );
}

/**
 * The three list views (`/all`, `/folders/:id`, `/feeds/:id`): FR-RD-1 to FR-RD-6, FR-RD-11 and
 * FR-RD-12. The unread/all filter lives in the URL (`?state=`), so Back from an article keeps it.
 */
export function ArticleList({
  view,
  id,
  base,
  covered = false,
}: {
  view: EntryListView;
  id: string | null;
  /** The list's own path (`/all`, `/folders/:id`, `/feeds/:id`): rows link to `${base}/a/:entryId`. */
  base: string;
  /** An article is open above this list: no pull to refresh, no mark-read-on-scroll underneath. */
  covered?: boolean;
}) {
  const client = useQueryClient();
  const session = useSession();
  const [params, setParams] = useSearchParams();

  const asParam = params.get('state');
  const state: EntryListState =
    asParam === 'all' || asParam === 'unread'
      ? asParam
      : unreadOnlyDefault(session.data?.user?.settings)
        ? 'unread'
        : 'all';
  const key = entriesKey(view, id, state);

  // An article opens as a layer above this list, which stays mounted: Back finds the loaded
  // pages, the rows read meanwhile (shown as read, FR-RD-4) and the scroll position as they were.
  // Any other arrival starts again from page 1, with the browser's scroll restoration off.
  useState(() => trimToFirstPage(client, key));
  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
  }, []);

  const entries = useEntries(view, id, state, 'always');
  const subscriptions = useSubscriptions();
  const items = entries.data?.pages.flatMap((p) => p.items) ?? [];

  async function refresh() {
    // FR-RD-11: cached server data only. These are the list and the counts, never a feed fetch.
    trimToFirstPage(client, key);
    await Promise.all([entries.refetch(), client.refetchQueries({ queryKey: COUNTS_KEY })]);
  }
  const stretchRef = useRef<HTMLDivElement>(null);
  const pull = usePullToRefresh(refresh, !covered, stretchRef);
  // The indicator waits above the list content, under the header, and is uncovered as the content
  // is pulled down. With reduced motion nothing stretches, so it shows in the flow instead.
  const stretches = !prefersReducedMotion();

  // FR-RD-9. The watermark is the first page's `asOf`; the number for the confirm step is the
  // unread count the sidebar already holds for this view (or the loaded unread rows, if more).
  const counts = useCounts();
  const [confirming, setConfirming] = useState(false);
  const asOf = entries.data?.pages[0]?.asOf;
  const loadedUnread = items.filter((i) => !i.isRead).length;
  const known =
    view === 'all'
      ? counts.data?.total
      : view === 'folder'
        ? counts.data?.folders[id ?? '']
        : counts.data?.subscriptions[id ?? ''];
  const toMark = Math.max(known ?? 0, loadedUnread);
  function markAll() {
    if (!asOf) return;
    setConfirming(false);
    void markAllRead(client, { view, id, before: asOf });
  }

  // TID-026: rows scrolled past are marked read (batched). Rows stay in an unread-only list.
  const listRef = useRef<HTMLUListElement>(null);
  useMarkReadOnScroll(
    client,
    listRef,
    items,
    !covered && markReadOnScroll(session.data?.user?.settings),
  );

  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = entries;
  const canObserve = typeof IntersectionObserver !== 'undefined';
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || !canObserve) return;
    const observer = new IntersectionObserver(
      (hits) => {
        if (hits.some((h) => h.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, canObserve, items.length]);

  function setState(next: EntryListState) {
    const p = new URLSearchParams(params);
    p.set('state', next);
    setParams(p, { replace: true });
  }

  const notFound =
    entries.error instanceof ApiRequestError && entries.error.status === 404 && !entries.data;
  const subscription = view === 'feed' ? subscriptions.data?.find((s) => s.id === id) : undefined;
  const now = Date.now();

  let body: ReactNode;
  if (notFound) {
    body = (
      <State title="We couldn't find that page.">
        <Link to="/all" className="inline-flex min-h-11 items-center text-accent underline">
          Go to All articles
        </Link>
      </State>
    );
  } else if (entries.isPending && !entries.isError) {
    body = <Skeleton />;
  } else if (entries.isError && !entries.data) {
    body = (
      <State title="Something went wrong on our side.">
        <button type="button" onClick={() => void entries.refetch()} className={BUTTON}>
          Try again
        </button>
      </State>
    );
  } else if (items.length === 0 && !hasNextPage) {
    body = (
      <Empty
        view={view}
        state={state}
        subscription={subscription}
        noSubscriptions={view === 'all' && subscriptions.data?.length === 0}
        onShowAll={() => setState('all')}
      />
    );
  } else {
    body = (
      <>
        <ul ref={listRef}>
          {items.map((entry, i) => (
            <ArticleRow
              key={entry.id}
              entry={entry}
              to={`${base}/a/${entry.id}?state=${state}`}
              now={now}
              prev={items[i - 1]}
            />
          ))}
        </ul>
        {hasNextPage && (
          <div ref={sentinel} className="flex min-h-14 items-center justify-center py-4">
            {entries.isFetchNextPageError ? (
              <button type="button" onClick={() => void fetchNextPage()} className={BUTTON}>
                Couldn&apos;t load more. Try again
              </button>
            ) : !canObserve ? (
              <button type="button" onClick={() => void fetchNextPage()} className={BUTTON}>
                Load more
              </button>
            ) : (
              <Loader2 aria-hidden="true" className="size-5 animate-spin text-fg-muted" />
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div>
      <HeaderActions>
        <button
          type="button"
          aria-pressed={state === 'unread'}
          onClick={() => setState(state === 'unread' ? 'all' : 'unread')}
          className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-base font-medium text-fg active:bg-sunken aria-pressed:bg-accent-subtle aria-pressed:text-accent-subtle-fg"
        >
          {state === 'unread' ? (
            <Check aria-hidden="true" className="size-5" strokeWidth={2.25} />
          ) : (
            <Filter aria-hidden="true" className="size-5" strokeWidth={1.75} />
          )}
          Unread only
        </button>
      </HeaderActions>
      <BottomBar>
        <button
          type="button"
          onClick={() => (toMark > MARK_ALL_CONFIRM_OVER ? setConfirming(true) : markAll())}
          disabled={!asOf || toMark === 0}
          className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-base font-medium text-fg active:bg-sunken disabled:text-fg-muted"
        >
          <CheckCheck aria-hidden="true" className="size-5" strokeWidth={1.75} />
          Mark all as read
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={pull === 'refreshing'}
          className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-base font-medium text-fg active:bg-sunken disabled:text-fg-muted"
        >
          <RefreshCw aria-hidden="true" className="size-5" strokeWidth={1.75} />
          Refresh
        </button>
      </BottomBar>
      {confirming && (
        <Sheet
          title={`Mark ${formatCount(toMark)} articles as read?`}
          onClose={() => setConfirming(false)}
        >
          <div className="mt-4 space-y-2">
            <button
              type="button"
              onClick={markAll}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-base font-medium text-accent-fg"
            >
              Mark {formatCount(toMark)} as read
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={SHEET_BUTTON}>
              Cancel
            </button>
          </div>
        </Sheet>
      )}
      <div role="status" className="sr-only">
        {pull === 'refreshing' ? 'Refreshing' : ''}
      </div>
      <div ref={stretchRef} className="relative">
        {pull !== 'idle' && (
          <p
            aria-hidden="true"
            className={`flex h-10 items-center justify-center gap-2 text-sm text-fg-muted ${stretches ? 'absolute inset-x-0 bottom-full' : ''}`}
          >
            {pull === 'refreshing' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : pull === 'ready' ? (
              'Release to refresh'
            ) : (
              'Pull to refresh'
            )}
          </p>
        )}
        {body}
      </div>
    </div>
  );
}
