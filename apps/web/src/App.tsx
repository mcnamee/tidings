import { Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { Setup } from './auth/Setup';
import { BannerSlot } from './auth/ui';
import { readLastList } from './lib/lastList';
import { useSession } from './lib/session';
import { AppShell } from './shell/AppShell';
import { AuthLayout } from './shell/AuthLayout';
import { useDocumentTitle } from './shell/useDocumentTitle';
import { Toasts } from './shell/Toasts';
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

/** /login and /recover arrive with TID-008 and TID-009. Until then they show their title only. */
function AuthPlaceholder({ title }: { title: string }) {
  useDocumentTitle(title);
  const session = useSession();
  const location = useLocation();
  if (session.data?.user) return <Navigate to={readLastList()} replace />;
  const notice =
    (location.state as { notice?: string } | null)?.notice === 'already-set-up'
      ? {
          tone: 'info' as const,
          live: 'status' as const,
          text: 'This Tidings is already set up. Sign in instead.',
        }
      : null;
  return (
    <div>
      <h1 className="text-xl font-semibold text-fg">{title}</h1>
      <div className="mt-3">
        <BannerSlot banner={notice} />
        <Placeholder />
      </div>
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

const authRoutes = ROUTES.filter((r) => r.kind === 'auth' && r.path !== '/setup');
const shellRoutes = ROUTES.filter((r) => r.kind !== 'auth');

export function App() {
  return (
    <>
      <SetupRedirect />
      <Routes>
        <Route path="/" element={<Navigate to={readLastList()} replace />} />
        <Route element={<AuthLayout />}>
          <Route path="/setup" element={<Setup />} />
          {authRoutes.map((r) => (
            <Route key={r.path} path={r.path} element={<AuthPlaceholder title={r.title} />} />
          ))}
        </Route>
        <Route element={<AppShell />}>
          {shellRoutes.map((r) => (
            <Route key={r.path} path={r.path} element={<Placeholder />} />
          ))}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      <Toasts />
    </>
  );
}
