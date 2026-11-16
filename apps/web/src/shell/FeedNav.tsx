import { Link, NavLink } from 'react-router';
import { Inbox, ListChecks, Plus, Settings } from 'lucide-react';

const ROW =
  'flex min-h-11 items-center gap-3 border-l-[3px] px-4 text-base font-medium text-fg active:bg-sunken';
const CURRENT = 'border-accent bg-accent-subtle text-accent-subtle-fg';
const IDLE = 'border-transparent';

/**
 * Feed tree plus the pinned footer. One component, two containers (drawer and sidebar).
 * Real folders, feeds and counts arrive with TID-018; until then the tree is "All articles" and
 * the empty state. `replace` makes destination links replace the drawer's history entry.
 */
export function FeedNav({ replace = false }: { replace?: boolean }) {
  return (
    <nav aria-label="Feeds and folders" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2">
        <NavLink
          to="/all"
          replace={replace}
          className={({ isActive }) => `${ROW} ${isActive ? CURRENT : IDLE}`}
        >
          <Inbox aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate">All articles</span>
        </NavLink>
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
      </div>
      <div className="border-t border-line p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Link
          to="/manage/add"
          replace={replace}
          className="flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-fg"
        >
          <Plus aria-hidden="true" className="size-5" strokeWidth={1.75} />
          Add feed
        </Link>
        <div className="mt-2 flex gap-2">
          <Link
            to="/manage"
            replace={replace}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line-strong px-2 text-base font-medium text-fg"
          >
            <ListChecks aria-hidden="true" className="size-5" strokeWidth={1.75} />
            Manage
          </Link>
          <Link
            to="/settings"
            replace={replace}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line-strong px-2 text-base font-medium text-fg"
          >
            <Settings aria-hidden="true" className="size-5" strokeWidth={1.75} />
            Settings
          </Link>
        </div>
      </div>
    </nav>
  );
}
