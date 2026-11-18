import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader } from 'lucide-react';
import { RECOVERY_CODE_COUNT, type SessionResponse } from '@tidings/shared';
import { detectPasskeySupport } from '../auth/helpers';
import { addPasskey } from '../auth/passkeyFlows';
import { useOnline } from '../lib/hooks';
import { SESSION_KEY, useSession } from '../lib/session';
import { toast } from '../lib/toast';

/**
 * "Add a new passkey" (docs/ux/screens/recover.md section 4, TID-009 AC1, ADR 0010). Shown at the
 * top of every screen after a recovery-code sign-in, until a passkey has been registered since
 * the session began. The flag comes from the server (`mustAddPasskey`), so a reload keeps it.
 *
 * The button registers the passkey right here (options, device prompt, verify) so the owner can
 * finish on a new computer without hunting for Settings. It is in normal flow, not sticky, and
 * has no close button.
 */

const TEXT = 'You signed in with a recovery code. Add a new passkey so you don’t need another one.';
const TEXT_UNSUPPORTED =
  'You signed in with a recovery code. Open Tidings on a device that supports passkeys to add a new one.';

function codesLeft(n: number | undefined): string | null {
  if (n === undefined) return null;
  if (n === 0) return `No recovery codes left (of ${RECOVERY_CODE_COUNT}).`;
  return `${n} of ${RECOVERY_CODE_COUNT} recovery ${n === 1 ? 'code' : 'codes'} left.`;
}

export function PasskeyBanner() {
  const session = useSession();
  const client = useQueryClient();
  const online = useOnline();
  const support = useMemo(() => detectPasskeySupport(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  if (!session.data?.user || !session.data.mustAddPasskey) return null;
  const left = codesLeft(session.data.recoveryCodesRemaining);

  async function onAdd() {
    if (inFlight.current || !online) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await addPasskey();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // The server now answers mustAddPasskey: false; reflect it at once, and confirm it by refetching.
      client.setQueryData<SessionResponse>(SESSION_KEY, (old) =>
        old ? { ...old, mustAddPasskey: false } : old,
      );
      void client.invalidateQueries({ queryKey: SESSION_KEY });
      toast.success('Passkey added. You can sign in with it next time.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      data-testid="passkey-banner"
      className="mb-4 flex gap-3 rounded-md bg-warning-subtle p-3 text-sm text-warning-subtle-fg"
    >
      <KeyRound aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>{support === 'ok' ? TEXT : TEXT_UNSUPPORTED}</p>
        {left && <p className="mt-1">{left}</p>}
        {support === 'ok' && (
          <>
            <button
              type="button"
              onClick={() => void onAdd()}
              aria-disabled={busy || !online ? true : undefined}
              aria-busy={busy ? true : undefined}
              className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg md:w-auto"
            >
              {busy && <Loader aria-hidden="true" className="size-5 motion-safe:animate-spin" />}
              {busy ? 'Adding passkey...' : 'Add a new passkey'}
            </button>
            <p role="alert" className="mt-2 font-medium">
              {error}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
