import {
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
import {
  SWIPE_EDGE_PX,
  isStandalone,
  prefersReducedMotion,
  settleTo,
  useSwipe,
} from '../lib/useSwipe';
import { OfflineBanner } from '../shell/OfflineBanner';
import { LayerContext, ShellSlotsContext } from '../shell/slots';
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
 * (inert and aria-hidden, see AppShell), so the layer has its own header, scroll container and
 * bottom bar, and swiping it away shows the list moving in from -30% and un-dimming. The layer is
 * portalled next to the page (not inside it) so the page's transform never becomes its containing
 * block. From 1024px it covers only the content column, leaving the sidebar in place.
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
  const navigateBack = () => {
    if (hasAppHistory) navigate(-1);
    else navigate(route.parent ?? '/all');
  };

  const layerRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const standalone = useMemo(isStandalone, []);
  const width = () => window.innerWidth;
  const place = (p: number) => {
    const layer = layerRef.current;
    if (layer) {
      layer.style.transition = '';
      layer.style.transform = `translateX(${p * width()}px)`;
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
    if (layerRef.current) {
      layerRef.current.style.transition = '';
      layerRef.current.style.transform = '';
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
    timers.current.push(
      settleTo(
        layerRef.current,
        { transform: `translateX(${to * w}px)` },
        done,
        SLIDE_MS,
        SLIDE_EASE,
      ),
    );
  };

  // Opened by a tap (PUSH): slide in from the right while the list shifts left and the scrim fades in.
  useLayoutEffect(() => {
    if (!root || navType !== 'PUSH' || !canSlide()) return;
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
    const el = main.current;
    if (!el || navType !== 'REPLACE' || !canSlide()) return;
    const dir = (location.state as StepState | null)?.step ?? 1;
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
    edgePx: SWIPE_EDGE_PX,
    extent: width,
    commitAt: 0.35,
    onDrag: place,
    onCommit: () => {
      sliding.current = 'out'; // the swipe finishes the slide itself
      if (!layerRef.current?.style.transform) return navigateBack(); // reduced motion: no drag
      const rest = { transform: 'translateX(0)' };
      settleTo(scrimRef.current, { transform: '', opacity: '0' });
      if (underlay?.current) settleTo(underlay.current, rest);
      settleTo(layerRef.current, { transform: `translateX(${width()}px)` }, navigateBack);
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
      settleTo(layerRef.current, { transform: 'translateX(0)' }, () => {
        if (layerRef.current) layerRef.current.style.transform = '';
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
        ref={layerRef}
        data-testid="article-layer"
        className={`fixed inset-0 z-30 flex flex-col bg-canvas touch-pan-y overscroll-contain ${left}`}
      >
        <div className="flex-none">
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
        <main
          key={contentKey}
          ref={main}
          id="main"
          tabIndex={-1}
          data-testid="article-scroll"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-4 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]"
        >
          <div className="mx-auto max-w-2xl">{children}</div>
        </main>
        <div
          id="bottom-bar"
          ref={setBottomBarEl}
          className="flex-none border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] empty:hidden"
        />
      </div>
    </ShellSlotsContext.Provider>,
    root,
  );
}
