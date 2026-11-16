import { Outlet, useLocation } from 'react-router';
import { findRoute } from '../routes/table';
import { useDocumentTitle } from './useDocumentTitle';

/** Layout for /setup, /login, /recover: no header, drawer or sidebar (app-shell.md section 12). */
export function AuthLayout() {
  const { pathname } = useLocation();
  const route = findRoute(pathname);
  useDocumentTitle(route.title);
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))]">
      <main className="flex w-full flex-col items-center">
        <span className="text-xl font-semibold text-fg">Tidings</span>
        <div className="mt-6 w-full max-w-sm rounded-md border border-line bg-surface p-4">
          <h1 className="text-xl font-semibold text-fg">{route.title}</h1>
          <div className="mt-3">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
