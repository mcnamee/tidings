import { useEffect, useState } from 'react';
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  matchPath,
  useOutlet,
  useLocation,
  useParams,
} from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { setUnauthenticatedHandler } from './api';
import { EmailSignIn } from './auth/EmailLink';
import { Login } from './auth/Login';
import { Recover } from './auth/Recover';
import { ArticleList } from './lists/ArticleList';
import { ArticleRoute } from './reader/ArticleView';
import { AddFeed } from './manage/AddFeed';
import { ImportOpml } from './manage/ImportOpml';
import { Manage } from './manage/Manage';
import { useFolders, useSubscriptions } from './lib/queries';
import { Setup } from './auth/Setup';
import { readLastList } from './lib/lastList';
import { SESSION_KEY, SIGNED_OUT, useSession } from './lib/session';
import { hasSignedInHint } from './lib/signedInHint';
import { isExplicitSignOut, signOut } from './lib/signOut';
import { AppShell } from './shell/AppShell';
import { AuthLayout } from './shell/AuthLayout';
import { Toasts } from './shell/Toasts';
import { splashAppReady } from './splash';
import { ROUTES } from './routes/table';

// Not release copy: removed as each screen story lands.
function Placeholder() {
  return <p className="text-base text-fg">This screen isn&apos;t built yet.</p>;
}

function NotFound() {
  return (
    <div>
      <p className="text-base text-fg">We couldn&apos;t find that page.</p>
      <Link to="/all" className="mt-2 inline-flex min-h-11 items-center text-accent underline">
        Go to All articles
      </Link>
    </div>
  );
}

/** Spec 11.1 and auth-common 7: while no user exists, every route leads to /setup. */
function SetupRedirect() {
  const { pathname } = useLocation();
  const session = useSession();
  if (session.data?.setupRequired && pathname !== '/setup') return <Navigate to="/setup" replace />;
  return null;
}

/**
 * Every route under the shell needs a session (auth-common.md 7): a signed-out visitor goes to
 * /login, remembering where they were. The server stays the authority; this only saves the trip.
 */
function RequireAuth() {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) {
    return (
      <div className="min-h-dvh bg-canvas" aria-busy="true" data-testid="auth-pending">
        <span className="sr-only" role="status">
          Loading
        </span>
      </div>
    );
  }
  // If the session can't be checked, /login says so and offers Try again.
  if (session.isError || !session.data.user) {
    // The first-run redirect (SetupRedirect) wins while no owner exists.
    if (session.data?.setupRequired) return null;
    // An explicit sign out lands on a plain /login; a session that ended says so (login.md 2.7).
    const state = isExplicitSignOut()
      ? undefined
      : {
          from: `${location.pathname}${location.search}`,
          ...(hasSignedInHint() ? { reason: 'expired' } : {}),
        };
    return <Navigate to="/login" replace state={state} />;
  }
  return <Outlet />;
}

/**
 * Stands in for the Settings screen (TID-022) so there is somewhere to Sign out. TID-022 replaces
 * it with the Account section (FR-ST-3).
 */
function SettingsPlaceholder() {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function onSignOut() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await signOut(client);
    if (!ok) {
      setFailed(true);
      setBusy(false);
    }
  }
  return (
    <>
      <Placeholder />
      <section aria-labelledby="account-h2" className="mt-6">
        <h2 id="account-h2" className="text-lg font-semibold text-fg">
          Account
        </h2>
        <div role="alert" className="mt-2">
          {failed && (
            <p className="rounded-md bg-danger-subtle p-3 text-sm text-danger-subtle-fg">
              Couldn&apos;t sign out. Check your connection and try again.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void onSignOut()}
          aria-disabled={busy ? true : undefined}
          className="mt-2 inline-flex min-h-11 items-center rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg"
        >
          {busy ? 'Signing out...' : 'Sign out'}
        </button>
      </section>
    </>
  );
}

// Keyed by the ID so moving between two folders (or feeds) starts a fresh list, not a reused one.
// An open article is the child route: it renders as a layer above its list, which stays mounted.
function AllList() {
  const article = useOutlet();
  return (
    <>
      <ArticleList view="all" id={null} base="/all" covered={!!article} />
      {article}
    </>
  );
}

function FolderList() {
  const { folderId = '' } = useParams();
  const article = useOutlet();
  return (
    <>
      <ArticleList
        key={folderId}
        view="folder"
        id={folderId}
        base={`/folders/${folderId}`}
        covered={!!article}
      />
      {article}
    </>
  );
}

function FeedList() {
  const { subscriptionId = '' } = useParams();
  const article = useOutlet();
  return (
    <>
      <ArticleList
        key={subscriptionId}
        view="feed"
        id={subscriptionId}
        base={`/feeds/${subscriptionId}`}
        covered={!!article}
      />
      {article}
    </>
  );
}

/**
 * `/` opens the last list viewed on this device (spec 11.1, TID-018 AC11). A stored folder or
 * feed that no longer exists, or one that cannot be checked, falls back to /all.
 */
function RootRedirect() {
  const stored = readLastList();
  const session = useSession();
  const folderId = matchPath('/folders/:id', stored)?.params.id;
  const feedId = matchPath('/feeds/:id', stored)?.params.id;
  const signedIn = !!session.data?.user;
  const folders = useFolders(signedIn && folderId !== undefined);
  const subscriptions = useSubscriptions(signedIn && feedId !== undefined);

  if (stored === '/all') return <Navigate to="/all" replace />;
  // Signed out: the route guard sends the person to /login and remembers where they were going.
  if (session.isPending) return null;
  if (!signedIn) return <Navigate to={stored} replace />;
  const check = folderId !== undefined ? folders : subscriptions;
  if (check.isPending) return null;
  const exists =
    !!check.data &&
    (folderId !== undefined
      ? folders.data?.some((f) => f.id === folderId)
      : subscriptions.data?.some((s) => s.id === feedId));
  return <Navigate to={exists ? stored : '/all'} replace />;
}

function screenFor(path: string) {
  if (path === '/settings') return <SettingsPlaceholder />;
  if (path === '/manage') return <Manage />;
  if (path === '/manage/add') return <AddFeed />;
  if (path === '/manage/import') return <ImportOpml />;
  if (path === '/all') return <AllList />;
  if (path === '/folders/:folderId') return <FolderList />;
  if (path === '/feeds/:subscriptionId') return <FeedList />;
  return <Placeholder />;
}

const shellRoutes = ROUTES.filter((r) => r.kind !== 'auth' && r.kind !== 'article');

export function App() {
  const queryClient = useQueryClient();
  // Any 401 unauthenticated means the session is gone: drop the signed-in state and the guard
  // routes to /login. The persisted cache is kept (ADR 0010 item 4); only sign out clears it.
  useEffect(() => {
    setUnauthenticatedHandler(() => queryClient.setQueryData(SESSION_KEY, SIGNED_OUT));
    return () => setUnauthenticatedHandler(null);
  }, [queryClient]);
  // The first real screen is up once the session has resolved and its route has committed (its
  // content or skeleton); two frames later it has painted. Then the launch screen may go.
  const sessionPending = useSession().isPending;
  useEffect(() => {
    if (sessionPending) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(splashAppReady));
    return () => cancelAnimationFrame(id);
  }, [sessionPending]);
  return (
    <>
      <SetupRedirect />
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route element={<AuthLayout />}>
          <Route path="/setup" element={<Setup />} />
          <Route path="/login" element={<Login />} />
          <Route path="/login/email" element={<EmailSignIn />} />
          <Route path="/recover" element={<Recover />} />
        </Route>
        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            {shellRoutes.map((r) => (
              <Route key={r.path} path={r.path} element={screenFor(r.path)}>
                {r.kind === 'list' && <Route path="a/:entryId" element={<ArticleRoute />} />}
              </Route>
            ))}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
      </Routes>
      <Toasts />
    </>
  );
}
