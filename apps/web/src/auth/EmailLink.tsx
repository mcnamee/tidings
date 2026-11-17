import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { EmailVerifyRequest, LoginVerifyResponse } from '@tidings/shared';
import { ApiRequestError, NetworkError, apiPost } from '../api';
import { useOnline } from '../lib/hooks';
import { readLastList } from '../lib/lastList';
import { publishSignedIn } from '../lib/session';
import { useDocumentTitle } from '../shell/useDocumentTitle';
import { waitText } from './helpers';
import { BannerSlot, PrimaryButton, TextField, type BannerContent } from './ui';

/** Emailed sign-in link (docs/ux/FLOWS.md 2.1a, TID-053, ADR 0016). */

const MSG = {
  offline: "You're offline. Connect to the internet to continue.",
  network: "Couldn't reach Tidings. Check your connection and try again.",
  server: 'Something went wrong on our side. Try again.',
} as const;

const errorBanner = (text: string): BannerContent => ({ tone: 'error', live: 'alert', text });

/** Banner for 429 and generic failures, shared by both screens. */
function bannerFor(err: unknown): BannerContent {
  if (err instanceof ApiRequestError && err.status === 429) {
    return {
      tone: 'warning',
      live: 'alert',
      icon: 'warning',
      text: `Too many attempts. ${waitText(err.retryAfterSeconds)}.`,
    };
  }
  return errorBanner(err instanceof NetworkError ? MSG.network : MSG.server);
}

const TEXT_BUTTON =
  'inline-flex min-h-11 items-center text-base text-accent underline underline-offset-2';

/** The email form that replaces the passkey button inside the /login card. */
export function EmailLinkForm({ onBack }: { onBack(): void }) {
  const online = useOnline();
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<'form' | 'sending' | 'sent'>('form');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerContent | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sentRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);

  // Focus moves to the field when the form opens (FLOWS 2.1a).
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    if (phase === 'sent') sentRef.current?.focus();
  }, [phase]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || !online) return;
    if (email.trim() === '') {
      setFieldError('Enter an email address.');
      return;
    }
    inFlight.current = true;
    setFieldError(null);
    setBanner(null);
    setPhase('sending');
    try {
      await apiPost<Record<string, never>>('/api/auth/email/request', { email: email.trim() });
      setPhase('sent');
    } catch (err) {
      setPhase('form');
      if (err instanceof ApiRequestError && err.status === 400) {
        setFieldError('Enter an email address.');
      } else {
        setBanner(bannerFor(err));
      }
      queueMicrotask(() => inputRef.current?.focus());
    } finally {
      inFlight.current = false;
    }
  }

  if (phase === 'sent') {
    return (
      <div>
        <h1 className="text-xl font-semibold text-fg">Sign in</h1>
        <div role="status" ref={sentRef} tabIndex={-1} className="mt-4 outline-none">
          <h2 className="text-lg font-semibold text-fg">Check your email</h2>
          <p className="mt-2 text-base text-fg-muted">
            If that address is set up for Tidings, a sign-in link is on its way. It works once and
            expires in 15 minutes.
          </p>
        </div>
        <div className="mt-4 flex flex-col">
          <button type="button" className={TEXT_BUTTON} onClick={() => setPhase('form')}>
            Send another link
          </button>
          <button type="button" className={TEXT_BUTTON} onClick={onBack}>
            Use a passkey instead
          </button>
        </div>
      </div>
    );
  }

  const busy = phase === 'sending';
  return (
    <form aria-labelledby="login-h1" noValidate onSubmit={(e) => void submit(e)}>
      <h1 id="login-h1" tabIndex={-1} className="text-xl font-semibold text-fg">
        Sign in
      </h1>
      <p className="mt-2 mb-4 text-base text-fg-muted">We will email you a link that works once.</p>
      <BannerSlot
        banner={
          online ? banner : { tone: 'warning', live: 'status', icon: 'offline', text: MSG.offline }
        }
      />
      <TextField
        label="Email address"
        helper="The address you set up for Tidings."
        error={fieldError}
        inputRef={inputRef}
        inputProps={{
          type: 'email',
          autoComplete: 'email',
          inputMode: 'email',
          value: email,
          onChange: (e) => setEmail(e.target.value),
          readOnly: busy,
        }}
      />
      <PrimaryButton busy={busy} blocked={!online}>
        {busy ? 'Sending...' : 'Email me a link'}
      </PrimaryButton>
      <div className="mt-2 flex justify-center">
        <button type="button" className={TEXT_BUTTON} onClick={onBack}>
          Use a passkey instead
        </button>
      </div>
    </form>
  );
}

/** Reads `#token=` once, removes it from the address bar and keeps it for this page only. */
let capturedToken: string | null = null;

function captureToken(): string | null {
  const hash = window.location.hash;
  if (hash.length > 1) {
    const token = new URLSearchParams(hash.slice(1)).get('token');
    // history.replaceState keeps the token out of the address bar, history entry and Referer.
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    );
    if (token) capturedToken = token;
  }
  return capturedToken;
}

type Outcome = 'ready' | 'invalid' | 'unavailable';

/** /login/email: nothing is consumed until the person taps "Sign in" (ADR 0016). */
export function EmailSignIn() {
  useDocumentTitle('Sign in');
  const queryClient = useQueryClient();
  const online = useOnline();
  // `undefined` until the layout effect has stripped the fragment, so nothing shows before that.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [outcome, setOutcome] = useState<Outcome>('ready');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<BannerContent | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const inFlight = useRef(false);

  useLayoutEffect(() => setToken(captureToken()), []);

  if (destination) return <Navigate to={destination} replace state={{ focusHeading: true }} />;
  if (token === undefined) return null;

  if (token === null || outcome !== 'ready') {
    const unavailable = outcome === 'unavailable';
    return (
      <div>
        <h1 tabIndex={-1} className="text-xl font-semibold text-fg">
          This link has expired
        </h1>
        <p className="mt-2 mb-6 text-base text-fg-muted">
          {unavailable
            ? "Email sign-in isn't available. Use a passkey or a recovery code."
            : 'Sign-in links work once and expire after 15 minutes. Ask for a new one.'}
        </p>
        <Link
          to="/login"
          className="flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-4 text-base font-medium text-accent-fg"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  async function signIn(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || !online || !token) return;
    inFlight.current = true;
    setBusy(true);
    setBanner(null);
    try {
      const result = await apiPost<LoginVerifyResponse>('/api/auth/email/verify', {
        token,
      } satisfies EmailVerifyRequest);
      capturedToken = null;
      publishSignedIn(queryClient, result.user);
      setDestination(readLastList());
    } catch (err) {
      if (err instanceof ApiRequestError && (err.status === 401 || err.status === 404)) {
        capturedToken = null;
        setOutcome(err.status === 404 ? 'unavailable' : 'invalid');
      } else {
        setBanner(bannerFor(err));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      aria-labelledby="email-h1"
      noValidate
      onSubmit={(e) => void signIn(e)}
      className="flex min-h-[22rem] flex-col md:min-h-0"
    >
      <h1 id="email-h1" tabIndex={-1} className="text-xl font-semibold text-fg">
        Sign in to Tidings
      </h1>
      <p className="mt-2 mb-4 text-base text-fg-muted">
        Tap the button to finish signing in on this device.
      </p>
      <BannerSlot
        banner={
          online ? banner : { tone: 'warning', live: 'status', icon: 'offline', text: MSG.offline }
        }
      />
      <div className="mt-auto md:mt-6">
        <PrimaryButton busy={busy} blocked={!online}>
          {busy ? 'Signing in...' : 'Sign in'}
        </PrimaryButton>
        <p role="status" className="mt-2 min-h-5 text-sm text-fg-muted">
          {online ? '' : "You're offline."}
        </p>
      </div>
    </form>
  );
}
