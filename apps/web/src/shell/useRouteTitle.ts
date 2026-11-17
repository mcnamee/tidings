import { matchPath } from 'react-router';
import type { RouteMeta } from '../routes/table';
import { useFolders, useSubscriptions } from '../lib/queries';

export interface RouteTitle {
  /** The visible header text, or null while the name loads (the header shows a skeleton). */
  heading: string | null;
  /** The `document.title` text before " - Tidings"; "Folder" and "Feed" only while loading. */
  documentTitle: string;
}

/**
 * Header title for a route (docs/ux/screens/app-shell.md 10.1). Folder and feed list and article routes take
 * their name from the cached folders and subscriptions, so a warm cache shows it at once and a
 * cold one shows a skeleton, never the word "Folder" or "Feed". A folder or feed that is not in a
 * loaded list is "Page not found". Every other route keeps its static title.
 */
export function useRouteTitle(route: RouteMeta, pathname: string): RouteTitle {
  // Article routes (`/folders/:id/a/:entryId`) are titled by the list they belong to.
  const named = route.kind === 'list' || route.kind === 'article';
  const folderId = named ? matchPath('/folders/:id/*', pathname)?.params.id : undefined;
  const feedId = named ? matchPath('/feeds/:id/*', pathname)?.params.id : undefined;
  const folders = useFolders(folderId !== undefined);
  const subscriptions = useSubscriptions(feedId !== undefined);

  if (folderId !== undefined) {
    if (!folders.data) return { heading: null, documentTitle: route.title };
    const name = folders.data.find((f) => f.id === folderId)?.name;
    return name === undefined
      ? { heading: 'Page not found', documentTitle: 'Page not found' }
      : { heading: name, documentTitle: name };
  }
  if (feedId !== undefined) {
    if (!subscriptions.data) return { heading: null, documentTitle: route.title };
    const title = subscriptions.data.find((s) => s.id === feedId)?.title;
    return title === undefined
      ? { heading: 'Page not found', documentTitle: 'Page not found' }
      : { heading: title, documentTitle: title };
  }
  return { heading: route.title, documentTitle: route.title };
}
