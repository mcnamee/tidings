import { useState } from 'react';
import { Outlet, useOutletContext } from 'react-router';

/** What an auth screen can ask of its layout. */
export interface AuthLayoutContext {
  /**
   * The recovery-codes step needs a wider card (md:max-w-md) and sits at the top of the page
   * instead of being centred, so the heading stays visible (setup.md section 7).
   */
  setWide(wide: boolean): void;
}

export function useAuthLayout(): AuthLayoutContext {
  return useOutletContext<AuthLayoutContext>();
}

/**
 * Layout for /setup, /login, /recover: no header, drawer or sidebar (app-shell.md section 12,
 * auth-common.md section 1). The screen inside renders the card's h1 and sets the document title.
 */
export function AuthLayout() {
  const [wide, setWide] = useState(false);
  const context: AuthLayoutContext = { setWide };
  return (
    <div className="flex min-h-dvh flex-col items-center bg-canvas pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2rem,calc(env(safe-area-inset-top)+1rem))]">
      <main
        className={`flex w-full flex-col items-center ${wide ? '' : 'md:my-auto'}`}
        data-testid="auth-main"
      >
        <span className="text-xl font-semibold text-fg">Tidings</span>
        <div
          className={`mt-6 w-full max-w-sm rounded-md border border-line bg-surface p-6 ${
            wide ? 'md:max-w-md' : ''
          }`}
        >
          <Outlet context={context} />
        </div>
      </main>
    </div>
  );
}
