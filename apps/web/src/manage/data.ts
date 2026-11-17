import type { Folder, Subscription } from '@tidings/shared';

// One cache shape for folders and subscriptions (the `items` arrays), shared with the drawer.
export { FOLDERS_KEY, SUBSCRIPTIONS_KEY, useFolders, useSubscriptions } from '../lib/queries';

/** FR-FO-4: alphabetical, case-insensitive. */
const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

export function sortedFolders(items: Folder[] | undefined): Folder[] {
  return [...(items ?? [])].sort((a, b) => compare(a.name, b.name));
}

/** Subscriptions grouped by folder ID (null = top level), each group sorted by title. */
export function groupByFolder(
  items: Subscription[] | undefined,
): Map<string | null, Subscription[]> {
  const groups = new Map<string | null, Subscription[]>();
  for (const s of [...(items ?? [])].sort((a, b) => compare(a.title, b.title))) {
    const list = groups.get(s.folderId) ?? [];
    list.push(s);
    groups.set(s.folderId, list);
  }
  return groups;
}
