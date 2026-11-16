// Toast store (design: docs/ux/screens/app-shell.md section 2.4).
// One toast on screen at a time; an Undo toast is never replaced by an info/success toast;
// errors replace anything except Undo and queue behind it (queue of 1, newest wins).
export type ToastKind = 'info' | 'success' | 'error' | 'undo';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  /** ms; null means the toast stays until dismissed. */
  duration: number | null;
}

export interface ToastOptions {
  action?: ToastAction;
  duration?: number | null;
}

const DURATION: Record<ToastKind, number> = { info: 4000, success: 4000, undo: 5000, error: 8000 };
const MIN_WITH_ACTION = 5000;

export interface ToastStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ToastItem | null;
  show(kind: ToastKind, message: string, options?: ToastOptions): number;
  dismiss(id?: number): void;
  pause(): void;
  resume(): void;
}

interface Timers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (h: ReturnType<typeof setTimeout>) => void;
  now: () => number;
}

export function createToastStore(
  timers: Timers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h),
    now: () => Date.now(),
  },
): ToastStore {
  const listeners = new Set<() => void>();
  let current: ToastItem | null = null;
  let queued: ToastItem | null = null;
  let nextId = 1;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let remaining = 0;
  let startedAt = 0;

  const emit = () => listeners.forEach((l) => l());

  function stopTimer() {
    if (handle !== null) timers.clear(handle);
    handle = null;
  }
  function startTimer(ms: number) {
    stopTimer();
    remaining = ms;
    startedAt = timers.now();
    const id = current?.id;
    handle = timers.set(() => store.dismiss(id), ms);
  }
  function present(item: ToastItem) {
    current = item;
    if (item.duration === null) stopTimer();
    else startTimer(item.duration);
  }

  const store: ToastStore = {
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => current,
    show(kind, message, options = {}) {
      let duration = options.duration === undefined ? DURATION[kind] : options.duration;
      if (duration !== null && options.action) duration = Math.max(duration, MIN_WITH_ACTION);
      const item: ToastItem = {
        id: nextId++,
        kind,
        message,
        duration,
        ...(options.action ? { action: options.action } : {}),
      };
      if (current?.kind === 'undo' && kind !== 'undo') {
        queued = item; // waits behind the Undo toast, newest wins
      } else {
        if (kind === 'undo') queued = null;
        present(item);
      }
      emit();
      return item.id;
    },
    dismiss(id) {
      if (!current || (id !== undefined && id !== current.id)) {
        if (id !== undefined && queued?.id === id) {
          queued = null;
          emit();
        }
        return;
      }
      stopTimer();
      current = null;
      if (queued) {
        const next = queued;
        queued = null;
        present(next);
      }
      emit();
    },
    pause() {
      if (handle === null) return;
      stopTimer();
      remaining = Math.max(0, remaining - (timers.now() - startedAt));
    },
    resume() {
      if (!current || current.duration === null || handle !== null) return;
      startTimer(remaining);
    },
  };
  return store;
}

export const toastStore = createToastStore();

export const toast = {
  info: (message: string, options?: ToastOptions) => toastStore.show('info', message, options),
  success: (message: string, options?: ToastOptions) =>
    toastStore.show('success', message, options),
  error: (message: string, options?: ToastOptions) => toastStore.show('error', message, options),
  undo: (message: string, onUndo: () => void) =>
    toastStore.show('undo', message, { action: { label: 'Undo', run: onUndo } }),
  dismiss: (id?: number) => toastStore.dismiss(id),
};
