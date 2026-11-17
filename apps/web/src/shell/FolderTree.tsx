import { NavLink } from 'react-router';
import { Folder as FolderIcon, Rss } from 'lucide-react';
import { groupByFolder, sortedFolders, useFolders, useSubscriptions } from '../manage/data';

const ROW =
  'flex min-h-11 items-center gap-3 border-l-[3px] px-4 text-base font-medium text-fg active:bg-sunken';
const CURRENT = 'border-accent bg-accent-subtle text-accent-subtle-fg';
const IDLE = 'border-transparent';

/**
 * TID-014: the drawer's folders and feeds (FR-FO-2, FR-FO-4): folders first, each with its feeds
 * indented beneath it, then feeds with no folder. Alphabetical, case-insensitive. Counts and
 * the collapse chevron arrive with TID-018.
 */
export function FolderTree({ replace = false }: { replace?: boolean }) {
  const folders = sortedFolders(useFolders().data?.items);
  const groups = groupByFolder(useSubscriptions().data?.items);
  const link = (to: string, label: string, kind: 'folder' | 'feed') => (
    <NavLink
      key={to}
      to={to}
      replace={replace}
      className={({ isActive }) => `${ROW} ${isActive ? CURRENT : IDLE}`}
    >
      {kind === 'folder' ? (
        <FolderIcon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
      ) : (
        <Rss aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </NavLink>
  );
  return (
    <>
      {folders.map((f) => (
        <div key={f.id}>
          {link(`/folders/${f.id}`, f.name, 'folder')}
          <div className="pl-5">
            {(groups.get(f.id) ?? []).map((s) => link(`/feeds/${s.id}`, s.title, 'feed'))}
          </div>
        </div>
      ))}
      {(groups.get(null) ?? []).map((s) => link(`/feeds/${s.id}`, s.title, 'feed'))}
    </>
  );
}

/** True when there are folders or feeds to list, so the "No feeds yet" state is not shown. */
export function useHasTree(): boolean {
  const folders = useFolders().data?.items.length ?? 0;
  const subs = useSubscriptions().data?.items.length ?? 0;
  return folders + subs > 0;
}
