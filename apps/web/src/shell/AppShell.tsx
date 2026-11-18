import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Outlet, useLocation, useNavigate, useNavigationType } from 'react-router';
import { ArrowLeft, Menu, WifiOff } from 'lucide-react';
import { useOffline } from '../lib/connectivity';
import { DESKTOP_QUERY, useMediaQuery } from '../lib/hooks';
import { saveLastList } from '../lib/lastList';
import { useCounts } from '../lib/queries';
import { findRoute } from '../routes/table';
import { SWIPE_EDGE_PX, isStandalone, settleTo, useSwipe } from '../lib/useSwipe';
import { Drawer, drawerWidth, type DrawerControl } from './Drawer';
import { Lockup } from './Logo';
import { FeedNav } from './FeedNav';
import { ShellSlotsContext } from './slots';
import { useDocumentTitle } from './useDocumentTitle';
import { useRouteTitle } from './useRouteTitle';

const ICON_BUTTON =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-md text-fg active:bg-sunken';

function drawerFlag(state: unknown): boolean {
  return (
    typeof state === 'object' && state !== null && (state as { drawer?: unknown }).drawer === true
  );
}

/** Routes with nothing saved to show, only changes to make (Manage, Add feed, Import, Settings). */
const OFFLINE_NO_SAVE = /^\/(manage|settings)(\/|$)/;

/**
 * The authenticated app shell (docs/ux/screens/app-shell.md). Below 1024px the feed tree is a modal
 * drawer that pushes one history entry (state.drawer) so system Back closes it; from 1024px it is a
 * permanent sidebar.
 */
export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const navType = useNavigationType();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const offline = useOffline();
  // Keeps the unread counts warm (focus and 5-minute refetch, FR-RD-10) whether or not the tree shows.
  useCounts();
  const route = findRoute(location.pathname);
  const title = useRouteTitle(route, location.pathname);
  useDocumentTitle(title.documentTitle);

  const initialKey = useRef(location.key);
  // A drawer entry that survived a reload is stale: only entries pushed in this session count.
  const open = !isDesktop && drawerFlag(location.state) && location.key !== initialKey.current;

  const [headerActionsEl, setHeaderActionsEl] = useState<HTMLElement | null>(null);
  const [bottomBarEl, setBottomBarEl] = useState<HTMLElement | null>(null);
  const slots = useMemo(
    () => ({ headerActions: headerActionsEl, bottomBar: bottomBarEl }),
    [headerActionsEl, bottomBarEl],
  );

  const menuButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // Guards so repeated inputs before React re-renders push at most one entry and pop only our own.
  // Cleared whenever the location changes (the push, the pop, or a drawer link's replace landed).
  const openPending = useRef(false);
  const closePending = useRef(false);
  useEffect(() => {
    openPending.current = false;
    closePending.current = false;
  }, [location.key, open]);

  const openDrawer = useCallback(() => {
    if (open || openPending.current) return;
    openPending.current = true;
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { state: { drawer: true } },
    );
  }, [navigate, open, location.pathname, location.search, location.hash]);

  const closeDrawer = useCallback(() => {
    if (closePending.current) return;
    closePending.current = true;
    navigate(-1);
  }, [navigate]);

  // The sidebar takes over when the viewport grows to 1024px; drop the drawer's history entry.
  const stale = isDesktop && drawerFlag(location.state) && location.key !== initialKey.current;
  useEffect(() => {
    if (stale) navigate(-1);
  }, [stale, navigate]);

  useEffect(() => saveLastList(location.pathname), [location.pathname]);

  // Arriving from sign-in: focus goes to the destination's h1 (login.md 4, auth-common 6).
  const arrivedFromSignIn =
    typeof location.state === 'object' &&
    location.state !== null &&
    (location.state as { focusHeading?: unknown }).focusHeading === true;
  useEffect(() => {
    if (arrivedFromSignIn) heading.current?.focus();
    // Only on arrival: later renders must not steal focus.
  }, []);

  // Focus: new screen's h1 after a route change (not after Back/Forward); Menu after the drawer
  // closes without navigating.
  const prev = useRef<{ open: boolean; pathname: string } | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = { open, pathname: location.pathname };
    if (!before) return;
    if (before.pathname !== location.pathname) {
      if (navType !== 'POP') heading.current?.focus();
    } else if (before.open && !open) {
      menuButton.current?.focus();
    }
  }, [open, location.pathname, navType]);

  const showBack = route.kind === 'article' || route.kind === 'sub';
  // 'default' is the key of the first entry in a tab: nothing of the app's own to go back to.
  const hasAppHistory = location.key !== 'default';
  function goBack() {
    // Articles and the Add/Import sub-pages go one entry back when the app has history (spec 11.2).
    if (hasAppHistory) navigate(-1);
    else navigate(route.parent ?? '/all', { replace: route.kind === 'sub' });
  }

  // TID-055: edge swipes, only in the installed app (in a browser tab the edges belong to the
  // browser's own back gesture). Below 1024px: from the left edge a screen with the Menu button
  // drags the drawer in, an article drags right and goes back (one history step, like Back).
  const standalone = useMemo(isStandalone, []);
  const drawerControl = useRef<DrawerControl>(null);
  const [peeking, setPeeking] = useState(false);
  useSwipe({
    enabled: standalone && !isDesktop && !open && !showBack && route.kind !== 'auth',
    direction: 'right',
    edgePx: SWIPE_EDGE_PX,
    extent: drawerWidth,
    commitAt: 0.4,
    onStart: () => flushSync(() => setPeeking(true)),
    onDrag: (p) => drawerControl.current?.setOpenness(p),
    onCommit: () => {
      if (!drawerControl.current) return openDrawer(); // reduced motion: no drag, just open
      drawerControl.current.settle(true);
      openDrawer();
      setPeeking(false);
    },
    onCancel: () => drawerControl.current?.settle(false, () => setPeeking(false)),
  });

  const pageRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const canSwipeBack = standalone && !isDesktop && !open && route.kind === 'article';
  const pageWidth = () => window.innerWidth;
  useSwipe({
    enabled: canSwipeBack,
    direction: 'right',
    edgePx: SWIPE_EDGE_PX,
    extent: pageWidth,
    commitAt: 0.35,
    onDrag: (p) => {
      if (pageRef.current) {
        pageRef.current.style.transition = '';
        pageRef.current.style.transform = `translateX(${p * pageWidth()}px)`;
      }
      if (backdropRef.current) backdropRef.current.style.opacity = String(1 - p);
    },
    onCommit: () => {
      if (!pageRef.current?.style.transform) return goBack(); // reduced motion
      settleTo(backdropRef.current, { transform: '', opacity: '0' });
      settleTo(pageRef.current, { transform: `translateX(${pageWidth()}px)` }, goBack);
    },
    onCancel: () => {
      settleTo(backdropRef.current, { transform: '', opacity: '0' });
      settleTo(pageRef.current, { transform: 'translateX(0)' }, () => {
        if (pageRef.current) pageRef.current.style.transform = '';
      });
    },
  });
  // The page the swipe moved is the same element on the next screen: put it back.
  useLayoutEffect(() => {
    if (pageRef.current) {
      pageRef.current.style.transform = '';
      pageRef.current.style.transition = '';
    }
    if (backdropRef.current) backdropRef.current.style.opacity = '';
  }, [location.key]);

  return (
    <ShellSlotsContext.Provider value={slots}>
      <div inert={open}>
        <a
          href="#main"
          className="absolute left-4 top-2 z-50 -translate-y-24 rounded-md bg-accent px-4 py-3 font-medium text-accent-fg focus:translate-y-0"
        >
          Skip to content
        </a>
        <div className="lg:flex">
          {isDesktop && (
            <aside className="sticky top-0 flex h-dvh w-72 shrink-0 flex-col border-r border-line bg-surface">
              <div className="flex min-h-14 items-center px-4">
                <Lockup />
              </div>
              <FeedNav />
            </aside>
          )}
          <div ref={pageRef} className="flex min-h-dvh min-w-0 flex-1 flex-col">
            <div className="sticky top-0 z-20">
              <header className="border-b border-line bg-surface pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)]">
                <div className="flex min-h-14 items-center gap-2 py-2 lg:mx-auto lg:max-w-2xl">
                  {showBack ? (
                    <button
                      type="button"
                      aria-label="Back"
                      onClick={goBack}
                      className={`${ICON_BUTTON} -ml-2`}
                    >
                      <ArrowLeft aria-hidden="true" className="size-6" />
                    </button>
                  ) : (
                    !isDesktop && (
                      <button
                        ref={menuButton}
                        type="button"
                        aria-label="Open navigation"
                        aria-haspopup="dialog"
                        aria-expanded={open}
                        aria-controls="nav-drawer"
                        onClick={openDrawer}
                        className={`${ICON_BUTTON} -ml-2`}
                      >
                        <Menu aria-hidden="true" className="size-6" />
                      </button>
                    )
                  )}
                  <h1
                    ref={heading}
                    tabIndex={-1}
                    {...(title.heading === null
                      ? { 'aria-busy': true, 'aria-label': 'Loading' }
                      : {})}
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
              {offline && (
                <div
                  role="status"
                  className="flex min-h-10 items-center gap-2 bg-warning-subtle py-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] text-sm text-warning-subtle-fg"
                >
                  <WifiOff aria-hidden="true" className="size-4 shrink-0" />
                  {OFFLINE_NO_SAVE.test(location.pathname)
                    ? "You're offline. Changes can't be saved."
                    : "You're offline. Showing saved articles."}
                </div>
              )}
            </div>
            <main
              id="main"
              tabIndex={-1}
              className="flex-1 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]"
            >
              <div className="mx-auto max-w-2xl">
                <Outlet />
              </div>
            </main>
            <div
              id="bottom-bar"
              ref={setBottomBarEl}
              className="sticky bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] empty:hidden"
            />
          </div>
        </div>
      </div>
      {canSwipeBack && (
        <div
          ref={backdropRef}
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 -z-10 bg-scrim opacity-0"
        />
      )}
      {(open || peeking) && (
        <Drawer onClose={closeDrawer} peeking={peeking && !open} control={drawerControl} />
      )}
    </ShellSlotsContext.Provider>
  );
}
