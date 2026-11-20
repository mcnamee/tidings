import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useNavigationType } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { DESKTOP_QUERY, useMediaQuery } from '../lib/hooks';
import { isListOpen, parentListPath } from '../lib/articleNav';
import { isStandalone, prefersReducedMotion, settleTo, useSwipe } from '../lib/useSwipe';
import { OfflineBanner } from '../shell/OfflineBanner';
import { LayerContext, ShellSlotsContext, useChromeInsets } from '../shell/slots';
import { findRoute } from '../routes/table';
import { useRouteTitle } from '../shell/useRouteTitle';

/** How far the list underneath is shifted left when the article is fully on top (parallax). */
export const UNDERLAY_SHIFT = 0.3;
/** The slide when an article opens or closes by tap (TID-058). */
export const SLIDE_MS = 300;
const SLIDE_EASE = 'var(--ease-ios)';
/** Previous / Next: the new article's text slides in from this far away while fading in. */
const STEP_PX = 32;
const STEP_MS = 180;

/** Where Previous / Next came from, passed in history state so the slide can face the right way. */
export interface StepState {
  step?: -1 | 1;
}

/**
 * The article as a full-screen layer above its list (TID-055). The list stays mounted underneath
 * (inert and aria-hidden, frozen in place by AppShell), so the layer has its own header and bottom
 * bar, and swiping it away shows the list moving in from -30% and un-dimming. The layer is
 * portalled next to the page (not inside it) so the page's transform never becomes its containing
 * block.
 *
 * TID-069: below 1024px the article is the document scroller (a status-bar tap scrolls it to the
 * top; the bounce is native). The header and bottom bar are `position: fixed` frames, the content
 * is in the flow, and a slide or swipe moves the three together (a transform on a common parent
 * would make the fixed bars scroll away). From 1024px the layer is a fixed box beside the sidebar
 * with `main` as its own scroller, as before.
 */
export function ArticleLayer({
  contentKey,
  children,
}: {
  /** The article's ID: a new article gets a fresh scroll container, so it starts at the top. */
  contentKey: string;
  children: ReactNode;
}) {
  const { root, underlay, sidebarHidden } = useContext(LayerContext);
  // Desktop: the layer covers the content column only, so its left edge follows the sidebar.
  const left = sidebarHidden ? '' : 'lg:left-72';
  const location = useLocation();
  const navigate = useNavigate();
  const navType = useNavigationType();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const route = findRoute(location.pathname);
  const title = useRouteTitle(route, location.pathname);

  const [headerActionsEl, setHeaderActionsEl] = useState<HTMLElement | null>(null);
  const [bottomBarEl, setBottomBarEl] = useState<HTMLElement | null>(null);
  const [headerFrame, setHeaderFrameEl] = useState<HTMLElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const setHeaderFrame = useCallback((el: HTMLDivElement | null) => {
    headerRef.current = el;
    setHeaderFrameEl(el);
  }, []);
  const setBar = useCallback((el: HTMLDivElement | null) => {
    barRef.current = el;
    setBottomBarEl(el);
  }, []);
  const slots = useMemo(
    () => ({ headerActions: headerActionsEl, bottomBar: bottomBarEl }),
    [headerActionsEl, bottomBarEl],
  );

  const heading = useRef<HTMLHeadingElement>(null);
  const timers = useRef<number[]>([]);
  // A slide in either direction is under way: the Back button must not start another.
  const sliding = useRef<'in' | 'out' | null>(null);
  const focusHeading = () => heading.current?.focus({ preventScroll: true });
  // Opening an article, and Previous/Next, put focus on the heading; Back and reload do not. When
  // the layer slides in, focus waits for the slide to end (see the enter effect below).
  useEffect(() => {
    if (!root || navType === 'POP') return;
    if (sliding.current !== 'in') focusHeading();
    // On each new article, once the layer has somewhere to mount.
  }, [!!root, location.pathname]);
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  // 'default' is the key of the first entry in a tab: nothing of the app's own to go back to.
  const hasAppHistory = location.key !== 'default';
  const standalone = useMemo(isStandalone, []);
  const navigateBack = () => {
    // TID-070: the installed app keeps no history of its own (iOS's swipe-back would animate it
    // with a blank snapshot), so going back replaces the article with its list.
    if (standalone) {
      navigate(
        { pathname: route.parent ?? parentListPath(location.pathname), search: location.search },
        { replace: true },
      );
    } else if (hasAppHistory) navigate(-1);
    else navigate(route.parent ?? '/all');
  };

  const layerRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  useChromeInsets(layerRef, headerFrame, bottomBarEl, true);
  const width = () => window.innerWidth;
  /** The content, the header frame and the bar frame move as one (see above). */
  const parts = () => [layerRef.current, headerRef.current, barRef.current];
  const place = (p: number) => {
    for (const el of parts()) {
      if (!el) continue;
      el.style.transition = '';
      el.style.transform = `translateX(${p * width()}px)`;
    }
    const under = underlay?.current;
    if (under) {
      under.style.transition = '';
      under.style.transform = `translateX(${-UNDERLAY_SHIFT * width() * (1 - p)}px)`;
    }
    if (scrimRef.current) {
      scrimRef.current.style.transition = '';
      scrimRef.current.style.opacity = String(1 - p);
    }
  };
  const clearUnder = () => {
    const under = underlay?.current;
    if (under) {
      under.style.transition = '';
      under.style.transform = '';
    }
  };
  // The swipe moved the page under us: always put it back when the layer goes.
  useEffect(() => clearUnder, [underlay]);

  // The slide is a visual transition, not a gesture: it plays in the browser too. Not on the
  // desktop layout (the layer covers a column beside the sidebar, which the list's parallax would
  // slide under), not for a direct link or reload (POP), and not with reduced motion.
  const canSlide = () => !!layerRef.current && !isDesktop && !prefersReducedMotion();
  const clearSlide = () => {
    for (const el of parts()) {
      if (!el) continue;
      el.style.transition = '';
      el.style.transform = '';
    }
    if (scrimRef.current) {
      scrimRef.current.style.transition = '';
      scrimRef.current.style.opacity = '';
    }
    clearUnder();
  };
  /** Moves layer, list and scrim together from `from` to `to` progress (1 = article off to the right). */
  const slide = (from: number, to: number, done: () => void) => {
    place(from);
    void layerRef.current?.getBoundingClientRect(); // commit the start before the transition
    const w = width();
    if (underlay?.current) {
      settleTo(
        underlay.current,
        { transform: `translateX(${-UNDERLAY_SHIFT * w * (1 - to)}px)` },
        undefined,
        SLIDE_MS,
        SLIDE_EASE,
      );
    }
    settleTo(
      scrimRef.current,
      { transform: '', opacity: String(1 - to) },
      undefined,
      SLIDE_MS,
      SLIDE_EASE,
    );
    const moved = { transform: `translateX(${to * w}px)` };
    settleTo(headerRef.current, moved, undefined, SLIDE_MS, SLIDE_EASE);
    settleTo(barRef.current, moved, undefined, SLIDE_MS, SLIDE_EASE);
    timers.current.push(settleTo(layerRef.current, moved, done, SLIDE_MS, SLIDE_EASE));
  };

  // Opened by a tap (PUSH, or REPLACE in the installed app): slide in from the right while the list shifts left and the scrim fades in.
  useLayoutEffect(() => {
    if (!root || !isListOpen(navType, location.state) || !canSlide()) return;
    sliding.current = 'in';
    slide(1, 0, () => {
      sliding.current = null;
      clearSlide();
      focusHeading();
    });
    // Once, when the layer first mounts.
  }, [!!root]);

  // Previous / Next replace the entry: the new article's text slides in from the side it came from.
  const main = useRef<HTMLElement>(null);
  const shown = useRef(contentKey);
  useLayoutEffect(() => {
    if (shown.current === contentKey) return;
    shown.current = contentKey;
    // Below lg the document scrolls the article: the next one starts at the top.
    if (!isDesktop) window.scrollTo(0, 0);
    const el = main.current;
    const dir = (location.state as StepState | null)?.step;
    if (!el || navType !== 'REPLACE' || dir === undefined || !canSlide()) return;
    el.style.transition = '';
    el.style.transform = `translateX(${dir * STEP_PX}px)`;
    el.style.opacity = '0';
    void el.getBoundingClientRect();
    timers.current.push(
      settleTo(el, { transform: '', opacity: '' }, undefined, STEP_MS, SLIDE_EASE),
    );
  }, [contentKey]);

  // The Back button plays the slide in reverse, then goes back (the swipe has already slid by the
  // time it commits, so it calls navigateBack directly).
  const goBack = () => {
    if (sliding.current === 'out') return;
    if (sliding.current === 'in' || !canSlide()) {
      timers.current.forEach(window.clearTimeout);
      sliding.current = null;
      return navigateBack();
    }
    sliding.current = 'out';
    slide(0, 1, navigateBack);
  };

  useSwipe({
    enabled: standalone && !isDesktop && !!root,
    direction: 'right',
    // Wide code blocks and tables scroll sideways; a swipe there is theirs.
    ignoreWithin: 'pre, table',
    extent: width,
    commitAt: 0.35,
    onDrag: place,
    onCommit: () => {
      sliding.current = 'out'; // the swipe finishes the slide itself
      if (!layerRef.current?.style.transform) return navigateBack(); // reduced motion: no drag
      const rest = { transform: 'translateX(0)' };
      const away = { transform: `translateX(${width()}px)` };
      settleTo(scrimRef.current, { transform: '', opacity: '0' });
      if (underlay?.current) settleTo(underlay.current, rest);
      settleTo(headerRef.current, away);
      settleTo(barRef.current, away);
      settleTo(layerRef.current, away, navigateBack);
    },
    onCancel: () => {
      settleTo(scrimRef.current, { transform: '', opacity: '1' });
      if (underlay?.current) {
        settleTo(
          underlay.current,
          { transform: `translateX(${-UNDERLAY_SHIFT * width()}px)` },
          clearUnder,
        );
      }
      settleTo(headerRef.current, { transform: 'translateX(0)' });
      settleTo(barRef.current, { transform: 'translateX(0)' });
      settleTo(layerRef.current, { transform: 'translateX(0)' }, () => {
        clearSlide();
        if (scrimRef.current) scrimRef.current.style.opacity = '';
      });
    },
  });

  if (!root) return null;
  return createPortal(
    <ShellSlotsContext.Provider value={slots}>
      <div
        ref={scrimRef}
        aria-hidden="true"
        data-testid="article-scrim"
        className={`pointer-events-none fixed inset-0 z-30 bg-scrim opacity-0 ${left}`}
      />
      <div
        ref={setHeaderFrame}
        className={`fixed inset-x-0 top-0 z-[31] flex-none touch-pan-y ${left}`}
      >
        <header className="border-b border-line bg-surface pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)]">
          <div className="flex min-h-14 items-center gap-2 py-2 lg:mx-auto lg:max-w-2xl">
            <button
              type="button"
              aria-label="Back"
              onClick={goBack}
              className="-ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-fg active:bg-sunken"
            >
              <ArrowLeft aria-hidden="true" className="size-6" />
            </button>
            <h1
              ref={heading}
              tabIndex={-1}
              {...(title.heading === null ? { 'aria-busy': true, 'aria-label': 'Loading' } : {})}
              className="min-w-0 flex-1 line-clamp-2 break-words text-lg font-semibold text-fg"
            >
              {title.heading ?? (
                <span
                  aria-hidden="true"
                  className="block h-6 w-32 animate-skeleton rounded-md bg-sunken"
                />
              )}
            </h1>
            <div ref={setHeaderActionsEl} className="flex items-center gap-2" />
          </div>
        </header>
        <OfflineBanner />
      </div>
      <div
        ref={layerRef}
        data-testid="article-layer"
        className={`relative z-30 min-h-dvh touch-pan-y bg-canvas max-lg:pb-[var(--bar-h,0px)] max-lg:pt-[var(--header-h,4rem)] lg:fixed lg:inset-x-0 lg:bottom-[var(--bar-h,0px)] lg:top-[var(--header-h,4rem)] lg:flex lg:min-h-0 lg:flex-col ${left}`}
      >
        <main
          key={contentKey}
          ref={main}
          id="main"
          tabIndex={-1}
          data-testid="article-scroll"
          className="py-4 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain"
        >
          <div className="mx-auto max-w-2xl">{children}</div>
        </main>
      </div>
      <div
        id="bottom-bar"
        ref={setBar}
        className={`fixed inset-x-0 bottom-0 z-[31] flex-none border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] empty:hidden ${left}`}
      />
    </ShellSlotsContext.Provider>,
    root,
  );
}
