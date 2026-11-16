import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Check, Copy, Download, TriangleAlert } from 'lucide-react';
import { useDocumentTitle } from '../shell/useDocumentTitle';
import { RECOVERY_FILE_NAME, downloadTextFile, recoveryCodesFile } from './helpers';
import { PrimaryButton } from './ui';

/**
 * Setup step 2 (docs/ux/screens/setup.md sections 4 to 6). The codes live in props from the
 * parent's component state and nowhere else: not the query cache, any web storage, history state,
 * the URL, document.title, or logs. They are only rendered, copied and downloaded.
 */
export interface RecoveryCodesStepProps {
  codes: readonly string[];
  /** Called once when the user leaves (Continue, or Leave anyway, or Back after ticking). */
  onDone(): void;
  /** Injected for tests. */
  now?: () => Date;
  host?: string;
}

type Status =
  { kind: 'none' } | { kind: 'copied' } | { kind: 'saved' } | { kind: 'error'; text: string };

/** Marks the extra history entry that the Back guard owns. Contains no codes. */
const GUARD_STATE = { setupCodes: true };

function isGuardEntry(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'setupCodes' in state;
}

export function RecoveryCodesStep({ codes, onDone, now, host }: RecoveryCodesStepProps) {
  useDocumentTitle('Save your recovery codes');
  const navigate = useNavigate();
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const checkboxRef = useRef<HTMLInputElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);
  const leaveRef = useRef<HTMLButtonElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [saved, setSaved] = useState(false); // copied or downloaded at least once
  const [status, setStatus] = useState<Status>({ kind: 'none' });
  const [copiedLabel, setCopiedLabel] = useState(false);
  const [pressedEarly, setPressedEarly] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  // Focus moves to the new h1 on the step change (auth-common 6).
  useEffect(() => headingRef.current?.focus(), []);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  // beforeunload: the browser's own "Leave site?" prompt while the codes are unconfirmed.
  useEffect(() => {
    if (confirmed) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [confirmed]);

  // Back guard. On entry push one extra history entry (flag only). If Back lands before it, put
  // it back and ask; if the box is ticked, Back simply leaves.
  const pushRequested = useRef(false);
  const guardSeen = useRef(false);
  const left = useRef(false);
  useEffect(() => {
    if (left.current) return;
    if (isGuardEntry(location.state)) {
      guardSeen.current = true;
      pushRequested.current = false;
      return;
    }
    if (!guardSeen.current) {
      if (!pushRequested.current) {
        pushRequested.current = true;
        navigate('.', { state: GUARD_STATE });
      }
      return;
    }
    // Landed before the guard entry: the user pressed Back (or swiped).
    if (confirmed) {
      leave();
      return;
    }
    if (!pushRequested.current) {
      pushRequested.current = true;
      navigate('.', { state: GUARD_STATE });
      setDialogOpen(true);
    }
  }, [location, confirmed]);

  function leave() {
    if (left.current) return;
    left.current = true;
    onDoneRef.current();
  }

  // The leave dialog: initial focus on "Stay", Tab trapped between its two buttons, Escape stays.
  useEffect(() => {
    if (dialogOpen) stayRef.current?.focus();
  }, [dialogOpen]);

  // Focus returns to the checkbox only once the page behind the dialog is interactive again.
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!dialogOpen && restoreFocus.current) {
      restoreFocus.current = false;
      checkboxRef.current?.focus();
    }
  }, [dialogOpen]);

  function closeDialog() {
    restoreFocus.current = true;
    setDialogOpen(false);
  }

  // While the dialog is open: Escape chooses Stay and Tab is trapped between its two buttons.
  useEffect(() => {
    if (!dialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDialog();
      } else if (e.key === 'Tab') {
        const first = stayRef.current;
        const last = leaveRef.current;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dialogOpen]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
    } catch {
      setStatus({
        kind: 'error',
        text: "Couldn't copy. Select the codes and copy them by hand.",
      });
      return;
    }
    setSaved(true);
    setStatus({ kind: 'copied' });
    setCopiedLabel(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedLabel(false), 4000);
  }

  function download() {
    try {
      downloadTextFile(
        RECOVERY_FILE_NAME,
        recoveryCodesFile(codes, (now ?? (() => new Date()))(), host ?? window.location.host),
      );
    } catch {
      setStatus({ kind: 'error', text: "Couldn't download the file. Copy the codes instead." });
      return;
    }
    setSaved(true);
    setStatus({ kind: 'saved' });
  }

  const statusText =
    status.kind === 'copied'
      ? `Copied ${codes.length} codes.`
      : status.kind === 'saved'
        ? `Saved ${RECOVERY_FILE_NAME}.`
        : status.kind === 'error'
          ? status.text
          : '';

  const helperText = saved
    ? "You can get new codes later in Settings, but these won't be shown again."
    : "Somewhere safe, like a password manager. They won't be shown again.";

  return (
    <>
      <div inert={dialogOpen}>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-semibold text-fg focus:outline-none"
        >
          Save your recovery codes
        </h1>

        <div role="status" className="mt-4">
          <div className="flex gap-3 rounded-md bg-warning-subtle p-3 text-sm text-warning-subtle-fg">
            <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <p>Save these now. This is the only time they&apos;re shown.</p>
          </div>
        </div>
        <p className="mt-4 text-base text-fg-muted">
          If you lose your passkey, one of these codes signs you in. Each code works once.
        </p>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={
              copiedLabel ? 'Copied 10 recovery codes' : 'Copy codes, all 10 recovery codes'
            }
            className="flex min-h-11 min-w-36 flex-1 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-base text-fg"
          >
            {copiedLabel ? (
              <Check className="size-5" aria-hidden="true" />
            ) : (
              <Copy className="size-5" aria-hidden="true" />
            )}
            {copiedLabel ? 'Copied' : 'Copy codes'}
          </button>
          <button
            type="button"
            onClick={download}
            aria-label="Download .txt file of recovery codes"
            className="flex min-h-11 min-w-36 flex-1 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-base text-fg"
          >
            <Download className="size-5" aria-hidden="true" />
            Download .txt
          </button>
        </div>
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          className={`mt-2 min-h-5 text-sm ${status.kind === 'error' ? 'text-danger' : 'text-fg-muted'}`}
        >
          {statusText}
        </p>

        <ol
          aria-label="Recovery codes"
          className="mt-2 select-text overflow-x-auto rounded-md bg-sunken p-3 [counter-reset:code]"
        >
          {codes.map((code) => (
            <li
              key={code}
              className="flex min-h-10 items-center font-mono text-base tabular-nums text-fg [counter-increment:code] before:inline-block before:w-8 before:select-none before:text-fg-muted before:content-[counter(code)] md:text-lg"
            >
              <code className="whitespace-nowrap">{code}</code>
            </li>
          ))}
        </ol>

        <div
          data-codes-footer
          className="static bottom-0 -mx-6 mt-4 border-t border-line bg-surface px-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 [@media(min-height:40rem)_and_(max-width:47.999rem)]:sticky md:static"
        >
          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2">
            <input
              ref={checkboxRef}
              type="checkbox"
              checked={confirmed}
              onChange={(e) => {
                setConfirmed(e.target.checked);
                setPressedEarly(false);
              }}
              aria-describedby="codes-helper"
              className="mt-0.5 size-6 shrink-0 accent-accent"
            />
            <span className="text-base font-medium text-fg">I&apos;ve saved these</span>
          </label>
          <p id="codes-helper" className="mb-3 ml-9 text-sm text-fg-muted">
            {helperText}
          </p>
          <PrimaryButton
            type="button"
            blocked={!confirmed}
            aria-describedby="continue-helper"
            onClick={leave}
            onBlockedPress={() => setPressedEarly(true)}
          >
            Continue
          </PrimaryButton>
          <p id="continue-helper" className="mt-2 min-h-5 text-sm text-fg-muted">
            {confirmed ? '' : 'Tick the box to continue.'}
          </p>
          <p role="status" className="sr-only">
            {pressedEarly && !confirmed ? 'Tick the box to continue.' : ''}
          </p>
        </div>
      </div>

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Tapping the scrim chooses "Stay and save codes" (setup.md 5.5). */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            data-scrim
            onClick={closeDialog}
            className="absolute inset-0 cursor-default bg-scrim"
          />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="leave-title"
            aria-describedby="leave-body"
            className="relative w-full max-w-sm rounded-lg border border-line bg-raised p-6 shadow-overlay"
          >
            <h2 id="leave-title" className="text-xl font-semibold text-fg">
              Leave without saving?
            </h2>
            <p id="leave-body" className="mt-2 text-base text-fg-muted">
              Your recovery codes won&apos;t be shown again. You can make new ones later in
              Settings.
            </p>
            <div className="mt-6 flex flex-col gap-2">
              <PrimaryButton ref={stayRef} type="button" onClick={closeDialog}>
                Stay and save codes
              </PrimaryButton>
              <button
                ref={leaveRef}
                type="button"
                onClick={leave}
                className="min-h-11 rounded-md px-4 text-base text-accent"
              >
                Leave anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
