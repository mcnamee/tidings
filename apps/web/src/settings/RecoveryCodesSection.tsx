import { useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import type { RecoveryCodesResponse } from '@tidings/shared';
import { ApiRequestError, NetworkError, apiPost } from '../api';
import { RECOVERY_FILE_NAME, downloadTextFile, recoveryCodesFile } from '../auth/helpers';
import { SHEET_BUTTON, Sheet } from '../manage/Sheet';
import { useReauth } from './useReauth';

/**
 * FR-AU-7, TID-022 AC4: new recovery codes. The server needs a passkey or recovery sign-in from
 * the last 15 minutes; on `403 reauth_required` this runs a passkey sign-in and retries once. The
 * codes live in this component's state only (not the query cache, storage or the URL) and are
 * gone when the sheet closes.
 */

const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg';

type Step = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'codes'; codes: string[] };

export function RecoveryCodesSection() {
  const reauth = useReauth();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let res: RecoveryCodesResponse;
      try {
        res = await apiPost<RecoveryCodesResponse>('/api/auth/recovery-codes', {});
      } catch (err) {
        if (!(err instanceof ApiRequestError && err.code === 'reauth_required')) throw err;
        const problem = await reauth();
        if (problem) {
          setError(problem);
          return;
        }
        res = await apiPost<RecoveryCodesResponse>('/api/auth/recovery-codes', {});
      }
      setStep({ kind: 'codes', codes: res.recoveryCodes });
    } catch (err) {
      setError(
        err instanceof NetworkError
          ? "Couldn't reach Tidings. Check your connection and try again."
          : err instanceof ApiRequestError && err.code === 'reauth_required'
            ? 'Sign in with a passkey to do this.'
            : 'Something went wrong on our side. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="codes-h2" id="recovery-codes" className="mt-8">
      <h2 id="codes-h2" className="text-lg font-semibold text-fg">
        Recovery codes
      </h2>
      <p className="mt-1 text-sm text-fg-muted">
        If you lose your passkeys, a recovery code signs you in. Making new codes replaces all the
        old ones.
      </p>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setStep({ kind: 'confirm' });
        }}
        className={`${BUTTON} mt-3 w-full md:w-auto`}
      >
        Make new recovery codes
      </button>
      {step.kind !== 'confirm' && (
        <p role="alert" className="mt-2 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {step.kind === 'confirm' && (
        <Sheet title="Make new recovery codes?" onClose={() => setStep({ kind: 'idle' })}>
          <p className="mt-2 text-base text-fg-muted">
            Your current codes stop working straight away. The new ones are shown once, so have
            somewhere safe ready.
          </p>
          <p role="alert" className="mt-2 min-h-5 text-sm font-medium text-danger">
            {error}
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void generate()}
              aria-disabled={busy ? true : undefined}
              className="flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-4 text-base font-medium text-accent-fg"
            >
              {busy ? 'Making codes...' : 'Make new codes'}
            </button>
            <button
              type="button"
              data-autofocus
              onClick={() => setStep({ kind: 'idle' })}
              className={SHEET_BUTTON}
            >
              Cancel
            </button>
          </div>
        </Sheet>
      )}

      {step.kind === 'codes' && (
        <NewCodes codes={step.codes} onDone={() => setStep({ kind: 'idle' })} />
      )}
    </section>
  );
}

function NewCodes({ codes, onDone }: { codes: readonly string[]; onDone: () => void }) {
  const [status, setStatus] = useState('');
  const [saved, setSaved] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setSaved(true);
      setStatus(`Copied ${codes.length} codes.`);
    } catch {
      setStatus("Couldn't copy. Select the codes and copy them by hand.");
    }
  }
  function download() {
    try {
      downloadTextFile(RECOVERY_FILE_NAME, recoveryCodesFile(codes, new Date(), location.host));
      setSaved(true);
      setStatus(`Saved ${RECOVERY_FILE_NAME}.`);
    } catch {
      setStatus("Couldn't download the file. Copy the codes instead.");
    }
  }

  // Closing is only by the button: a stray tap on the scrim must not lose codes that are shown once.
  return (
    <Sheet title="Your new recovery codes" onClose={() => undefined}>
      <p className="mt-2 text-base text-fg-muted">
        Save these now. They&apos;re shown once, and your old codes no longer work.
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => void copy()} className={`${BUTTON} flex-1`}>
          {saved && status.startsWith('Copied') ? (
            <Check aria-hidden="true" className="size-5" />
          ) : (
            <Copy aria-hidden="true" className="size-5" />
          )}
          Copy codes
        </button>
        <button type="button" onClick={download} className={`${BUTTON} flex-1`}>
          <Download aria-hidden="true" className="size-5" />
          Download .txt
        </button>
      </div>
      <p role="status" className="mt-2 min-h-5 text-sm text-fg-muted">
        {status}
      </p>
      <ol
        aria-label="New recovery codes"
        data-testid="new-recovery-codes"
        className="mt-2 select-text overflow-x-auto rounded-md bg-sunken p-3 [counter-reset:code]"
      >
        {codes.map((code) => (
          <li
            key={code}
            className="flex min-h-10 items-center font-mono text-base tabular-nums text-fg [counter-increment:code] before:inline-block before:w-8 before:select-none before:text-fg-muted before:content-[counter(code)]"
          >
            <code className="whitespace-nowrap">{code}</code>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={onDone}
        className="mt-3 flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-4 text-base font-medium text-accent-fg"
      >
        I&apos;ve saved these
      </button>
    </Sheet>
  );
}
