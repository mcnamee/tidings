import { useEffect, useRef, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { toastStore, type ToastItem, type ToastStore } from '../lib/toast';

function ToastCard({ item, store }: { item: ToastItem; store: ToastStore }) {
  const card = useRef<HTMLDivElement>(null);
  // Native listeners: pause the timer on hover, focus or touch; Escape dismisses.
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const pause = () => store.pause();
    const resume = () => store.resume();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.dismiss(item.id);
    };
    const pairs: Array<[string, () => void]> = [
      ['mouseenter', pause],
      ['mouseleave', resume],
      ['focusin', pause],
      ['focusout', resume],
      ['touchstart', pause],
      ['touchend', resume],
    ];
    pairs.forEach(([ev, fn]) => el.addEventListener(ev, fn));
    el.addEventListener('keydown', onKey);
    return () => {
      pairs.forEach(([ev, fn]) => el.removeEventListener(ev, fn));
      el.removeEventListener('keydown', onKey);
    };
  }, [store, item.id]);
  return (
    <div
      ref={card}
      className="toast-item pointer-events-auto mx-auto flex w-full max-w-md items-center gap-2 rounded-md border border-line bg-toast py-1 pl-4 text-base text-toast-fg shadow-raised"
    >
      <p className="line-clamp-2 min-w-0 flex-1 py-2">{item.message}</p>
      {item.action && (
        <button
          type="button"
          className="min-h-11 min-w-11 rounded-sm px-3 font-medium text-toast-action"
          onClick={() => {
            item.action?.run();
            store.dismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      {item.kind === 'error' && (
        <button
          type="button"
          aria-label="Dismiss"
          className="inline-flex size-11 items-center justify-center rounded-sm"
          onClick={() => store.dismiss(item.id)}
        >
          <X aria-hidden="true" className="size-5" />
        </button>
      )}
    </div>
  );
}

/**
 * Two persistent live regions exist from first render so the first message is announced:
 * a polite status for info, success and undo, and an alert for errors.
 */
export function Toasts({ store = toastStore }: { store?: ToastStore }) {
  const current = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
  const isError = current?.kind === 'error';
  return (
    <section
      id="toasts"
      aria-label="Notifications"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--bottom-offset,0px)+env(safe-area-inset-bottom)+0.75rem)] z-40 px-4 lg:left-72"
    >
      <div role="status" aria-live="polite">
        {current && !isError && <ToastCard key={current.id} item={current} store={store} />}
      </div>
      <div role="alert">
        {current && isError && <ToastCard key={current.id} item={current} store={store} />}
      </div>
    </section>
  );
}
