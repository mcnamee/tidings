import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ChevronDown, ChevronUp, CircleMinus, GripVertical, Plus } from 'lucide-react';
import type { Topic } from '@tidings/shared';
import { useOffline } from '../lib/connectivity';
import { toast } from '../lib/toast';
import { useTopics } from '../lib/topics';
import { prefersReducedMotion } from '../lib/useSwipe';
import { useTopicChips } from './useTopicChips';

/**
 * Settings, Topics (`/settings/topics`): TID-078, FR-ST-5, docs/ux/screens/topics.md part 2. Every topic is
 * either on the chips (in order) or in "Other topics". Each change saves by itself (useTopicChips). The order is
 * set by dragging a row's grip (pointer, touch) or with the Move up and Move down buttons (keyboard and screen
 * reader), and every change is announced in a polite live region.
 */

const CARD = 'mt-2 divide-y divide-line rounded-lg border border-line bg-surface';
const ROW = 'flex min-h-14 items-center gap-1 px-1';
const ICON =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-md text-fg-muted active:bg-sunken aria-disabled:opacity-40';
const BUTTON =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-1 rounded-md border border-line-strong bg-surface px-3 text-base font-medium text-fg active:bg-sunken aria-disabled:opacity-40';
/** px from the bottom of the viewport, or below the header, where a drag scrolls the page. */
const SCROLL_ZONE = 64;
const MAX_SCROLL_STEP = 12;

type Focus = { slug: string; control: 'remove' | 'up' | 'down' } | { heading: true };

function Skeleton() {
  const block = (n: number) => (
    <div className={CARD}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="h-14 animate-skeleton bg-sunken" />
      ))}
    </div>
  );
  return (
    <div
      aria-busy="true"
      aria-label="Loading topics"
      data-testid="topics-skeleton"
      className="mt-6"
    >
      <div className="h-7 w-40 animate-skeleton rounded-md bg-sunken" />
      {block(4)}
      <div className="mt-6 h-7 w-40 animate-skeleton rounded-md bg-sunken" />
      {block(4)}
    </div>
  );
}

export function Topics() {
  const topics = useTopics();
  const offline = useOffline();
  const [announce, setAnnounce] = useState('');
  const { chips, setChips } = useTopicChips(() => setAnnounce("Couldn't save. Topics put back."));
  const chosenId = useId();
  const otherId = useId();
  const otherHeading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const focusAfter = useRef<Focus | null>(null);

  const all: readonly Topic[] = topics.data ?? [];
  const byId = new Map(all.map((t) => [t.id, t]));
  const chosen = chips.flatMap((slug) => byId.get(slug) ?? []);
  const others = all
    .filter((t) => !chips.includes(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Focus goes where the design says it should once the new order is on screen.
  useLayoutEffect(() => {
    const want = focusAfter.current;
    if (!want) return;
    focusAfter.current = null;
    if ('heading' in want) return otherHeading.current?.focus();
    const row = [...(list.current?.children ?? [])].find(
      (li) => (li as HTMLElement).dataset.topic === want.slug,
    );
    const button = (c: string) =>
      row?.querySelector<HTMLButtonElement>(`button[data-control="${c}"]`) ?? null;
    let target = button(want.control);
    // The arrow that just reached the end is disabled: land on the other one.
    if (target?.getAttribute('aria-disabled') === 'true' && want.control !== 'remove') {
      target = button(want.control === 'up' ? 'down' : 'up') ?? target;
    }
    target?.focus();
  }, [chips]);

  /** Offline, nothing can be saved: a press says so instead (UX 2.7). */
  const blocked = useCallback(() => {
    if (!offline) return false;
    toast.info("You're offline. That change wasn't saved.");
    return true;
  }, [offline]);

  function place(slug: string, to: number) {
    const from = chips.indexOf(slug);
    if (from < 0 || to === from) return;
    const next = [...chips];
    next.splice(from, 1);
    next.splice(to, 0, slug);
    setChips(next);
    setAnnounce(`${byId.get(slug)?.name ?? slug} moved to position ${to + 1} of ${next.length}.`);
  }
  function move(slug: string, step: -1 | 1, control: 'up' | 'down') {
    if (blocked()) return;
    const at = chips.indexOf(slug);
    const to = at + step;
    if (at < 0 || to < 0 || to >= chips.length) return;
    focusAfter.current = { slug, control };
    place(slug, to);
  }
  function add(t: Topic) {
    if (blocked()) return;
    focusAfter.current = { slug: t.id, control: 'up' };
    setChips([...chips, t.id]);
    setAnnounce(`${t.name} added to chips, position ${chips.length + 1} of ${chips.length + 1}.`);
  }
  function remove(t: Topic) {
    if (blocked()) return;
    const at = chips.indexOf(t.id);
    const next = chips.filter((c) => c !== t.id);
    const neighbour = next[at] ?? next[at - 1];
    focusAfter.current = neighbour ? { slug: neighbour, control: 'remove' } : { heading: true };
    setChips(next);
    setAnnounce(`${t.name} removed from chips.`);
  }

  // Dragging: the grip follows the pointer, the other rows slide aside (CSSOM transforms, no style attributes).
  const [dragging, setDragging] = useState<string | null>(null);
  const drag = useRef<{ stop: (cancel: boolean) => void } | null>(null);
  useEffect(() => () => drag.current?.stop(true), []);
  function startDrag(e: ReactPointerEvent<HTMLSpanElement>, slug: string) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (blocked() || drag.current) return;
    const items = [...(list.current?.children ?? [])] as HTMLElement[];
    const from = items.findIndex((li) => li.dataset.topic === slug);
    if (from < 0) return;
    e.preventDefault();
    const rects = items.map((li) => li.getBoundingClientRect());
    const startY = e.clientY;
    const startScroll = window.scrollY;
    const height = (rects[from]?.height ?? 56) as number;
    let pointerY = startY;
    let to = from;
    let frame = 0;
    const grip = e.currentTarget;
    const pointerId = e.pointerId;
    try {
      grip.setPointerCapture?.(pointerId);
    } catch {
      // Not every environment can capture; the window listeners below carry the drag.
    }
    const smooth = !prefersReducedMotion();
    items.forEach((li) => {
      if (smooth) li.style.transition = 'transform 150ms var(--ease-standard)';
    });
    setDragging(slug);

    const layout = () => {
      // The dragged row follows the pointer (and the page, if it scrolled); the others make room.
      const dy = pointerY - startY + (window.scrollY - startScroll);
      const mid = (rects[from]?.top ?? 0) + height / 2 + dy;
      let target = items.length - 1;
      for (let i = 0; i < rects.length; i++) {
        if (mid < (rects[i]?.bottom ?? 0)) {
          target = i;
          break;
        }
      }
      to = Math.max(0, Math.min(items.length - 1, target));
      items.forEach((li, i) => {
        if (i === from) {
          li.style.transition = 'none';
          li.style.transform = `translateY(${dy}px)`;
          return;
        }
        const shift =
          from < to && i > from && i <= to
            ? -height
            : from > to && i >= to && i < from
              ? height
              : 0;
        li.style.transform = shift === 0 ? '' : `translateY(${shift}px)`;
      });
    };
    const autoScroll = () => {
      const header = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
      const top = header + 48;
      const bottom = window.innerHeight - SCROLL_ZONE;
      let step = 0;
      if (pointerY > bottom)
        step = Math.min(MAX_SCROLL_STEP, ((pointerY - bottom) / SCROLL_ZONE) * MAX_SCROLL_STEP);
      else if (pointerY < top)
        step = -Math.min(MAX_SCROLL_STEP, ((top - pointerY) / 48) * MAX_SCROLL_STEP);
      if (step !== 0) {
        window.scrollBy(0, step);
        layout();
      }
      frame = requestAnimationFrame(autoScroll);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      pointerY = ev.clientY;
      layout();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') stop(true);
    };
    function stop(cancel: boolean) {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      try {
        grip.releasePointerCapture?.(pointerId);
      } catch {
        // Already released.
      }
      items.forEach((li) => {
        li.style.transition = '';
        li.style.transform = '';
      });
      drag.current = null;
      setDragging(null);
      if (cancel) setAnnounce('Move cancelled.');
      else if (to !== from) place(slug, to);
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) stop(false);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) stop(true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    drag.current = { stop };
    frame = requestAnimationFrame(autoScroll);
    layout();
  }

  let body;
  if (topics.data === undefined) {
    body =
      topics.isPending && topics.fetchStatus === 'fetching' ? (
        <Skeleton />
      ) : (
        <div className="px-2 py-10 text-center" data-testid="topics-error">
          <h2 className="text-lg font-semibold text-fg">Couldn&apos;t load topics.</h2>
          <div className="mt-2 flex flex-col items-center gap-2 text-base text-fg-muted">
            {offline ? (
              <p>Topics aren&apos;t available offline.</p>
            ) : (
              <>
                <p>Check your connection and try again.</p>
                <button type="button" onClick={() => void topics.refetch()} className={BUTTON}>
                  Try again
                </button>
              </>
            )}
          </div>
        </div>
      );
  } else {
    body = (
      <>
        <section aria-labelledby={chosenId} className="mt-6">
          <div className="flex items-baseline justify-between">
            <h2 id={chosenId} className="text-lg font-semibold text-fg">
              On the chips
            </h2>
            <span className="text-sm text-fg-muted">{chosen.length}</span>
          </div>
          {chosen.length === 0 ? (
            <div className={CARD}>
              <p className="p-4 text-center text-base text-fg-muted">
                No topics chosen. All articles has no chip row.
              </p>
            </div>
          ) : (
            <ol ref={list} aria-labelledby={chosenId} className={CARD}>
              {chosen.map((t, i) => (
                <li
                  key={t.id}
                  data-topic={t.id}
                  className={`${ROW} relative ${
                    dragging === t.id
                      ? 'z-10 rounded-lg border border-line-strong bg-raised shadow-raised'
                      : ''
                  }`}
                >
                  <button
                    type="button"
                    data-control="remove"
                    aria-label={`Remove ${t.name} from chips`}
                    aria-disabled={offline ? true : undefined}
                    onClick={() => remove(t)}
                    className={ICON}
                  >
                    <CircleMinus aria-hidden="true" className="size-6" strokeWidth={1.75} />
                  </button>
                  <span className="min-w-0 flex-1 break-words py-2 text-base text-fg">
                    {t.name}
                  </span>
                  <button
                    type="button"
                    data-control="up"
                    aria-label={`Move ${t.name} up`}
                    aria-disabled={i === 0 || offline ? true : undefined}
                    onClick={() => move(t.id, -1, 'up')}
                    className={ICON}
                  >
                    <ChevronUp aria-hidden="true" className="size-6" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    data-control="down"
                    aria-label={`Move ${t.name} down`}
                    aria-disabled={i === chosen.length - 1 || offline ? true : undefined}
                    onClick={() => move(t.id, 1, 'down')}
                    className={ICON}
                  >
                    <ChevronDown aria-hidden="true" className="size-6" strokeWidth={1.75} />
                  </button>
                  <span
                    aria-hidden="true"
                    data-testid={`grip-${t.id}`}
                    onPointerDown={(e) => startDrag(e, t.id)}
                    className={`${ICON} touch-none cursor-grab pointer-fine:active:cursor-grabbing`}
                  >
                    <GripVertical className="size-6" strokeWidth={1.75} />
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-labelledby={otherId} className="mt-6">
          <div className="flex items-baseline justify-between">
            <h2
              id={otherId}
              ref={otherHeading}
              tabIndex={-1}
              className="text-lg font-semibold text-fg"
            >
              Other topics
            </h2>
            <span className="text-sm text-fg-muted">{others.length}</span>
          </div>
          {others.length === 0 ? (
            <p className="mt-2 text-base text-fg-muted">Every topic is on the chips.</p>
          ) : (
            <ul className={CARD}>
              {others.map((t) => (
                <li key={t.id} className={`${ROW} pl-3`}>
                  <span className="min-w-0 flex-1 break-words py-2 text-base text-fg">
                    {t.name}
                  </span>
                  <button
                    type="button"
                    aria-label={`Add ${t.name} to chips`}
                    aria-disabled={offline ? true : undefined}
                    onClick={() => add(t)}
                    className={BUTTON}
                  >
                    <Plus aria-hidden="true" className="size-5" strokeWidth={1.75} />
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </>
    );
  }

  return (
    <div>
      <p className="text-base text-fg-muted">
        Choose the topics that appear as chips above All articles. Drag the grip, or use the arrows,
        to set the order.
      </p>
      {body}
      <div role="status" data-testid="topics-status" className="sr-only">
        {announce}
      </div>
    </div>
  );
}
