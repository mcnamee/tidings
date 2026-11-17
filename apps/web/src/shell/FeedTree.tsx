import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, matchPath, useLocation } from 'react-router';
import { ChevronRight, Folder, Rss, TriangleAlert } from 'lucide-react';
import type { Counts, Folder as FolderModel, Subscription } from '@tidings/shared';
import { useCounts, useFolders, useSubscriptions } from '../lib/queries';
import { useSession } from '../lib/session';
import { hideReadFeeds, unreadOnlyDefault } from '../lib/settings';

const ROW =
  'flex min-h-11 min-w-0 flex-1 items-center gap-3 border-l-[3px] pr-4 text-base font-medium text-fg active:bg-sunken';
const CURRENT = 'border-accent bg-accent-subtle text-accent-subtle-fg';
const IDLE = 'border-transparent';
const OPEN_KEY = 'tidings.navOpen';

function readOpen(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeOpen(ids: string[]): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(ids));
  } catch {
    // storage blocked: the tree still works, it just forgets
  }
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

function Count({ n }: { n: number | undefined }) {
  if (!n) return null;
  return <span className="shrink-0 text-sm tabular-nums">{n > 999 ? '999+' : n}</span>;
}

const label = (name: string, n: number | undefined) =>
  n ? `${name}, ${n > 999 ? '999+' : n} unread` : name;

function FeedLink({
  sub,
  n,
  dim,
  indent,
  replace,
}: {
  sub: Subscription;
  n: number | undefined;
  dim: boolean;
  indent: boolean;
  replace: boolean;
}) {
  const problem = ['failing', 'dead', 'gone'].includes(sub.health.state);
  return (
    <NavLink
      to={`/feeds/${sub.id}`}
      replace={replace}
      aria-label={label(sub.title, n)}
      className={({ isActive }) =>
        `${ROW} ${isActive ? CURRENT : IDLE} ${indent ? 'pl-[2.75rem]' : 'pl-[13px]'} ${
          dim && !isActive ? 'text-fg-muted' : ''
        }`
      }
    >
      {problem ? (
        <TriangleAlert
          role="img"
          aria-label="This feed has problems"
          className="size-5 shrink-0 text-warning"
          strokeWidth={1.75}
        />
      ) : (
        <Rss aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
      )}
      <span className="min-w-0 flex-1 truncate">{sub.title}</span>
      <Count n={n} />
    </NavLink>
  );
}

function Skeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading feeds" className="py-1" data-testid="tree-skeleton">
      {['w-3/5', 'w-2/5', 'w-3/4', 'w-1/2', 'w-2/3', 'w-[45%]'].map((w, i) => (
        <li key={i} className="flex min-h-11 items-center gap-3 px-4">
          <span className="size-5 shrink-0 animate-skeleton rounded-sm bg-sunken" />
          <span className={`h-4 animate-skeleton rounded-sm bg-sunken ${w}`} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The tree under "All articles" (docs/ux/screens/app-shell.md 3): folders A to Z, each expandable
 * to its feeds, then feeds with no folder, each with its unread count. One component for the
 * drawer and the sidebar; `replace` makes its links replace the drawer's history entry.
 */
export function FeedTree({ replace }: { replace: boolean }) {
  const folders = useFolders();
  const subscriptions = useSubscriptions();
  const counts = useCounts();
  const session = useSession();
  const { pathname } = useLocation();
  const [opened, setOpened] = useState<string[]>(readOpen);

  const settings = session.data?.user?.settings;
  const unreadOnly = unreadOnlyDefault(settings);
  const hideRead = unreadOnly && hideReadFeeds(settings);
  const currentFeed = matchPath('/feeds/:id', pathname)?.params.id ?? null;
  const currentFolder = matchPath('/folders/:id', pathname)?.params.id ?? null;

  useEffect(() => writeOpen(opened), [opened]);

  const { folderList, feedsOf, loose } = useMemo(() => {
    const fs = [...(folders.data ?? [])].sort((a, b) => byName(a.name, b.name));
    const ids = new Set(fs.map((f) => f.id));
    const subs = [...(subscriptions.data ?? [])].sort((a, b) => byName(a.title, b.title));
    const of = new Map<string, Subscription[]>();
    const rest: Subscription[] = [];
    for (const s of subs) {
      if (s.folderId !== null && ids.has(s.folderId)) {
        of.set(s.folderId, [...(of.get(s.folderId) ?? []), s]);
      } else rest.push(s);
    }
    return { folderList: fs, feedsOf: of, loose: rest };
  }, [folders.data, subscriptions.data]);

  function retryAll() {
    void folders.refetch();
    void subscriptions.refetch();
  }
  // An error with data in the cache keeps the cached tree (app-shell.md 3); only a cold failure shows.
  if ((folders.isError && !folders.data) || (subscriptions.isError && !subscriptions.data)) {
    return <TreeError retry={retryAll} />;
  }
  if (!folders.data || !subscriptions.data) return <Skeleton />;

  if (folderList.length === 0 && loose.length === 0) {
    return (
      <div className="px-4 py-4">
        <h2 className="text-base font-semibold text-fg">No feeds yet</h2>
        <p className="mt-1 text-sm text-fg-muted">Add a feed or import your OPML file.</p>
        <p className="mt-2 flex flex-col text-base">
          <Link
            to="/manage/add"
            replace={replace}
            className="inline-flex min-h-11 items-center text-accent underline"
          >
            Add a feed
          </Link>
          <Link
            to="/manage/import"
            replace={replace}
            className="inline-flex min-h-11 items-center text-accent underline"
          >
            Import from Inoreader
          </Link>
        </p>
      </div>
    );
  }

  const c: Counts | undefined = counts.data;
  const feedCount = (s: Subscription) => c?.subscriptions[s.id] ?? (c ? 0 : undefined);
  const folderCount = (f: FolderModel) => c?.folders[f.id] ?? (c ? 0 : undefined);
  const zero = (n: number | undefined) => unreadOnly && n === 0;
  const showFeed = (s: Subscription) => !(hideRead && feedCount(s) === 0) || s.id === currentFeed;

  function toggle(id: string, isOpen: boolean) {
    setOpened((prev) => (isOpen ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <ul>
      {folderList.map((f) => {
        const feeds = feedsOf.get(f.id) ?? [];
        const n = folderCount(f);
        const visible = feeds.filter(showFeed);
        const containsCurrent = feeds.some((s) => s.id === currentFeed);
        if (hideRead && n === 0 && f.id !== currentFolder && !containsCurrent) return null;
        const isOpen = opened.includes(f.id) || containsCurrent;
        const listId = `folder-feeds-${f.id}`;
        return (
          <li key={f.id}>
            <div className="flex items-center">
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={listId}
                aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${f.name}`}
                onClick={() => toggle(f.id, opened.includes(f.id))}
                className="inline-flex size-11 shrink-0 items-center justify-center text-fg"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={`size-5 ${isOpen ? 'rotate-90' : ''}`}
                  strokeWidth={1.75}
                />
              </button>
              <NavLink
                to={`/folders/${f.id}`}
                replace={replace}
                end
                aria-label={label(f.name, n)}
                className={({ isActive }) =>
                  `${ROW} ${isActive ? CURRENT : IDLE} pl-1 ${
                    zero(n) && !isActive ? 'text-fg-muted' : ''
                  }`
                }
              >
                <Folder aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <Count n={n} />
              </NavLink>
            </div>
            {isOpen && (
              <ul id={listId}>
                {visible.map((s) => (
                  <li key={s.id}>
                    <FeedLink
                      sub={s}
                      n={feedCount(s)}
                      dim={zero(feedCount(s))}
                      indent
                      replace={replace}
                    />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
      {loose.filter(showFeed).map((s) => (
        <li key={s.id}>
          <FeedLink
            sub={s}
            n={feedCount(s)}
            dim={zero(feedCount(s))}
            indent={false}
            replace={replace}
          />
        </li>
      ))}
    </ul>
  );
}

function TreeError({ retry }: { retry: () => void }) {
  return (
    <div className="px-4 py-4" role="alert">
      <p className="text-base text-fg">Couldn&apos;t load your feeds.</p>
      <button
        type="button"
        onClick={retry}
        className="mt-2 inline-flex min-h-11 items-center rounded-md border border-line-strong px-4 text-base font-medium text-fg"
      >
        Try again
      </button>
    </div>
  );
}
