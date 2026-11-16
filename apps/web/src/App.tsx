import { Link, Navigate, Route, Routes } from 'react-router';
import { readLastList } from './lib/lastList';
import { AppShell } from './shell/AppShell';
import { AuthLayout } from './shell/AuthLayout';
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

const authRoutes = ROUTES.filter((r) => r.kind === 'auth');
const shellRoutes = ROUTES.filter((r) => r.kind !== 'auth');

export function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Navigate to={readLastList()} replace />} />
        <Route element={<AuthLayout />}>
          {authRoutes.map((r) => (
            <Route key={r.path} path={r.path} element={<Placeholder />} />
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
