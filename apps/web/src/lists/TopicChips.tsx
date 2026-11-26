import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Topic } from '@tidings/shared';
import { prefersReducedMotion } from '../lib/useSwipe';

/** From this many chips the row can run past the edge at 375 px, so it gets the edge fades. */
const FADE_FROM = 12;

const HIT = 'inline-flex min-h-11 min-w-11 items-center justify-center';
const PILL =
  'topic-chip mx-1 inline-flex min-h-9 items-center whitespace-nowrap rounded-full border px-4 text-sm font-medium';
const PILL_OFF = 'border-line-strong bg-surface text-fg group-active/chip:bg-sunken';
const PILL_ON = 'border-accent bg-accent text-accent-fg';

/**
 * The chip row at the top of All articles (TID-078, FR-RD-13, docs/ux/screens/topics.md part 1). "All" first, then
 * the topics the person chose, in their order. One chip is pressed (`aria-pressed`, filled as well as
 * coloured). The group is one Tab stop (roving tabindex): Left and Right move between chips, Home and End jump,
 * Enter or Space presses. The row scrolls sideways with the finger; it is left alone by the drawer swipe
 * (`data-swipe-ignore`) except from the very left edge (AppShell).
 */
export function TopicChips({
  topics,
  selected,
  onSelect,
}: {
  topics: readonly Topic[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  const first = useRef(true);
  const count = topics.length + 1;

  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
  }, []);

  // The pressed chip scrolls to the middle of the row: by the row's own scrollLeft, never
  // scrollIntoView (which can move the window under the header).
  useLayoutEffect(() => {
    const el = row.current;
    const chip = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !chip) return;
    const left = Math.max(0, chip.offsetLeft - (el.clientWidth - chip.offsetWidth) / 2);
    const smooth = !first.current && !prefersReducedMotion();
    if (typeof el.scrollTo === 'function')
      el.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    else el.scrollLeft = left;
    first.current = false;
  }, [selected, count]);

  useEffect(() => {
    measure();
    const el = row.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, count]);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const chips = [
      ...(row.current?.querySelectorAll<HTMLButtonElement>('button[data-chip]') ?? []),
    ];
    const at = chips.indexOf(e.currentTarget);
    if (at < 0) return;
    const to =
      e.key === 'ArrowRight'
        ? Math.min(chips.length - 1, at + 1)
        : e.key === 'ArrowLeft'
          ? Math.max(0, at - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? chips.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    chips[to]?.focus();
  }

  function nudge(dir: -1 | 1) {
    const el = row.current;
    if (!el) return;
    el.scrollBy({
      left: dir * el.clientWidth * 0.8,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }

  const chip = (id: string | null, label: string, name?: string) => {
    const pressed = id === selected;
    return (
      <button
        key={id ?? 'all'}
        type="button"
        data-chip={id ?? 'all'}
        aria-pressed={pressed}
        aria-label={name}
        tabIndex={pressed ? 0 : -1}
        onKeyDown={onKeyDown}
        onClick={() => {
          if (!pressed) onSelect(id);
        }}
        className={`group/chip ${HIT}`}
      >
        <span className={`${PILL} ${pressed ? PILL_ON : PILL_OFF}`}>{label}</span>
      </button>
    );
  };

  return (
    <div className="relative -mx-4 lg:mx-0" data-testid="topic-chips">
      <div
        ref={row}
        role="group"
        aria-label="Topics"
        data-swipe-ignore
        data-fade-start={count >= FADE_FROM && fade.start ? 'true' : undefined}
        data-fade-end={count >= FADE_FROM && fade.end ? 'true' : undefined}
        onScroll={measure}
        className="scroll-row relative flex px-4 pb-1 pt-2 scroll-px-4 lg:px-0"
      >
        <div className="flex w-max">
          {chip(null, 'All', 'All topics')}
          {topics.map((t) => chip(t.id, t.name))}
        </div>
      </div>
      {fade.start && (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => nudge(-1)}
          className="absolute inset-y-0 left-0 hidden w-11 items-center justify-center bg-canvas text-fg-muted pointer-fine:flex"
        >
          <ChevronLeft className="size-5" strokeWidth={1.75} />
        </button>
      )}
      {fade.end && (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => nudge(1)}
          className="absolute inset-y-0 right-0 hidden w-11 items-center justify-center bg-canvas text-fg-muted pointer-fine:flex"
        >
          <ChevronRight className="size-5" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

/** The same box as the row while the topic names load, so nothing shifts when they arrive. */
export function TopicChipsSkeleton({ chosen }: { chosen: number }) {
  const widths = ['w-12', 'w-12', 'w-24', 'w-20'];
  return (
    <div
      aria-hidden="true"
      data-testid="topic-chips-skeleton"
      className="-mx-4 flex px-4 pb-1 pt-2 lg:mx-0 lg:px-0"
    >
      {widths.slice(0, Math.min(chosen + 1, widths.length)).map((w, i) => (
        <span key={i} className="inline-flex min-h-11 min-w-11 items-center justify-center">
          <span className={`mx-1 h-9 animate-skeleton rounded-full bg-sunken ${w}`} />
        </span>
      ))}
    </div>
  );
}
