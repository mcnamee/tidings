import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import type { LoginVerifyResponse, RequestOptionsJSON } from '@tidings/shared';
import { ApiRequestError, NetworkError, apiPost } from '../api';
import { useOnline } from '../lib/hooks';
import { readLastList } from '../lib/lastList';
import { publishSignedIn, useSession } from '../lib/session';
import { resetExplicitSignOut } from '../lib/signOut';
import { useDocumentTitle } from '../shell/useDocumentTitle';
import { detectPasskeySupport, waitText } from './helpers';
import { safeReturnPath } from './returnPath';
import { EmailLinkForm } from './EmailLink';
import { BannerSlot, PrimaryButton, type BannerContent } from './ui';

/**
 * Passkey sign-in (docs/ux/screens/login.md). One button, no username, and the prompt never
 * starts by itself. Requests use plain `apiPost`, and nothing here is cached.
 */

type Phase = 'idle' | 'server' | 'prompt';

const MSG = {
  offline: "You're offline. Connect to the internet to continue.",
  network: "Couldn't reach Tidings. Check your connection and try again.",
  server: 'Something went wrong on our side. Try again.',
} as const;

const LINK = 'inline-block -my-3 py-3 text-accent underline underline-offset-2';

interface LoginState {
  reason?: unknown;
  from?: unknown;
  notice?: unknown;
}

/** Banner for how the person got here (login.md 2.7 and 2.8). */
function arrivalBanner(state: LoginState | null): BannerContent | null {
  if (state?.reason === 'expired') {
    return {
      tone: 'info',
      live: 'status',
      icon: 'info',
      text: 'Your session ended. Sign in again.',
    };
  }
  if (state?.notice === 'already-set-up') {
    return {
      tone: 'info',
      live: 'status',
      icon: 'info',
      text: 'This Tidings is already set up. Sign in instead.',
    };
  }
  return null;
}

function Skeleton() {
  return (
    <div aria-busy="true" data-testid="login-skeleton">
      <div className="h-7 w-24 animate-skeleton rounded-md bg-sunken" />
      <div className="mt-3 space-y-2">
        <div className="h-5 animate-skeleton rounded-md bg-sunken" />
        <div className="h-5 w-3/4 animate-skeleton rounded-md bg-sunken" />
      </div>
      <div className="mt-6 h-12 animate-skeleton rounded-md bg-sunken" />
      <div className="mx-auto mt-4 h-5 w-32 animate-skeleton rounded-md bg-sunken" />
    </div>
  );
}

function SessionError({ onRetry }: { onRetry(): void }) {
  return (
    <div>
      <h1 className="text-xl font-semibold text-fg">Sign in</h1>
      <div role="alert" className="mt-4">
        <div className="mb-4 rounded-md bg-danger-subtle p-3 text-sm text-danger-subtle-fg">
          {MSG.network}
        </div>
      </div>
      <PrimaryButton type="button" onClick={onRetry}>
        Try again
      </PrimaryButton>
    </div>
  );
}

export function Login() {
  useDocumentTitle('Sign in');
  const session = useSession();
  const queryClient = useQueryClient();
  const location = useLocation();
  const state = (location.state ?? null) as LoginState | null;
  // Set once sign-in succeeded: render a redirect to it rather than racing the session cache.
  const [destination, setDestination] = useState<string | null>(null);

  // The explicit sign out is over once the login screen is showing (route guard, signOut.ts).
  useEffect(() => resetExplicitSignOut(), []);

  if (destination) {
    return <Navigate to={destination} replace state={{ focusHeading: true }} />;
  }
  if (session.isPending) return <Skeleton />;
  if (session.isError) return <SessionError onRetry={() => void session.refetch()} />;
  if (session.data.user) return <Navigate to={readLastList()} replace />;
  if (session.data.setupRequired) return <Navigate to="/setup" replace />;

  return (
    <LoginForm
      emailSignIn={session.data.emailSignIn === true}
      initialBanner={arrivalBanner(state)}
      onSignedIn={(user) => {
        const target = safeReturnPath(state?.from) ?? readLastList();
        publishSignedIn(queryClient, user);
        setDestination(target);
      }}
    />
  );
}

interface LoginFormProps {
  emailSignIn: boolean;
  initialBanner: BannerContent | null;
  onSignedIn(user: LoginVerifyResponse['user']): void;
}

function LoginForm({ emailSignIn, initialBanner, onSignedIn }: LoginFormProps) {
  const online = useOnline();
  const support = useMemo(() => detectPasskeySupport(), []);
  const [phase, setPhase] = useState<Phase>('idle');
  const [banner, setBanner] = useState<BannerContent | null>(initialBanner);
  const [rateWait, setRateWait] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const [emailOpen, setEmailOpen] = useState(false);

  useEffect(() => () => clearTimeout(rateTimer.current), []);

  const busy = phase !== 'idle';
  const showOffline = !online;

  function fail(b: BannerContent) {
    setBanner(b);
    setPhase('idle');
    inFlight.current = false;
    // Retrying is one key press or tap (login.md 2.3, 2.4).
    queueMicrotask(() => buttonRef.current?.focus());
  }

  const errorBanner = (text: string): BannerContent => ({ tone: 'error', live: 'alert', text });

  function handleApiError(err: unknown): void {
    if (err instanceof ApiRequestError) {
      if (err.status === 429) {
        const text = waitText(err.retryAfterSeconds);
        setRateWait(text);
        fail({
          tone: 'warning',
          live: 'alert',
          icon: 'warning',
          text: `Too many attempts. ${text}.`,
        });
        clearTimeout(rateTimer.current);
        if (err.retryAfterSeconds !== null) {
          rateTimer.current = setTimeout(() => {
            setRateWait(null);
            setBanner({ tone: 'info', live: 'status', text: 'You can try again now.' });
          }, err.retryAfterSeconds * 1000);
        }
        return;
      }
      if (err.code === 'webauthn_failed') {
        fail({
          tone: 'error',
          live: 'alert',
          text: "That passkey didn't work. Try again, or use a recovery code.",
          content: (
            <>
              That passkey didn&apos;t work. Try again, or{' '}
              <Link to="/recover" className={LINK}>
                use a recovery code
              </Link>
              .
            </>
          ),
        });
        return;
      }
      fail(errorBanner(MSG.server));
      return;
    }
    fail(errorBanner(err instanceof NetworkError ? MSG.network : MSG.server));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || inFlight.current || rateWait !== null || !online) return;

    inFlight.current = true;
    setBanner(null);
    setPhase('server');
    let options: RequestOptionsJSON;
    try {
      options = await apiPost<RequestOptionsJSON>('/api/auth/login/options', {});
    } catch (err) {
      handleApiError(err);
      return;
    }

    setPhase('prompt');
    let credential;
    try {
      const { startAuthentication } = await import('@simplewebauthn/browser');
      credential = await startAuthentication({
        optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'],
      });
    } catch (err) {
      const errName = err instanceof Error ? err.name : '';
      if (errName === 'NotAllowedError' || errName === 'AbortError') {
        fail({
          tone: 'info',
          live: 'status',
          icon: 'info',
          text: 'Sign-in was cancelled. Try again. No passkey on this device? Use a recovery code.',
          content: (
            <>
              Sign-in was cancelled. Try again. No passkey on this device?{' '}
              <Link to="/recover" className={LINK}>
                Use a recovery code
              </Link>
              .
            </>
          ),
        });
      } else if (errName === 'NotSupportedError') {
        fail({
          tone: 'warning',
          live: 'alert',
          icon: 'warning',
          title: "This device can't use passkeys.",
          text: 'Turn on a screen lock, or connect a security key, then try again.',
        });
      } else {
        fail(errorBanner(MSG.server));
      }
      return;
    }

    setPhase('server');
    try {
      const result = await apiPost<LoginVerifyResponse>('/api/auth/login/verify', {
        response: credential,
      });
      inFlight.current = false;
      onSignedIn(result.user);
    } catch (err) {
      handleApiError(err);
    }
  }

  if (emailOpen) return <EmailLinkForm onBack={() => setEmailOpen(false)} />;

  const emailLink = emailSignIn ? (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={() => setEmailOpen(true)}
        className="inline-flex min-h-11 items-center text-base text-accent underline underline-offset-2"
      >
        Email me a sign-in link
      </button>
    </div>
  ) : null;

  if (support !== 'ok') {
    const insecure = support === 'insecure';
    return (
      <div>
        <h1 className="text-xl font-semibold text-fg">Sign in</h1>
        <div role="status" className="mt-4">
          <div className="flex flex-col gap-2 rounded-md bg-warning-subtle p-3 text-sm text-warning-subtle-fg">
            <p className="font-semibold">
              {insecure ? 'Passkeys need a secure connection.' : "This browser can't use passkeys."}
            </p>
            <p>
              {insecure
                ? 'Open Tidings using its https address and try again.'
                : 'Tidings signs in with passkeys. Open it in a recent version of Safari, Chrome, Edge or Firefox, on a device with a screen lock, Face ID, Touch ID or a security key.'}
            </p>
          </div>
        </div>
        <Link
          to="/recover"
          className="mt-4 flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-4 text-base font-medium text-accent-fg"
        >
          Use a recovery code
        </Link>
        {emailLink}
      </div>
    );
  }

  const helper = showOffline
    ? "You're offline."
    : rateWait !== null
      ? `${rateWait}.`
      : phase === 'prompt'
        ? 'Follow the prompt on your device.'
        : '';
  const label =
    phase === 'prompt'
      ? 'Waiting for your passkey...'
      : phase === 'server'
        ? 'Signing in...'
        : 'Sign in with a passkey';

  return (
    <form
      aria-labelledby="login-h1"
      noValidate
      onSubmit={(e) => void submit(e)}
      className="flex min-h-[22rem] flex-col md:min-h-0"
    >
      <h1 id="login-h1" tabIndex={-1} className="text-xl font-semibold text-fg">
        Sign in
      </h1>
      <p className="mt-2 mb-4 text-base text-fg-muted">
        Use the passkey on this device or in your password manager.
      </p>

      <BannerSlot
        banner={
          showOffline
            ? { tone: 'warning', live: 'status', icon: 'offline', text: MSG.offline }
            : banner
        }
      />

      {/* On a phone the button group sits at the bottom of the card, in the thumb zone. */}
      <div className="mt-auto md:mt-6">
        <PrimaryButton
          ref={buttonRef}
          busy={busy}
          blocked={showOffline || rateWait !== null}
          aria-describedby="login-helper"
        >
          {!busy && <KeyRound className="size-5" aria-hidden="true" />}
          {label}
        </PrimaryButton>
        <p id="login-helper" role="status" className="mt-2 min-h-5 text-sm text-fg-muted">
          {helper}
        </p>
        <div className="mt-2 flex justify-center">
          <Link
            to="/recover"
            className="inline-flex min-h-11 items-center text-base text-accent underline underline-offset-2"
          >
            Lost your passkey?
          </Link>
        </div>
        {emailLink}
      </div>
    </form>
  );
}
