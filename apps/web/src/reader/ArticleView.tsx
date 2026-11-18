import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import type { Entry, EntryListState, EntrySummary } from '@tidings/shared';
import { ApiRequestError } from '../api';
import { useEntries, useEntry } from '../lib/queries';
import { setEntryRead } from '../lib/readState';
import { useSession } from '../lib/session';
import { markReadOnOpen, unreadOnlyDefault } from '../lib/settings';
import { toast } from '../lib/toast';
import { BottomBar, HeaderActions } from '../shell/slots';
import { ArticleContent } from './ArticleContent';
import { ArticleLayer, type StepState } from './ArticleLayer';

const BAR_BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-1 rounded-md px-2 text-base font-medium text-fg active:bg-sunken disabled:text-fg-muted';
// Previous and Next show only their chevron below 26rem (416 px, and at any large text size, since
// rem grows with it), so the three actions fit on one row. The words stay as the accessible name.
const BAR_STEP = `${BAR_BUTTON} min-w-14 flex-none min-[26rem]:flex-1`;
const BAR_STEP_LABEL = 'max-[26rem]:sr-only';

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Where this article was opened from: the list's view, its ID and the path of the list itself. */
function listContext(pathname: string, params: Record<string, string | undefined>) {
  const base = pathname.replace(/\/a\/[^/]+$/, '');
  if (pathname.startsWith('/folders/')) {
    return { view: 'folder' as const, id: params.folderId ?? '', base };
  }
  if (pathname.startsWith('/feeds/')) {
    return { view: 'feed' as const, id: params.subscriptionId ?? '', base };
  }
  return { view: 'all' as const, id: null, base };
}

/** The list's own summary of an entry, used until the full entry arrives. */
function fromList(
  items: EntrySummary[],
  entryId: string,
): (Entry & { contentHtml: null }) | undefined {
  const found = items.find((i) => i.id === entryId);
  return found ? { ...found, contentHtml: null } : undefined;
}

function Skeleton() {
  return (
    <div aria-busy="true" data-testid="article-skeleton" className="space-y-3">
      <div className="h-4 w-5/6 animate-skeleton rounded-sm bg-sunken" />
      <div className="h-4 w-full animate-skeleton rounded-sm bg-sunken" />
      <div className="h-4 w-11/12 animate-skeleton rounded-sm bg-sunken" />
      <div className="h-4 w-2/3 animate-skeleton rounded-sm bg-sunken" />
    </div>
  );
}

/**
 * The article screens (`/all/a/:id`, `/folders/:id/a/:id`, `/feeds/:id/a/:id`), FR-RD-7 and
 * FR-RD-8, shown as a layer above the list (ArticleLayer). Previous and Next walk the list the article was opened from, in its order, using
 * history `replace` so Back is always one step to the list (spec 11.1).
 */
export function ArticleRoute() {
  const { entryId = '', ...params } = useParams();
  const { pathname } = useLocation();
  const [search] = useSearchParams();
  const session = useSession();
  const navigate = useNavigate();
  const { view, id, base } = listContext(pathname, params);

  const asParam = search.get('state');
  const state: EntryListState =
    asParam === 'all' || asParam === 'unread'
      ? asParam
      : unreadOnlyDefault(session.data?.user?.settings)
        ? 'unread'
        : 'all';
  // The list is only read here, never refetched on mount: Back must show the list as it was.
  const list = useEntries(view, id, state, false);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const index = items.findIndex((i) => i.id === entryId);
  const [loadingMore, setLoadingMore] = useState(false);

  const go = (to: EntrySummary, step: -1 | 1) =>
    navigate(`${base}/a/${to.id}?state=${state}`, {
      replace: true,
      state: { step } satisfies StepState,
    });

  async function step(dir: -1 | 1) {
    if (index < 0 || loadingMore) return;
    let all = items;
    if (dir === 1 && index === items.length - 1 && list.hasNextPage) {
      setLoadingMore(true);
      try {
        const r = await list.fetchNextPage({ throwOnError: true });
        all = r.data?.pages.flatMap((p) => p.items) ?? items;
      } catch {
        toast.error("Couldn't load more articles. Try again.");
        return;
      } finally {
        setLoadingMore(false);
      }
    }
    const target = all[index + dir];
    if (target) go(target, dir);
  }

  const hasPrev = index > 0;
  const hasNext = index >= 0 && (index < items.length - 1 || list.hasNextPage);

  return (
    <ArticleLayer contentKey={entryId}>
      <ArticleScreen
        key={entryId}
        entryId={entryId}
        items={items}
        hasPrev={hasPrev}
        hasNext={hasNext}
        busy={loadingMore}
        onStep={(dir) => void step(dir)}
      />
    </ArticleLayer>
  );
}

function ArticleScreen({
  entryId,
  items,
  hasPrev,
  hasNext,
  busy,
  onStep,
}: {
  entryId: string;
  items: EntrySummary[];
  hasPrev: boolean;
  hasNext: boolean;
  busy: boolean;
  onStep: (dir: -1 | 1) => void;
}) {
  const client = useQueryClient();
  const session = useSession();
  const detail = useEntry(entryId, () => fromList(items, entryId));
  const entry = detail.data;
  const loaded = !!entry && !detail.isPlaceholderData;

  // A new article starts at the top: the layer gives each one a fresh scroll container.

  // FR-RD-8: opening an unread article marks it read, once. "Mark as unread" then sticks.
  const attempted = useRef(false);
  const autoMark = markReadOnOpen(session.data?.user?.settings);
  useEffect(() => {
    if (!entry || !loaded || attempted.current) return;
    attempted.current = true;
    if (autoMark && !entry.isRead) void setEntryRead(client, entry, true);
  }, [entry, loaded, autoMark, client]);

  if (detail.isError && !loaded) {
    const gone = detail.error instanceof ApiRequestError && detail.error.status === 404;
    return (
      <div className="px-2 py-10 text-center">
        <h2 className="text-lg font-semibold text-fg">
          {gone ? "We couldn't find that article." : 'Something went wrong on our side.'}
        </h2>
        {!gone && (
          <button
            type="button"
            onClick={() => void detail.refetch()}
            className="mt-3 inline-flex min-h-11 items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg active:bg-sunken"
          >
            Try again
          </button>
        )}
      </div>
    );
  }
  if (!entry) return <Skeleton />;

  const title = entry.title?.trim() || 'Untitled article';
  return (
    <article className="mx-auto max-w-[65ch]">
      {entry.url && (
        <HeaderActions>
          <a
            href={entry.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open original"
            className="inline-flex size-11 items-center justify-center rounded-md text-fg active:bg-sunken"
          >
            <ExternalLink aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </a>
        </HeaderActions>
      )}
      <BottomBar>
        <button
          type="button"
          onClick={() => onStep(-1)}
          disabled={!hasPrev || busy}
          className={BAR_STEP}
        >
          <ChevronLeft aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
          <span className={BAR_STEP_LABEL}>Previous</span>
        </button>
        <button
          type="button"
          onClick={() => void setEntryRead(client, entry, !entry.isRead)}
          disabled={!loaded}
          className={`${BAR_BUTTON} flex-[2] text-center`}
        >
          {entry.isRead ? 'Mark as unread' : 'Mark as read'}
        </button>
        <button
          type="button"
          onClick={() => onStep(1)}
          disabled={!hasNext || busy}
          className={BAR_STEP}
        >
          <span className={BAR_STEP_LABEL}>Next</span>
          {busy ? (
            <Loader2 aria-hidden="true" className="size-5 shrink-0 animate-spin" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
          )}
        </button>
      </BottomBar>

      {/* Title, feed, author and date are feed text: rendered as text, never as HTML (spec 10.5). */}
      <h2 className="break-words text-[1.75rem] font-bold leading-tight text-fg md:text-4xl">
        {entry.url ? (
          // TID-054: the title opens the original, like the header's Open original button.
          <a
            href={entry.url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm text-inherit no-underline hover:text-accent active:text-accent"
          >
            {title}
          </a>
        ) : (
          title
        )}
      </h2>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-fg-muted">
        <span>{entry.feedTitle}</span>
        {entry.author && (
          <>
            <span aria-hidden="true">&middot;</span>
            <span>{entry.author}</span>
          </>
        )}
        <span aria-hidden="true">&middot;</span>
        <time dateTime={entry.publishedAt}>{DATE.format(new Date(entry.publishedAt))}</time>
      </p>
      <div className="mt-6">
        {!loaded ? (
          <Skeleton />
        ) : entry.contentHtml ? (
          <ArticleContent html={entry.contentHtml} entryUrl={entry.url} />
        ) : (
          <p className="text-base text-fg-muted">
            This article has no content here.
            {entry.url ? ' Use Open original to read it on the website.' : ''}
          </p>
        )}
      </div>
    </article>
  );
}
