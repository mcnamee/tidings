import { useRef, useState, type FormEvent } from 'react';
import { feedErrorMessage, type FeedCandidate, type Subscription } from '@tidings/shared';
import { BannerSlot, PrimaryButton, Spinner, TextField, type BannerContent } from '../auth/ui';
import { useOnline } from '../lib/hooks';
import { toast } from '../lib/toast';
import { useManageActions } from './actions';
import { ADDRESS_COPY, TYPE_LABEL, alreadyFollowBanner } from './feedAddress';
import { SHEET_BUTTON, Sheet } from './Sheet';

/**
 * Change feed address (TID-068, docs/ux/screens/manage.md). The same address rules, discovery and
 * copy as Add feed: a feed or a website address, a choice when a page has several feeds, and a
 * link to the feed the person already follows. Everything shown about a failure is a fixed string;
 * nothing the server (or the origin behind it) says is rendered.
 */

type Step =
  | { kind: 'form' }
  | { kind: 'choice'; candidates: FeedCandidate[] }
  | { kind: 'saved'; message: string };

export function ChangeAddressSheet({ sub, onClose }: { sub: Subscription; onClose: () => void }) {
  const actions = useManageActions();
  const online = useOnline();
  const [url, setUrl] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerContent | null>(null);
  const inFlight = useRef(false);

  async function submit(address: string) {
    if (inFlight.current || !online) return;
    const typed = address.trim();
    setBanner(null);
    setError(null);
    if (typed === '') {
      setError(ADDRESS_COPY.empty);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const result = await actions.changeFeedAddress(sub, typed);
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      if (!result.changed) {
        toast.success('That is already this feed’s address');
        onClose();
      } else if (result.fetch.ok) {
        toast.success('Feed address changed');
        onClose();
      } else {
        // The address changed; the first fetch did not work. Say so where it will be seen.
        const reason = feedErrorMessage(result.fetch.errorCode ?? null) ?? 'It did not respond';
        setStep({
          kind: 'saved',
          message: `The address is saved, but we couldn't load the feed just now (${reason}). Tidings will keep trying in the background.`,
        });
      }
      return;
    }
    if (result.kind === 'choice') {
      setStep({ kind: 'choice', candidates: result.candidates });
    } else if (result.kind === 'already') {
      setBanner(alreadyFollowBanner(result.subscriptionId, onClose));
    } else if (result.field && step.kind === 'form') {
      setError(result.message);
    } else {
      const tone = result.message === ADDRESS_COPY.rateLimited ? 'warning' : 'error';
      setBanner({ tone, live: 'alert', text: result.message });
    }
  }

  if (step.kind === 'saved') {
    return (
      <Sheet title="Feed address changed" onClose={onClose}>
        <p role="status" className="mt-2 text-base text-fg">
          {step.message}
        </p>
        <button type="button" className={`${SHEET_BUTTON} mt-4`} onClick={onClose}>
          Done
        </button>
      </Sheet>
    );
  }

  if (step.kind === 'choice') {
    return (
      <Sheet title={`We found ${step.candidates.length} feeds on this site`} onClose={onClose}>
        <p className="mt-1 text-sm text-fg-muted">Choose the one you want to follow.</p>
        <div className="mt-3">
          <BannerSlot banner={banner} />
        </div>
        <ul className="space-y-2">
          {step.candidates.map((c) => (
            <li key={c.url}>
              <button
                type="button"
                disabled={!c.supported || busy || !online}
                aria-busy={busy ? true : undefined}
                onClick={() => void submit(c.url)}
                className="flex min-h-14 w-full flex-col items-start justify-center rounded-md border border-line-strong bg-surface px-3 py-2 text-left disabled:opacity-60"
              >
                <span className="w-full truncate text-base font-medium text-fg">
                  {c.title ?? c.url}
                </span>
                <span className="w-full truncate text-sm text-fg-muted">
                  {TYPE_LABEL[c.type]}
                  {c.supported ? '' : ' - Not supported yet'}
                  {c.title ? ` - ${c.url}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {busy && (
          <p role="status" className="mt-3 flex items-center gap-2 text-sm text-fg-muted">
            <Spinner /> Changing address...
          </p>
        )}
        <div className="mt-4 flex flex-col gap-3">
          <button type="button" className={SHEET_BUTTON} onClick={() => setStep({ kind: 'form' })}>
            Try a different address
          </button>
          <button type="button" className={SHEET_BUTTON} onClick={onClose}>
            Cancel
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Change feed address" onClose={onClose}>
      <p className="mt-2 text-sm text-fg-muted">Current address</p>
      <p className="break-all text-base text-fg">{sub.feedUrl}</p>
      <form
        noValidate
        className="mt-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void submit(url);
        }}
      >
        <BannerSlot banner={banner} />
        <TextField
          label="New feed or website address"
          helper="Your articles and read history stay. Paste a feed, or a website that has one."
          error={error}
          inputProps={{
            type: 'text',
            inputMode: 'url',
            autoComplete: 'off',
            autoCapitalize: 'none',
            autoCorrect: 'off',
            spellCheck: false,
            placeholder: 'https://example.com/feed.xml',
            value: url,
            readOnly: busy,
            onChange: (e) => {
              setUrl(e.target.value);
              if (error) setError(null);
            },
          }}
        />
        <div className="flex flex-col gap-3">
          <PrimaryButton busy={busy} blocked={!online}>
            {busy ? 'Saving...' : 'Save'}
          </PrimaryButton>
          {!online && (
            <p role="status" className="text-center text-sm text-fg-muted">
              You&apos;re offline
            </p>
          )}
          <button type="button" className={SHEET_BUTTON} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}
