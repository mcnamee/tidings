import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import {
  feedErrorMessage,
  type FeedCandidate,
  type SubscribeRequest,
  type SubscribeResponse,
  type Subscription,
} from '@tidings/shared';
import { ApiRequestError, NetworkError, apiPost } from '../api';
import { useFolders } from '../lib/queries';
import { BannerSlot, PrimaryButton, Spinner, TextField, type BannerContent } from '../auth/ui';
import { useOnline } from '../lib/hooks';
import { toast } from '../lib/toast';
import { BottomBar } from '../shell/slots';
import {
  ADDRESS_COPY,
  TYPE_LABEL,
  alreadyFollowBanner,
  existingId,
  isCandidates,
} from './feedAddress';

/**
 * Add a feed (docs/ux/FLOWS.md 2.3). One address field (a feed or a website), an optional folder
 * and title. States the UX notes do not draw (busy, choice list, partial success, rate limit,
 * folder gone) follow the auth screens' pattern: banners from `auth/ui`, never colour alone.
 *
 * Everything shown about a failure is a fixed string chosen here or in `feedErrorMessage`. The
 * server never sends origin text, and this screen would not render it if it did (spec 10.6).
 */

/** The server waits up to 10 s to look at the address and 10 s for the first fetch. */
const SUBSCRIBE_TIMEOUT_MS = 30_000;

const COPY = {
  ...ADDRESS_COPY,
  limit: "You've reached the limit of 1,000 feeds.",
  folderGone: 'That folder no longer exists. Choose another folder.',
  offline: "You're offline",
} as const;

const FIELD =
  'block min-h-12 w-full rounded-md border border-line-strong bg-sunken px-3 text-base text-fg';

type Screen =
  | { kind: 'form' }
  | { kind: 'choice'; candidates: FeedCandidate[] }
  | { kind: 'added'; subscription: Subscription; message: string };

export function AddFeed() {
  const online = useOnline();
  const navigate = useNavigate();
  const client = useQueryClient();
  const folders = useFolders();

  const [url, setUrl] = useState('');
  const [folderId, setFolderId] = useState('');
  const [title, setTitle] = useState('');
  const [screen, setScreen] = useState<Screen>({ kind: 'form' });
  const [busy, setBusy] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerContent | null>(null);

  const urlRef = useRef<HTMLInputElement>(null);
  const choiceHeading = useRef<HTMLHeadingElement>(null);
  const addedHeading = useRef<HTMLHeadingElement>(null);
  const inFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const folderSelectId = useId();
  const folderHelperId = useId();

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (screen.kind === 'choice') choiceHeading.current?.focus();
    if (screen.kind === 'added') addedHeading.current?.focus();
  }, [screen.kind]);

  const folderList = folders.data ?? [];

  function stop(focusUrl: boolean) {
    inFlight.current = false;
    setBusy(false);
    if (focusUrl) queueMicrotask(() => urlRef.current?.focus());
  }

  /** An error about the address: under the field, or in the banner when the field is not shown. */
  function addressError(message: string): void {
    if (screen.kind === 'choice') setBanner({ tone: 'error', live: 'alert', text: message });
    else setUrlError(message);
  }

  function handleError(err: unknown): void {
    if (err instanceof ApiRequestError) {
      switch (err.code) {
        case 'feed_choice_required':
          if (isCandidates(err.details)) {
            setScreen({ kind: 'choice', candidates: err.details.candidates });
            return stop(false);
          }
          break;
        case 'no_feed_found':
          addressError(COPY.noFeed);
          return stop(screen.kind !== 'choice');
        case 'blocked_address':
          addressError(COPY.blocked);
          return stop(screen.kind !== 'choice');
        case 'validation_failed':
          addressError(COPY.invalid);
          return stop(screen.kind !== 'choice');
        case 'already_subscribed': {
          setBanner(alreadyFollowBanner(existingId(err.details)));
          return stop(false);
        }
        case 'limit_reached':
          setBanner({ tone: 'error', live: 'alert', text: COPY.limit });
          return stop(false);
        case 'not_found':
          // The chosen folder is gone (or never was yours): refresh the list and say so.
          setFolderId('');
          void client.invalidateQueries({ queryKey: ['folders'] });
          setBanner({ tone: 'error', live: 'alert', text: COPY.folderGone });
          return stop(false);
        case 'rate_limited':
          setBanner({ tone: 'warning', live: 'alert', icon: 'warning', text: COPY.rateLimited });
          return stop(false);
        default:
          break;
      }
      setBanner({ tone: 'error', live: 'alert', text: COPY.server });
      return stop(false);
    }
    setBanner({
      tone: 'error',
      live: 'alert',
      text: err instanceof NetworkError ? COPY.network : COPY.server,
    });
    stop(false);
  }

  async function submit(address: string) {
    if (inFlight.current) return;
    if (!online) return;
    setBanner(null);
    setUrlError(null);
    if (address.trim() === '') {
      setUrlError(COPY.empty);
      urlRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    abort.current = new AbortController();
    const body: SubscribeRequest = { url: address.trim() };
    if (folderId !== '') body.folderId = folderId;
    if (title.trim() !== '') body.title = title.trim();
    try {
      const res = await apiPost<SubscribeResponse>('/api/subscriptions', body, {
        signal: abort.current.signal,
        timeoutMs: SUBSCRIBE_TIMEOUT_MS,
      });
      void client.invalidateQueries({ queryKey: ['subscriptions'] });
      void client.invalidateQueries({ queryKey: ['counts'] });
      void client.invalidateQueries({ queryKey: ['folders'] });
      const { subscription } = res;
      if (res.fetch.ok) {
        toast.success(`Added ${subscription.title}`);
        void navigate(`/feeds/${subscription.id}`);
        return;
      }
      // The subscription exists; the first fetch did not work. Say so on this screen, where it
      // will be seen, rather than in a toast that disappears (AC5).
      const reason = feedErrorMessage(res.fetch.errorCode ?? null) ?? 'It did not respond';
      setScreen({
        kind: 'added',
        subscription,
        message: `We couldn't load it just now (${reason}). Tidings will keep trying in the background.`,
      });
      stop(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      handleError(err);
    }
  }

  function reset() {
    setScreen({ kind: 'form' });
    setUrl('');
    setTitle('');
    setBanner(null);
    setUrlError(null);
    queueMicrotask(() => urlRef.current?.focus());
  }

  if (screen.kind === 'added') {
    return (
      <div>
        <h2
          ref={addedHeading}
          tabIndex={-1}
          className="text-lg font-semibold text-fg focus:outline-none"
        >
          Added {screen.subscription.title}
        </h2>
        <p role="status" className="mt-2 text-base text-fg">
          {screen.message}
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <Link
            to={`/feeds/${screen.subscription.id}`}
            className="flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-4 text-base font-medium text-accent-fg"
          >
            Open feed
          </Link>
          <button
            type="button"
            onClick={reset}
            className="flex min-h-12 w-full items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg"
          >
            Add another feed
          </button>
        </div>
      </div>
    );
  }

  if (screen.kind === 'choice') {
    const count = screen.candidates.length;
    return (
      <div>
        <BannerSlot banner={banner} />
        <h2
          ref={choiceHeading}
          tabIndex={-1}
          className="text-lg font-semibold text-fg focus:outline-none"
        >
          We found {count} feeds on this site
        </h2>
        <p className="mt-1 text-sm text-fg-muted">Choose the one you want to follow.</p>
        <ul className="mt-4 space-y-2">
          {screen.candidates.map((c) => (
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
        <button
          type="button"
          onClick={() => setScreen({ kind: 'form' })}
          className="mt-4 inline-flex min-h-11 items-center text-base text-accent underline underline-offset-2"
        >
          Try a different address
        </button>
        {busy && (
          <p role="status" className="mt-4 flex items-center gap-2 text-sm text-fg-muted">
            <Spinner /> Adding feed...
          </p>
        )}
      </div>
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(url);
  }

  return (
    <div>
      <form id="add-feed-form" noValidate onSubmit={onSubmit}>
        <BannerSlot banner={banner} />
        <TextField
          label="Feed or website address"
          helper="Paste the address of a feed, or of a website that has one."
          error={urlError}
          inputRef={urlRef}
          inputProps={{
            type: 'text',
            inputMode: 'url',
            autoComplete: 'off',
            autoCapitalize: 'none',
            autoCorrect: 'off',
            spellCheck: false,
            placeholder: 'https://example.com',
            value: url,
            readOnly: busy,
            onChange: (e) => {
              setUrl(e.target.value);
              if (urlError) setUrlError(null);
            },
          }}
        />
        <div className="mb-4">
          <label htmlFor={folderSelectId} className="mb-1 block text-base font-medium text-fg">
            Folder (optional)
          </label>
          <select
            id={folderSelectId}
            aria-describedby={folderHelperId}
            value={folderId}
            disabled={busy}
            onChange={(e) => setFolderId(e.target.value)}
            className={FIELD}
          >
            <option value="">No folder</option>
            {folderList.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <p id={folderHelperId} className="mt-1 text-sm text-fg-muted">
            You can move it later.
          </p>
        </div>
        <TextField
          label="Title (optional)"
          helper="Leave blank to use the feed's own title."
          inputProps={{
            type: 'text',
            autoComplete: 'off',
            maxLength: 200,
            value: title,
            readOnly: busy,
            onChange: (e) => setTitle(e.target.value),
          }}
        />
        {/* The visible button lives in the bottom bar, outside the form. With several fields and
            no submit button of its own, browsers would not submit on Enter. */}
        <button type="submit" tabIndex={-1} aria-hidden="true" className="sr-only" />
      </form>
      <BottomBar>
        <div className="flex w-full flex-col py-2">
          <PrimaryButton
            type="button"
            busy={busy}
            blocked={!online}
            onClick={() => void submit(url)}
            aria-describedby={online ? undefined : 'add-feed-offline'}
          >
            {busy ? 'Adding feed...' : 'Add feed'}
          </PrimaryButton>
          {!online && (
            <p
              id="add-feed-offline"
              role="status"
              className="mt-1 flex items-center justify-center gap-1.5 text-sm text-fg-muted"
            >
              <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
              {COPY.offline}
            </p>
          )}
        </div>
      </BottomBar>
    </div>
  );
}
