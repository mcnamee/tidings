import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Outlet, useLocation, useNavigate, useNavigationType } from 'react-router';
import { ArrowLeft, Menu } from 'lucide-react';
import { useSyncAppearance } from '../lib/appearance';
import { DESKTOP_QUERY, useMediaQuery } from '../lib/hooks';
import { saveLastList } from '../lib/lastList';
import { useSidebarHidden } from '../lib/sidebar';
import { useCounts } from '../lib/queries';
import { findRoute } from '../routes/table';
import { IOS_EDGE_PX, isStandalone, useSwipe } from '../lib/useSwipe';
import { Drawer, drawerWidth, type DrawerControl } from './Drawer';
import { Lockup } from './Logo';
import { FeedNav } from './FeedNav';
import { LayerContext, ShellSlotsContext } from './slots';
import { OfflineBanner } from './OfflineBanner';
import { PasskeyBanner } from './PasskeyBanner';
import { useDocumentTitle } from './useDocumentTitle';
import { useRouteTitle } from './useRouteTitle';

const ICON_BUTTON =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-md text-fg active:bg-sunken';

function drawerFlag(state: unknown): boolean {
  return (
    typeof state === 'object' && state !== null && (state as { drawer?: unknown }).drawer === true
  );
}

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
  const [sidebarHidden, toggleSidebar] = useSidebarHidden();
  // Keeps the unread counts warm (focus and 5-minute refetch, FR-RD-10) whether or not the tree shows.
  useCounts();
  // FR-ST-1: the account's theme and text size win over what this device remembered.
  useSyncAppearance();
  const route = findRoute(location.pathname);
  const title = useRouteTitle(route, location.pathname);
  useDocumentTitle(title.documentTitle);

  const initialKey = useRef(location.key);
  // A drawer entry that survived a reload is stale: only entries pushed in this session count.
  const open = !isDesktop && drawerFlag(location.state) && location.key !== initialKey.current;

  const [headerActionsEl, setHeaderActionsEl] = useState<HTMLElement | null>(null);
  const [bottomBarEl, setBottomBarEl] = useState<HTMLElement | null>(null);
  // An article is a full-screen layer above the list it was opened from (reader/ArticleLayer). The
  // list stays mounted underneath, inert and hidden from assistive tech, so Back finds it as it was.
  const covered = route.kind === 'article';
  const slots = useMemo(
    () => ({ headerActions: headerActionsEl, bottomBar: bottomBarEl, inactive: covered }),
    [headerActionsEl, bottomBarEl, covered],
  );
  const [layerEl, setLayerEl] = useState<HTMLElement | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const layer = useMemo(
    () => ({ root: layerEl, underlay: pageRef, sidebarHidden }),
    [layerEl, sidebarHidden],
  );
  // Lists get a wider column on desktop for the card grid (TID-062); the rest keeps reading width.
  const wide = route.kind === 'list';

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

  // In the installed app there is no browser Back button, but iOS's own edge swipe-back would step
  // through any entry we push. So there the drawer replaces the current entry instead of pushing
  // one, and its links replace too: choosing another list never leaves a list to swipe back to.
  const historyless = useMemo(() => isStandalone(), []);
  const here = { pathname: location.pathname, search: location.search, hash: location.hash };

  const openDrawer = useCallback(() => {
    if (open || openPending.current) return;
    openPending.current = true;
    navigate(here, { state: { drawer: true }, replace: historyless });
  }, [navigate, open, historyless, location.pathname, location.search, location.hash]);

  const closeDrawer = useCallback(() => {
    if (closePending.current) return;
    closePending.current = true;
    if (historyless) navigate(here, { replace: true, state: null });
    else navigate(-1);
  }, [navigate, historyless, location.pathname, location.search, location.hash]);

  // The sidebar takes over when the viewport grows to 1024px; drop the drawer's history entry.
  const stale = isDesktop && drawerFlag(location.state) && location.key !== initialKey.current;
  useEffect(() => {
    if (!stale) return;
    if (historyless) navigate(here, { replace: true, state: null });
    else navigate(-1);
  }, [stale, navigate, historyless]);

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
      // An article's layer moves focus to its own heading.
      if (navType !== 'POP' && !covered) heading.current?.focus();
    } else if (before.open && !open) {
      menuButton.current?.focus();
    }
  }, [open, location.pathname, navType, covered]);

  const showBack = route.kind === 'sub';
  // 'default' is the key of the first entry in a tab: nothing of the app's own to go back to.
  const hasAppHistory = location.key !== 'default';
  function goBack() {
    // The Add/Import sub-pages go one entry back when the app has history (spec 11.2).
    if (hasAppHistory) navigate(-1);
    else navigate(route.parent ?? '/all', { replace: true });
  }

  // TID-055: edge swipes, only in the installed app (in a browser tab the edges belong to the
  // browser's own back gesture). Below 1024px: from the left edge a screen with the Menu button
  // drags the drawer in, an article drags right and goes back (one history step, like Back).
  const standalone = useMemo(isStandalone, []);
  const drawerControl = useRef<DrawerControl>(null);
  const [peeking, setPeeking] = useState(false);
  useEffect(() => {
    if (open) setPeeking(false);
  }, [open]);
  useSwipe({
    enabled: standalone && !isDesktop && !open && !showBack && !covered && route.kind !== 'auth',
    direction: 'right',
    avoidEdgePx: IOS_EDGE_PX,
    extent: drawerWidth,
    commitAt: 0.4,
    onStart: () => flushSync(() => setPeeking(true)),
    onDrag: (p) => drawerControl.current?.setOpenness(p),
    onCommit: () => {
      if (!drawerControl.current) return openDrawer(); // reduced motion: no drag, just open
      // The same Drawer keeps going from where the finger left it. It stays mounted as a peek
      // until the history entry lands (`open`), then switches to open in place (no remount, no
      // entrance animation). The timer only covers an open that never lands.
      drawerControl.current.settle(true);
      openDrawer();
      window.setTimeout(() => setPeeking(false), 1000);
    },
    onCancel: () => drawerControl.current?.settle(false, () => setPeeking(false)),
  });

  return (
    <ShellSlotsContext.Provider value={slots}>
      <LayerContext.Provider value={layer}>
        <div inert={open}>
          <a
            href="#main"
            className="absolute left-4 top-2 z-50 -translate-y-24 rounded-md bg-accent px-4 py-3 font-medium text-accent-fg focus:translate-y-0"
          >
            Skip to content
          </a>
          <div className="group/shell lg:flex" data-sidebar={sidebarHidden ? 'hidden' : 'shown'}>
            {isDesktop && (
              // Hidden: width 0 and inert (out of the tab order and the accessibility tree). The
              // inner box keeps its width so the tree does not reflow while the column animates.
              <aside
                id="sidebar"
                inert={sidebarHidden}
                className={`sticky top-0 h-dvh shrink-0 overflow-hidden bg-surface transition-[width] duration-200 ease-out motion-reduce:transition-none ${
                  sidebarHidden ? 'w-0' : 'w-72 border-r border-line'
                }`}
              >
                <div className="flex h-full w-72 flex-col">
                  <div className="flex min-h-14 items-center px-4">
                    <Lockup />
                  </div>
                  <FeedNav />
                </div>
              </aside>
            )}
            <div
              ref={pageRef}
              inert={covered}
              aria-hidden={covered || undefined}
              data-testid="list-underlay"
              className="flex min-h-dvh min-w-0 flex-1 flex-col"
            >
              <div className="sticky top-0 z-20">
                <header className="border-b border-line bg-surface pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)]">
                  <div
                    className={`flex min-h-14 items-center gap-2 py-2 lg:mx-auto ${wide ? 'lg:max-w-6xl' : 'lg:max-w-2xl'}`}
                  >
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
                      <button
                        ref={menuButton}
                        type="button"
                        {...(isDesktop
                          ? {
                              'aria-label': sidebarHidden ? 'Show sidebar' : 'Hide sidebar',
                              'aria-expanded': !sidebarHidden,
                              'aria-controls': 'sidebar',
                              onClick: toggleSidebar,
                            }
                          : {
                              'aria-label': 'Open navigation',
                              'aria-haspopup': 'dialog' as const,
                              'aria-expanded': open,
                              'aria-controls': 'nav-drawer',
                              onClick: openDrawer,
                            })}
                        className={`${ICON_BUTTON} -ml-2`}
                      >
                        <Menu aria-hidden="true" className="size-6" />
                      </button>
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
                <OfflineBanner />
              </div>
              <main
                id={covered ? undefined : 'main'}
                tabIndex={-1}
                className="flex-1 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]"
              >
                <div className={`mx-auto max-w-2xl ${wide ? 'lg:max-w-6xl' : ''}`}>
                  <PasskeyBanner />
                  <Outlet />
                </div>
              </main>
              <div
                id={covered ? undefined : 'bottom-bar'}
                ref={setBottomBarEl}
                className="sticky bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] empty:hidden"
              />
            </div>
          </div>
        </div>
        <div ref={setLayerEl} />
        {(open || peeking) && (
          <Drawer onClose={closeDrawer} peeking={peeking && !open} control={drawerControl} />
        )}
      </LayerContext.Provider>
    </ShellSlotsContext.Provider>
  );
}
