import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { RecoverResponse } from '@tidings/shared';
import { ApiRequestError, NetworkError, apiPost } from '../api';
import { useOnline } from '../lib/hooks';
import { readLastList } from '../lib/lastList';
import { publishSignedIn, useSession } from '../lib/session';
import { resetExplicitSignOut } from '../lib/signOut';
import { useDocumentTitle } from '../shell/useDocumentTitle';
import { waitText } from './helpers';
import { safeReturnPath } from './returnPath';
import { BannerSlot, PrimaryButton, TextField, type BannerContent } from './ui';

/**
 * Sign in with a recovery code (docs/ux/screens/recover.md, TID-009). The code is held in
 * component state only: it is sent as typed (the server normalises it), never stored, logged,
 * put in the URL or kept after the request. Requests use plain `apiPost`, never the query cache.
 */

const MSG = {
  offline: "You're offline. Connect to the internet to continue.",
  network: "Couldn't reach Tidings. Check your connection and try again.",
  server: 'Something went wrong on our side. Try again.',
  empty: 'Enter a recovery code.',
  wrong: "That code didn't work. Check it and try again. Each code works only once.",
} as const;

function Skeleton() {
  return (
    <div aria-busy="true" data-testid="recover-skeleton">
      <div className="h-7 w-48 animate-skeleton rounded-md bg-sunken" />
      <div className="mt-3 space-y-2">
        <div className="h-5 animate-skeleton rounded-md bg-sunken" />
        <div className="h-5 w-3/4 animate-skeleton rounded-md bg-sunken" />
      </div>
      <div className="mt-6 h-12 animate-skeleton rounded-md bg-sunken" />
      <div className="mt-4 h-12 animate-skeleton rounded-md bg-sunken" />
    </div>
  );
}

export function Recover() {
  useDocumentTitle('Use a recovery code');
  const session = useSession();
  const queryClient = useQueryClient();
  const location = useLocation();
  const from = (location.state as { from?: unknown } | null)?.from;
  const [destination, setDestination] = useState<string | null>(null);
  useEffect(() => resetExplicitSignOut(), []);

  if (destination) {
    return <Navigate to={destination} replace state={{ focusHeading: true }} />;
  }
  if (session.isPending) return <Skeleton />;
  if (session.isError) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-fg">Use a recovery code</h1>
        <div role="alert" className="mt-4">
          <div className="mb-4 rounded-md bg-danger-subtle p-3 text-sm text-danger-subtle-fg">
            {MSG.network}
          </div>
        </div>
        <PrimaryButton type="button" onClick={() => void session.refetch()}>
          Try again
        </PrimaryButton>
      </div>
    );
  }
  if (session.data.user) return <Navigate to={readLastList()} replace />;
  if (session.data.setupRequired) return <Navigate to="/setup" replace />;

  return (
    <RecoverForm
      onSignedIn={(result) => {
        const target = safeReturnPath(from) ?? readLastList();
        // The banner needs the flag straight away; the server repeats it on every reload.
        publishSignedIn(queryClient, result.user, {
          mustAddPasskey: result.mustAddPasskey,
          recoveryCodesRemaining: result.recoveryCodesRemaining,
        });
        setDestination(target);
      }}
    />
  );
}

function RecoverForm({ onSignedIn }: { onSignedIn(result: RecoverResponse): void }) {
  const online = useOnline();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerContent | null>(null);
  const [rateWait, setRateWait] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);

  useEffect(() => () => clearTimeout(rateTimer.current), []);

  const showOffline = !online;

  function focusField(select: boolean) {
    queueMicrotask(() => {
      inputRef.current?.focus();
      if (select) inputRef.current?.select();
    });
  }

  function onError(err: unknown) {
    inFlight.current = false;
    setBusy(false);
    if (err instanceof ApiRequestError && err.status === 401) {
      setFieldError(MSG.wrong);
      focusField(true);
      return;
    }
    if (err instanceof ApiRequestError && err.status === 429) {
      const text = waitText(err.retryAfterSeconds);
      setRateWait(text);
      setBanner({
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
    setBanner({
      tone: 'error',
      live: 'alert',
      text: err instanceof NetworkError ? MSG.network : MSG.server,
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || inFlight.current || rateWait !== null || !online) return;
    setBanner(null);
    // Only "not empty after removing spaces and dashes": anything else is the server's call.
    if (code.replace(/[\s-]/g, '') === '') {
      setFieldError(MSG.empty);
      focusField(false);
      return;
    }
    setFieldError(null);
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await apiPost<RecoverResponse>('/api/auth/recover', { code: code.trim() });
      setCode('');
      inFlight.current = false;
      onSignedIn(result);
    } catch (err) {
      onError(err);
    }
  }

  const helper = showOffline ? "You're offline." : rateWait !== null ? `${rateWait}.` : '';

  return (
    <form
      aria-labelledby="recover-h1"
      noValidate
      onSubmit={(e) => void submit(e)}
      className="flex min-h-[22rem] flex-col md:min-h-0"
    >
      <h1 id="recover-h1" tabIndex={-1} className="text-xl font-semibold text-fg">
        Use a recovery code
      </h1>
      <p className="mt-2 mb-4 text-base text-fg-muted">
        Enter one of the 10 codes you saved when you set up Tidings. Each code works once.
      </p>

      <BannerSlot
        banner={
          showOffline
            ? { tone: 'warning', live: 'status', icon: 'offline', text: MSG.offline }
            : banner
        }
      />

      <TextField
        label="Recovery code"
        helper="Letters and numbers. Dashes are optional."
        error={fieldError}
        inputRef={inputRef}
        inputProps={{
          type: 'text',
          value: code,
          readOnly: busy,
          placeholder: 'XXXX-XXXX-XXXX-XXXX',
          autoComplete: 'off',
          autoCapitalize: 'characters',
          autoCorrect: 'off',
          spellCheck: false,
          inputMode: 'text',
          enterKeyHint: 'go',
          className: 'font-mono uppercase placeholder:text-fg-muted',
          onChange: (e) => setCode(e.target.value),
          ...{ 'data-1p-ignore': true, 'data-lpignore': 'true' },
        }}
      />

      <div className="mt-auto md:mt-2">
        <PrimaryButton
          busy={busy}
          blocked={showOffline || rateWait !== null}
          aria-describedby="recover-helper"
        >
          {busy ? 'Signing in...' : 'Sign in'}
        </PrimaryButton>
        <p id="recover-helper" role="status" className="mt-2 min-h-5 text-sm text-fg-muted">
          {helper}
        </p>
        <div className="mt-2 flex justify-center">
          <Link
            to="/login"
            className="inline-flex min-h-11 items-center text-base text-accent underline underline-offset-2"
          >
            Use a passkey instead
          </Link>
        </div>
      </div>
    </form>
  );
}
