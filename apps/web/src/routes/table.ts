import { matchPath } from 'react-router';

// Route table for spec 11.1 and the chrome contract in docs/ux/FLOWS.md 1.3.
export type RouteKind = 'auth' | 'list' | 'article' | 'top' | 'sub';

export interface RouteMeta {
  path: string;
  title: string;
  kind: RouteKind;
  /** Where the header Back button goes when there is no history to return to. */
  parent?: string;
}

export const ROUTES: RouteMeta[] = [
  { path: '/setup', title: 'Set up Tidings', kind: 'auth' },
  { path: '/login', title: 'Sign in', kind: 'auth' },
  { path: '/recover', title: 'Use a recovery code', kind: 'auth' },
  { path: '/all', title: 'All articles', kind: 'list' },
  { path: '/folders/:folderId', title: 'Folder', kind: 'list' },
  { path: '/feeds/:subscriptionId', title: 'Feed', kind: 'list' },
  { path: '/all/a/:entryId', title: 'Feed', kind: 'article' },
  { path: '/folders/:folderId/a/:entryId', title: 'Feed', kind: 'article' },
  { path: '/feeds/:subscriptionId/a/:entryId', title: 'Feed', kind: 'article' },
  { path: '/manage', title: 'Manage feeds', kind: 'top' },
  { path: '/manage/add', title: 'Add a feed', kind: 'sub', parent: '/manage' },
  { path: '/manage/import', title: 'Import from OPML', kind: 'sub', parent: '/manage' },
  { path: '/settings', title: 'Settings', kind: 'top' },
];

export const NOT_FOUND: RouteMeta = { path: '*', title: 'Page not found', kind: 'top' };

export function findRoute(pathname: string): RouteMeta {
  for (const r of ROUTES) {
    if (!matchPath({ path: r.path, end: true }, pathname)) continue;
    // The parent of an article is its list: the path without the /a/:entryId tail.
    if (r.kind === 'article') return { ...r, parent: pathname.replace(/\/a\/[^/]+$/, '') };
    return r;
  }
  return NOT_FOUND;
}
