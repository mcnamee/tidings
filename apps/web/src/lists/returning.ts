// FR-RD-4: in unread-only mode an article read while the list is loaded stays in it (shown as
// read) until the person leaves the list and comes back, or pulls to refresh. Back from an article
// is "still in the list"; any other arrival is "came back", which starts from a fresh page 1.
// Opening an article records which list it was opened from; the list reads that on its next mount.

let openedFrom: string | null = null;
let openedAt = 0;

/** Remembers the list an article was opened from and how far it was scrolled (TID-019 AC7). */
export function markOpened(listKey: string): void {
  openedFrom = listKey;
  openedAt = window.scrollY;
}

export function scrollOf(listKey: string): number {
  return openedFrom === listKey ? openedAt : 0;
}

export function wasOpenedFrom(listKey: string): boolean {
  return openedFrom === listKey;
}

export function clearOpened(): void {
  openedFrom = null;
}
