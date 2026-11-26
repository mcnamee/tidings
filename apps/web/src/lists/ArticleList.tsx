import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Check, CheckCheck, Loader2, SlidersHorizontal } from 'lucide-react';
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
  refreshOnEnter,
  trimToFirstPage,
  useCounts,
  useTopicCounts,
  useEntries,
  useSubscriptions,
} from '../lib/queries';
import { markAllRead } from '../lib/markAllRead';
import { useSession } from '../lib/session';
import { effectiveSort, markReadOnScroll, unreadOnlyDefault } from '../lib/settings';
import { topicChipsPref, topicFromParams, topicName, useTopics } from '../lib/topics';
import { useUpdateSettings } from '../settings/useUpdateSettings';
import { useMarkReadOnScroll } from '../lib/readOnScroll';
import { isStandalone, prefersReducedMotion } from '../lib/useSwipe';
import { usePullToRefresh } from '../lib/usePullToRefresh';
import { SHEET_BUTTON, Sheet } from '../manage/Sheet';
import { HeaderActions, RevealContext, ShellSlotsContext } from '../shell/slots';
import { ArticleRow, LIST_GRID } from './ArticleRow';
import { CaughtUpArt } from './CaughtUpArt';
import { FilterPanel } from './FilterPanel';
import { TopicChips, TopicChipsSkeleton } from './TopicChips';

const COUNT_FORMAT = new Intl.NumberFormat('en-US');
const formatCount = (n: number) => COUNT_FORMAT.format(n);

/** A 44px icon button in the header's right-hand slot. */
const HEADER_ICON =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-md text-fg active:bg-sunken disabled:text-fg-muted';

const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg active:bg-sunken';

function State({
  title,
  art = false,
  children,
}: {
  title: string;
  /** A random spot illustration above the title (TID-073). */
  art?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`px-2 text-center ${
        art
          ? 'flex min-h-[calc(100dvh-var(--header-h,4rem)-var(--bar-h,0px)-2rem)] flex-col items-center justify-center pb-10 lg:min-h-[70vh]'
          : 'py-10'
      }`}
    >
      {art && <CaughtUpArt />}
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      <div className="mt-2 flex flex-col items-center gap-2 text-base text-fg-muted">
        {children}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <ul
      aria-busy="true"
      aria-label="Loading articles"
      data-testid="list-skeleton"
      className={LIST_GRID}
    >
      {[0, 1, 2, 3, 4, 5].map((n) => (
        <li
          key={n}
          className="flex gap-3 border-b border-line py-4 lg:flex-col lg:gap-0 lg:border-b-0 lg:p-3"
        >
          <div className="flex-1 space-y-2 lg:mt-3">
            <div className="h-4 w-1/3 animate-skeleton rounded-sm bg-sunken" />
            <div className="h-5 w-11/12 animate-skeleton rounded-sm bg-sunken" />
            <div className="h-4 w-4/5 animate-skeleton rounded-sm bg-sunken" />
          </div>
          <div className="order-first size-24 animate-skeleton rounded-lg bg-sunken lg:aspect-video lg:size-auto lg:w-full" />
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
  topic,
  onShowRead,
  onShowAll,
}: {
  view: EntryListView;
  state: EntryListState;
  subscription: Subscription | undefined;
  noSubscriptions: boolean;
  /** TID-078: the chosen topic on All articles. */
  topic: { slug: string; name: string } | null;
  onShowRead: () => void;
  onShowAll: () => void;
}) {
  if (topic) {
    // No picture and no "all caught up": an article tagged a little later may still arrive (UX 1.4a).
    return state === 'unread' ? (
      <State title={`Nothing unread in ${topic.name}`}>
        <button type="button" onClick={onShowRead} className={BUTTON}>
          Show read articles too
        </button>
        <button type="button" onClick={onShowAll} className={BUTTON}>
          Show all topics
        </button>
      </State>
    ) : (
      <State title={`No articles about ${topic.name} yet`}>
        <button type="button" onClick={onShowAll} className={BUTTON}>
          Show all topics
        </button>
      </State>
    );
  }
  if (noSubscriptions) {
    return (
      <State title="No feeds yet">
        <p>Add a feed or import your OPML file.</p>
        <Link
          to="/manage/add"
          replace={isStandalone()}
          className="inline-flex min-h-11 items-center text-accent underline"
        >
          Add a feed
        </Link>
        <Link
          to="/manage/import"
          replace={isStandalone()}
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
          <Link
            to="/manage"
            replace={isStandalone()}
            className="inline-flex min-h-11 items-center text-accent underline"
          >
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
      // Owner, 2026-11-21: just the picture and the title; Unread only in the header shows the rest.
      <State title="All caught up" art />
    );
  }
  return (
    <State title={view === 'feed' ? 'No articles yet' : 'Nothing here yet'} art>
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
  // TID-067: the order is a setting kept across devices; Recommended applies to unread lists only.
  const sort = effectiveSort(session.data?.user?.settings, state);
  const updateSettings = useUpdateSettings();
  // TID-078: the topic chips (a setting) and the chosen one (`?topic=`, All articles only).
  const chips = topicChipsPref(session.data?.user?.settings);
  const topicSlug = topicFromParams(params, view, chips);
  const topics = useTopics();
  const topic =
    topicSlug === null ? null : { slug: topicSlug, name: topicName(topicSlug, topics.data) };
  const key = entriesKey(view, id, state, sort, topicSlug);

  // TID-075: while a drawer is revealed under the page it is a frozen card; it neither pulls nor marks rows read.
  const { revealed = false } = useContext(ShellSlotsContext);

  // TID-074: the filter panel is local state (no history entry), so an edge swipe cannot leave it.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [panelRefreshing, setPanelRefreshing] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);
  const closeFilters = useCallback(() => setFiltersOpen(false), []);
  // Focus returns to the button once the page is no longer inert: from lg the panel's cleanup
  // lifts it first; below lg (TID-075) the shell does, one render after the panel starts closing.
  const wasOpen = useRef(false);
  const returnFocus = useRef(false);
  const pageInert = useContext(RevealContext)?.pageInert ?? false;
  useEffect(() => {
    if (wasOpen.current && !filtersOpen) returnFocus.current = true;
    if (filtersOpen) returnFocus.current = false;
    wasOpen.current = filtersOpen;
    if (returnFocus.current && !pageInert) {
      returnFocus.current = false;
      filterButton.current?.focus();
    }
  }, [filtersOpen, pageInert]);
  // A dot on the button while the list is not in the state the person starts lists in.
  const nonDefault = state !== (unreadOnlyDefault(session.data?.user?.settings) ? 'unread' : 'all');

  // An article opens as a layer above this list, which stays mounted: Back finds the loaded
  // pages, the rows read meanwhile (shown as read, FR-RD-4) and the scroll position as they were.
  // Any other arrival starts again from page 1, with the browser's scroll restoration off.
  useState(() => trimToFirstPage(client, key));
  // TID-078, FR-RD-4: a chip (or the Unread only switch) changes the key while this list stays mounted, so
  // the new key's cache would be served as it was left. Choosing one counts as leaving the list: read rows
  // go, and page 1 is fetched again. Done before `useEntries` reads the cache; idempotent.
  const lastKey = useRef(JSON.stringify(key));
  if (lastKey.current !== JSON.stringify(key)) {
    lastKey.current = JSON.stringify(key);
    refreshOnEnter(client, key, state);
  }
  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
  }, []);

  const entries = useEntries(view, id, state, 'always', sort, topicSlug);
  const subscriptions = useSubscriptions();
  const items = entries.data?.pages.flatMap((p) => p.items) ?? [];

  async function refresh() {
    // FR-RD-11: cached server data only. These are the list and the counts, never a feed fetch.
    trimToFirstPage(client, key);
    await Promise.all([entries.refetch(), client.refetchQueries({ queryKey: COUNTS_KEY })]);
  }
  /** List end (owner, 2026-11-21): back to the top, then refresh once it gets there. */
  async function scrollTopThenRefresh() {
    const smooth = !prefersReducedMotion();
    window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    if (smooth) {
      const started = performance.now();
      await new Promise<void>((done) => {
        const check = () =>
          window.scrollY <= 1 || performance.now() - started > 2000
            ? done()
            : requestAnimationFrame(check);
        requestAnimationFrame(check);
      });
    }
    await refresh();
  }
  const stretchRef = useRef<HTMLDivElement>(null);
  // TID-069: the window is the scroller on every layout (the header and bottom bar are fixed).
  const { state: pull, native } = usePullToRefresh(refresh, !covered && !revealed, stretchRef);
  // The indicator waits above the list content and is uncovered as the content is pulled down, by
  // the browser's own bounce or by our transform. It shows in the flow instead with reduced motion
  // (nothing stretches), and while a native pull refreshes (the bounce has settled back to the top).
  const stretches = native ? pull !== 'refreshing' : !prefersReducedMotion();

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
  // There are no per-topic counts, so a topic's number is the unread rows loaded so far.
  const toMark = topic ? loadedUnread : Math.max(known ?? 0, loadedUnread);
  function markAll() {
    if (!asOf) return;
    setConfirming(false);
    void markAllRead(client, { view, id, before: asOf, topic });
  }

  // TID-026: rows scrolled past are marked read (batched). Rows stay in an unread-only list.
  const listRef = useRef<HTMLUListElement>(null);
  useMarkReadOnScroll(
    client,
    listRef,
    items,
    !covered && !revealed && markReadOnScroll(session.data?.user?.settings),
  );

  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = entries;
  const canObserve = typeof IntersectionObserver !== 'undefined';
  const pagesLoaded = entries.data?.pages.length ?? 0;
  // A topic page can come back short or empty with a cursor (spec 8.6). With nothing to show yet the end of
  // the list is already in view, so keep asking until a page has rows or the cursor is null (TID-078 AC4).
  const keepLooking =
    topicSlug !== null && items.length === 0 && !!hasNextPage && !entries.isFetchNextPageError;
  useEffect(() => {
    if (keepLooking && !isFetchingNextPage) void fetchNextPage();
  }, [keepLooking, isFetchingNextPage, fetchNextPage, pagesLoaded]);
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
    // A page can come back with no new rows: the sentinel is still in view, so look again per page.
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, canObserve, items.length, pagesLoaded]);

  function setState(next: EntryListState) {
    const p = new URLSearchParams(params);
    p.set('state', next);
    setParams(p, { replace: true });
  }

  // TID-078: a chip changes `?topic=` with replace (Back leaves All articles, not every chip) and starts the
  // list at the top. The status line is read out because focus stays on the chip.
  const [announce, setAnnounce] = useState('');
  function chooseTopic(next: string | null) {
    const p = new URLSearchParams(params);
    if (next === null) p.delete('topic');
    else p.set('topic', next);
    setParams(p, { replace: true });
    window.scrollTo({ top: 0, behavior: 'auto' });
    setAnnounce(next === null ? 'Showing all articles' : `Showing ${topicName(next, topics.data)}`);
  }
  // An unknown, retired or no-longer-chosen topic, or any topic on a folder or feed, is "All": the
  // parameter is dropped without an error (not while an article covers the list).
  useEffect(() => {
    if (covered || !params.has('topic') || topicSlug !== null) return;
    const p = new URLSearchParams(params);
    p.delete('topic');
    setParams(p, { replace: true });
  }, [covered, params, topicSlug, setParams]);
  const chosenTopics = chips.flatMap((slug) => topics.data?.find((t) => t.id === slug) ?? []);
  // TID-078 amendment: with Unread only on, a chip shows only while that topic has unread articles (the
  // chosen one always stays, so the person is never stranded). No chip but All: no row. While the numbers
  // load a skeleton holds the place; if they cannot load, every chosen chip shows.
  const showRow = view === 'all' && chips.length > 0;
  const topicCounts = useTopicCounts(showRow && state === 'unread');
  const unreadByTopic = topicCounts.data?.topics;
  const shownTopics =
    state !== 'unread' || !unreadByTopic
      ? chosenTopics
      : chosenTopics.filter((t) => (unreadByTopic[t.id] ?? 0) > 0 || t.id === topicSlug);
  const countsLoading =
    state === 'unread' && topicCounts.isPending && topicCounts.fetchStatus === 'fetching';
  const chipRow = !showRow ? null : topics.data ? (
    countsLoading ? (
      <TopicChipsSkeleton chosen={chips.length} />
    ) : shownTopics.length === 0 ? null : (
      <TopicChips topics={shownTopics} selected={topicSlug} onSelect={chooseTopic} />
    )
  ) : topics.isPending && topics.fetchStatus === 'fetching' ? (
    <TopicChipsSkeleton chosen={chips.length} />
  ) : null;

  const notFound =
    entries.error instanceof ApiRequestError && entries.error.status === 404 && !entries.data;
  const subscription = view === 'feed' ? subscriptions.data?.find((s) => s.id === id) : undefined;
  const now = Date.now();

  // Nothing to list: no bottom bar either (owner, 2026-11-21); pull to refresh still works.
  const isEmpty =
    !notFound &&
    !entries.isPending &&
    !(entries.isError && !entries.data) &&
    items.length === 0 &&
    !hasNextPage;
  let body: ReactNode;
  if (notFound) {
    body = (
      <State title="We couldn't find that page.">
        <Link
          to="/all"
          replace={isStandalone()}
          className="inline-flex min-h-11 items-center text-accent underline"
        >
          Go to All articles
        </Link>
      </State>
    );
  } else if (entries.isPending && !entries.isError && topic && entries.fetchStatus === 'paused') {
    // Offline and this topic was never loaded here (UX 1.4a): say so instead of a skeleton that never ends.
    body = (
      <State title="This topic isn't saved on this device">
        <p>Reconnect to load {topic.name}.</p>
        <button type="button" onClick={() => chooseTopic(null)} className={BUTTON}>
          Show all topics
        </button>
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
  } else if (isEmpty) {
    body = (
      <Empty
        view={view}
        state={state}
        subscription={subscription}
        noSubscriptions={view === 'all' && subscriptions.data?.length === 0}
        topic={topic}
        onShowRead={() => setState('all')}
        onShowAll={() => chooseTopic(null)}
      />
    );
  } else {
    body = (
      <>
        {/* No note when Recommended falls back to newest first (owner, 2026-11-19): the list just
            shows newest first until there is enough to recommend. */}
        {items.length === 0 && hasNextPage && <Skeleton />}
        <ul ref={listRef} data-testid="article-grid" className={LIST_GRID}>
          {items.map((entry, i) => (
            <ArticleRow
              key={entry.id}
              entry={entry}
              to={`${base}/a/${entry.id}?state=${state}${topicSlug ? `&topic=${topicSlug}` : ''}`}
              now={now}
              prev={items[i - 1]}
            />
          ))}
        </ul>
        {!hasNextPage && (
          // A screen plus a little: the last rows can scroll fully past the header, so mark read on
          // scroll reaches them too (on every layout; the old 160 px desktop end left them unread).
          <div
            data-testid="list-end"
            className="flex min-h-[calc(100dvh-var(--header-h,0px)-var(--bar-h,0px)+2rem)] flex-col items-center justify-center gap-3 text-sm text-fg-muted"
          >
            {items.every((i) => i.isRead) && (
              <>
                <Check aria-hidden="true" className="size-5" strokeWidth={1.75} />
                <p>You&apos;re all caught up</p>
              </>
            )}
            <button
              type="button"
              onClick={() => void scrollTopThenRefresh()}
              disabled={pull === 'refreshing'}
              className={BUTTON}
            >
              <ArrowUp aria-hidden="true" className="size-5" strokeWidth={1.75} />
              Scroll to top
            </button>
          </div>
        )}
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
        {!isEmpty && (
          <button
            type="button"
            aria-label="Mark all as read"
            onClick={() => (toMark > MARK_ALL_CONFIRM_OVER ? setConfirming(true) : markAll())}
            disabled={!asOf || toMark === 0}
            className={HEADER_ICON}
          >
            <CheckCheck aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </button>
        )}
        <button
          ref={filterButton}
          type="button"
          aria-label="Filters"
          aria-haspopup="dialog"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(true)}
          className={`${HEADER_ICON} relative -mr-2`}
        >
          <SlidersHorizontal aria-hidden="true" className="size-6" strokeWidth={1.75} />
          {nonDefault && (
            <span
              data-testid="filter-dot"
              aria-hidden="true"
              className="absolute right-2 top-2 size-2 rounded-full bg-accent"
            />
          )}
        </button>
      </HeaderActions>
      <FilterPanel
        open={filtersOpen}
        onClose={closeFilters}
        unreadOnly={state === 'unread'}
        onUnreadOnly={(on) => setState(on ? 'unread' : 'all')}
        recommended={state === 'unread' ? sort === 'recommended' : null}
        onRecommended={(on) => void updateSettings({ listSort: on ? 'recommended' : 'newest' })}
        refreshing={pull === 'refreshing' || panelRefreshing}
        onRefresh={() => {
          setPanelRefreshing(true);
          void refresh().finally(() => setPanelRefreshing(false));
        }}
      />
      {confirming && (
        <Sheet
          title={
            topic
              ? `Mark ${formatCount(toMark)} ${topic.name} articles as read?`
              : `Mark ${formatCount(toMark)} articles as read?`
          }
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
      <div role="status" data-testid="topic-status" className="sr-only">
        {announce}
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
        {chipRow}
        {body}
      </div>
    </div>
  );
}
