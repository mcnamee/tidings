import { Link, NavLink } from 'react-router';
import { Inbox, ListChecks, Plus, Settings } from 'lucide-react';
import { useCounts } from '../lib/queries';
import { Count, FeedTree } from './FeedTree';

const ROW =
  'flex min-h-11 items-center gap-3 border-l-[3px] px-4 text-base font-medium text-fg active:bg-sunken';
const CURRENT = 'border-accent bg-accent-subtle text-accent-subtle-fg';
const IDLE = 'border-transparent';

/**
 * Feed tree plus the pinned footer. One component, two containers (drawer and sidebar).
 * `replace` makes destination links replace the drawer's history entry.
 */
export function FeedNav({ replace = false }: { replace?: boolean }) {
  const total = useCounts().data?.total;
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
          <Count n={total} />
        </NavLink>
        <FeedTree replace={replace} />
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
        <div className="mt-2 flex flex-wrap gap-2">
          <Link
            to="/manage"
            replace={replace}
            className="flex min-h-11 min-w-fit flex-1 items-center justify-center gap-2 rounded-md border border-line-strong px-2 text-base font-medium text-fg"
          >
            <ListChecks aria-hidden="true" className="size-5" strokeWidth={1.75} />
            Manage
          </Link>
          <Link
            to="/settings"
            replace={replace}
            className="flex min-h-11 min-w-fit flex-1 items-center justify-center gap-2 rounded-md border border-line-strong px-2 text-base font-medium text-fg"
          >
            <Settings aria-hidden="true" className="size-5" strokeWidth={1.75} />
            Settings
          </Link>
        </div>
      </div>
    </nav>
  );
}
