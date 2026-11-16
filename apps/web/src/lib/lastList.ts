// The last list the user viewed, kept on the device so "/" can reopen it (FLOWS 1.8).
const KEY = 'tidings.lastList';
const LIST_PATH = /^\/(all|folders\/[A-Za-z0-9_-]+|feeds\/[A-Za-z0-9_-]+)$/;

export function isListPath(path: string): boolean {
  return LIST_PATH.test(path);
}

export function saveLastList(path: string, storage: Pick<Storage, 'setItem'> = localStorage): void {
  if (!isListPath(path)) return;
  try {
    storage.setItem(KEY, path);
  } catch {
    // storage blocked: not worth failing for
  }
}

/** Always returns a safe in-app list path; falls back to /all. */
export function readLastList(storage: Pick<Storage, 'getItem'> = localStorage): string {
  try {
    const v = storage.getItem(KEY);
    if (v && isListPath(v)) return v;
  } catch {
    // fall through
  }
  return '/all';
}
