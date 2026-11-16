import { vi } from 'vitest';

export interface FakeMedia {
  /** Flip a query's match state and notify its listeners, like an OS or viewport change. */
  set(query: string, matches: boolean): void;
}

/** jsdom has no matchMedia. Install a controllable one; `initial` maps query substring to state. */
export function installMatchMedia(initial: Record<string, boolean> = {}): FakeMedia {
  const state = new Map<string, boolean>(Object.entries(initial));
  const lists = new Map<string, Set<(e: MediaQueryListEvent) => void>>();
  const matches = (q: string) => [...state].some(([k, v]) => q.includes(k) && v);
  window.matchMedia = vi.fn((query: string) => {
    const set = lists.get(query) ?? new Set();
    lists.set(query, set);
    return {
      get matches() {
        return matches(query);
      },
      media: query,
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => set.add(fn),
      removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => set.delete(fn),
      addListener: (fn: (e: MediaQueryListEvent) => void) => set.add(fn),
      removeListener: (fn: (e: MediaQueryListEvent) => void) => set.delete(fn),
      dispatchEvent: () => true,
      onchange: null,
    } as unknown as MediaQueryList;
  });
  return {
    set(query, value) {
      state.set(query, value);
      for (const [q, set] of lists) {
        if (q.includes(query))
          set.forEach((fn) => fn({ matches: matches(q) } as MediaQueryListEvent));
      }
    },
  };
}
