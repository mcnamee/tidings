import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import {
  DISPLAY_NAME_MAX,
  type CreationOptionsJSON,
  type SessionResponse,
  type SetupVerifyResponse,
} from '@tidings/shared';
import { ApiRequestError, NetworkError, apiPost } from '../api';
import { readLastList } from '../lib/lastList';
import { publishSignedIn, SESSION_KEY, useSession } from '../lib/session';
import { useOnline } from '../lib/hooks';
import { useAuthLayout } from '../shell/AuthLayout';
import { useDocumentTitle } from '../shell/useDocumentTitle';
import { detectPasskeySupport, passkeyLabel, waitText } from './helpers';
import { RecoveryCodesStep } from './RecoveryCodesStep';
import { BannerSlot, PrimaryButton, TextField, type BannerContent } from './ui';

/**
 * First-run setup (docs/ux/screens/setup.md): step 1 creates the passkey, step 2 shows the
 * recovery codes once. The two steps are one route and one component, with no URL change.
 *
 * The setup token and the recovery codes are held in component state only. Requests are made
 * with plain `apiPost` rather than TanStack mutations so that neither can ever reach the query
 * cache or its persister (setup.md section 6).
 */

type Phase = 'idle' | 'server' | 'prompt';

const MSG = {
  offline: "You're offline. Connect to the internet to continue.",
  network: "Couldn't reach Tidings. Check your connection and try again.",
  server: 'Something went wrong on our side. Try again.',
  cancelled: 'Passkey setup was cancelled. Try again.',
  verify: "We couldn't verify that passkey. Try again.",
  badToken: "That setup token isn't right. Check it and try again.",
} as const;

function Skeleton() {
  return (
    <div aria-busy="true" data-testid="setup-skeleton">
      <div className="h-7 w-40 animate-skeleton rounded-md bg-sunken" />
      <div className="mt-6 space-y-4">
        {[0, 1].map((i) => (
          <div key={i}>
            <div className="mb-2 h-5 w-24 animate-skeleton rounded-md bg-sunken" />
            <div className="h-12 animate-skeleton rounded-md bg-sunken" />
          </div>
        ))}
        <div className="h-12 animate-skeleton rounded-md bg-sunken" />
      </div>
    </div>
  );
}

function SessionError({ onRetry }: { onRetry(): void }) {
  return (
    <div>
      <h1 className="text-xl font-semibold text-fg">Set up Tidings</h1>
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

export function Setup() {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const layout = useAuthLayout();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [verified, setVerified] = useState<SetupVerifyResponse['user'] | null>(null);
  // Set when the server says setup is closed mid-flow (409): go to /login with a notice.
  const [alreadySetUp, setAlreadySetUp] = useState(false);

  const stepTwo = codes !== null;
  useEffect(() => {
    layout.setWide(stepTwo);
    return () => layout.setWide(false);
  }, [layout, stepTwo]);

  function finish() {
    // Drop the codes first, then publish only the user (never the codes) to the session cache.
    setCodes(null);
    if (verified) {
      publishSignedIn(queryClient, verified);
    }
    void navigate('/all', { replace: true });
  }

  if (stepTwo) {
    // Once the account exists the session query may say "signed in"; step 2 must not redirect.
    return <RecoveryCodesStep codes={codes} onDone={finish} />;
  }
  if (alreadySetUp) {
    return <Navigate to="/login" replace state={{ notice: 'already-set-up' }} />;
  }
  if (session.isPending) return <Skeleton />;
  if (session.isError) return <SessionError onRetry={() => void session.refetch()} />;
  if (session.data.user) return <Navigate to={readLastList()} replace />;
  if (!session.data.setupRequired) {
    return <Navigate to="/login" replace />;
  }
  return (
    <SetupForm
      onCreated={(result) => {
        setVerified(result.user);
        setCodes(result.recoveryCodes);
      }}
      onAlreadySetUp={() => {
        queryClient.setQueryData<SessionResponse>(SESSION_KEY, {
          user: null,
          setupRequired: false,
          mustAddPasskey: false,
        });
        setAlreadySetUp(true);
      }}
    />
  );
}

interface SetupFormProps {
  onCreated(result: SetupVerifyResponse): void;
  onAlreadySetUp(): void;
}

function SetupForm({ onCreated, onAlreadySetUp }: SetupFormProps) {
  useDocumentTitle('Set up Tidings');
  const online = useOnline();
  const support = useMemo(() => detectPasskeySupport(), []);
  const [displayName, setDisplayName] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [banner, setBanner] = useState<BannerContent | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [rateWait, setRateWait] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);

  useEffect(() => () => clearTimeout(rateTimer.current), []);

  const busy = phase !== 'idle';
  const showOffline = !online;

  function fail(b: BannerContent) {
    setBanner(b);
    setPhase('idle');
    inFlight.current = false;
    // Retrying is one key press or tap (setup.md 2.3).
    queueMicrotask(() => buttonRef.current?.focus());
  }

  const errorBanner = (text: string): BannerContent => ({ tone: 'error', live: 'alert', text });

  function handleApiError(err: unknown, stage: 'options' | 'verify'): void {
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
      if (err.code === 'invalid_setup_token') {
        setBanner(null);
        setTokenError(MSG.badToken);
        setPhase('idle');
        inFlight.current = false;
        queueMicrotask(() => {
          tokenRef.current?.focus();
          tokenRef.current?.select();
        });
        return;
      }
      if (err.code === 'setup_unavailable') {
        inFlight.current = false;
        onAlreadySetUp();
        return;
      }
      if (err.code === 'webauthn_failed' && stage === 'verify') {
        fail(errorBanner(MSG.verify));
        return;
      }
      fail(errorBanner(MSG.server));
      return;
    }
    fail(errorBanner(err instanceof NetworkError ? MSG.network : MSG.server));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || inFlight.current || rateWait !== null) return;
    if (!online) return;

    const name = displayName.trim();
    const token = setupToken.trim();
    const nextNameError = !name
      ? 'Enter your name.'
      : Array.from(name).length > DISPLAY_NAME_MAX
        ? 'Use 64 characters or fewer.'
        : null;
    const nextTokenError = token ? null : 'Enter your setup token.';
    setNameError(nextNameError);
    setTokenError(nextTokenError);
    setBanner(null);
    if (nextNameError || nextTokenError) {
      (nextNameError ? nameRef : tokenRef).current?.focus();
      return;
    }

    inFlight.current = true;
    setPhase('server');
    let options: CreationOptionsJSON;
    try {
      options = await apiPost<CreationOptionsJSON>('/api/auth/setup/options', {
        setupToken: token,
        displayName: name,
      });
    } catch (err) {
      handleApiError(err, 'options');
      return;
    }

    setPhase('prompt');
    let credential;
    try {
      const { startRegistration } = await import('@simplewebauthn/browser');
      credential = await startRegistration({
        optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'],
      });
    } catch (err) {
      const errName = err instanceof Error ? err.name : '';
      if (errName === 'NotAllowedError' || errName === 'AbortError') {
        fail({ tone: 'info', live: 'status', icon: 'info', text: MSG.cancelled });
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
      const result = await apiPost<SetupVerifyResponse>('/api/auth/setup/verify', {
        setupToken: token,
        displayName: name,
        response: credential,
        passkeyName: passkeyLabel(navigator.userAgent),
      });
      // The token is dropped as step 2 appears (setup.md 1).
      setSetupToken('');
      setShowToken(false);
      inFlight.current = false;
      onCreated(result);
    } catch (err) {
      handleApiError(err, 'verify');
    }
  }

  if (support !== 'ok') {
    const insecure = support === 'insecure';
    return (
      <div>
        <h1 className="text-xl font-semibold text-fg">Set up Tidings</h1>
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
        ? 'Creating passkey...'
        : 'Create passkey';

  return (
    <form aria-labelledby="setup-h1" noValidate autoComplete="off" onSubmit={(e) => void submit(e)}>
      <h1 id="setup-h1" tabIndex={-1} className="text-xl font-semibold text-fg">
        Set up Tidings
      </h1>
      <p className="mt-2 mb-4 text-base text-fg-muted">
        Create your account with a passkey. You&apos;ll need the setup token from your deployment.
      </p>

      <BannerSlot
        banner={
          showOffline
            ? { tone: 'warning', live: 'status', icon: 'offline', text: MSG.offline }
            : banner
        }
      />

      <TextField
        label="Your name"
        helper="Shown in Settings."
        error={nameError}
        inputRef={nameRef}
        inputProps={{
          type: 'text',
          value: displayName,
          onChange: (e) => setDisplayName(e.target.value),
          readOnly: busy,
          autoComplete: 'name',
          autoCapitalize: 'words',
          spellCheck: false,
          enterKeyHint: 'next',
        }}
      />
      <TextField
        label="Setup token"
        helper="The SETUP_TOKEN secret you set when you deployed Tidings."
        error={tokenError}
        inputRef={tokenRef}
        inputProps={{
          type: showToken ? 'text' : 'password',
          value: setupToken,
          onChange: (e) => setSetupToken(e.target.value),
          readOnly: busy,
          autoComplete: 'off',
          autoCapitalize: 'none',
          autoCorrect: 'off',
          spellCheck: false,
          enterKeyHint: 'go',
          ...{ 'data-1p-ignore': true, 'data-lpignore': 'true' },
        }}
        trailing={
          <button
            type="button"
            onClick={() => setShowToken((v) => !v)}
            aria-label={showToken ? 'Hide setup token' : 'Show setup token'}
            aria-pressed={showToken}
            className="flex size-11 items-center justify-center rounded-md text-fg-muted"
          >
            {showToken ? (
              <EyeOff className="size-5" aria-hidden="true" />
            ) : (
              <Eye className="size-5" aria-hidden="true" />
            )}
          </button>
        }
      />

      <PrimaryButton
        ref={buttonRef}
        busy={busy}
        blocked={showOffline || rateWait !== null}
        aria-describedby="setup-helper"
      >
        {label}
      </PrimaryButton>
      <p id="setup-helper" role="status" className="mt-2 min-h-5 text-sm text-fg-muted">
        {helper}
      </p>

      <Link
        to="/login"
        className="inline-flex min-h-11 items-center text-base text-accent underline underline-offset-2"
      >
        Already set up? Sign in
      </Link>
    </form>
  );
}
