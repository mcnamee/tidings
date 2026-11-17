import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import type { ImportOpmlRequest, ImportOpmlResponse } from '@tidings/shared';
import { ApiRequestError, NetworkError, apiPost } from '../api';
import { BannerSlot, PrimaryButton, type BannerContent } from '../auth/ui';
import { useOnline } from '../lib/hooks';
import { MAX_OPML_BYTES, OpmlError, chunkEntries, parseOpml, type OpmlEntry } from '../lib/opml';
import {
  COUNTS_KEY,
  FOLDERS_KEY,
  SUBSCRIPTIONS_KEY,
  fetchSubscriptions,
  useSubscriptions,
} from '../lib/queries';
import { BottomBar } from '../shell/slots';

/**
 * Import from OPML (docs/ux/FLOWS.md 2.2): choose a file, preview what it holds, send it in
 * requests of at most 100 feeds, then watch the first fetches. The file is parsed in the browser
 * and nothing is saved until the person confirms. States the UX notes do not draw (sending,
 * a failed request, nothing new to import, deferred feeds) are listed in the TID-016 report.
 */

export const POLL_MS = 5000;

export const COPY = {
  notOpml: "That file doesn't look like an OPML export",
  instructions:
    'In Inoreader, open Preferences, then Import / Export, and export your subscriptions as an OPML file. Then choose that file here.',
  offline: "You're offline",
  network: "Couldn't reach Tidings. Check your connection and try again.",
  rateLimited: 'Too many requests. Try again in a minute.',
  server: 'Something went wrong on our side. Try again.',
  nothingNew: 'Everything in this file is already in Tidings.',
} as const;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const SECONDARY =
  'flex min-h-12 w-full items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg';
const LINK_BUTTON =
  'flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-4 text-base font-medium text-accent-fg';

interface Plan {
  entries: OpmlEntry[];
  toImport: OpmlEntry[];
  total: number;
  folderCount: number;
  alreadySubscribed: number;
  invalid: number;
  multiFolder: number;
  /** IDs of the subscriptions that existed before the import, to tell the new ones apart. */
  baseline: ReadonlySet<string>;
}

interface Totals {
  created: number;
  deferred: number;
  skipped: number;
}

type Stage =
  | { kind: 'choose' }
  | { kind: 'preview'; plan: Plan }
  | {
      kind: 'sending';
      plan: Plan;
      chunks: ImportOpmlRequest[];
      next: number;
      totals: Totals;
      failed: boolean;
    }
  | { kind: 'progress'; plan: Plan; totals: Totals };

function readFile(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function failureText(err: unknown): string {
  if (err instanceof NetworkError) return COPY.network;
  if (err instanceof ApiRequestError && err.status === 429) return COPY.rateLimited;
  return COPY.server;
}

export function ImportOpml() {
  const client = useQueryClient();
  const online = useOnline();
  const [stage, setStage] = useState<Stage>({ kind: 'choose' });
  const [banner, setBanner] = useState<BannerContent | null>(null);
  const [reading, setReading] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => heading.current?.focus(), [stage.kind]);

  const error = (text: string) => setBanner({ tone: 'error', live: 'alert', text });

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // the same file can be chosen again
    if (!file || busy.current) return;
    busy.current = true;
    setBanner(null);
    setReading(true);
    try {
      if (file.size > MAX_OPML_BYTES) throw new OpmlError('too_big');
      const parsed = parseOpml(await readFile(file));
      // The preview says how many are already followed, so it reads the list fresh.
      const subs = await client.fetchQuery({
        queryKey: SUBSCRIPTIONS_KEY,
        queryFn: ({ signal }) => fetchSubscriptions(signal),
        staleTime: 0,
      });
      const have = new Set(subs.map((s) => s.feedUrl));
      const toImport = parsed.entries.filter((en) => !have.has(en.xmlUrl));
      setStage({
        kind: 'preview',
        plan: {
          entries: parsed.entries,
          toImport,
          total: parsed.entries.length + parsed.invalid.length,
          folderCount: parsed.folderCount,
          alreadySubscribed: parsed.entries.length - toImport.length,
          invalid: parsed.invalid.length,
          multiFolder: parsed.multiFolder,
          baseline: new Set(subs.map((s) => s.id)),
        },
      });
    } catch (err) {
      if (err instanceof OpmlError || err instanceof DOMException) error(COPY.notOpml);
      else error(failureText(err));
    } finally {
      busy.current = false;
      setReading(false);
    }
  }

  /** Sends the requests one after another, from `from`. Safe to resume: the API is idempotent. */
  async function send(plan: Plan, chunks: ImportOpmlRequest[], from: number, start: Totals) {
    if (busy.current) return;
    busy.current = true;
    setBanner(null);
    abort.current = new AbortController();
    let totals = start;
    setStage({ kind: 'sending', plan, chunks, next: from, totals, failed: false });
    try {
      for (let i = from; i < chunks.length; i += 1) {
        const res = await apiPost<ImportOpmlResponse>('/api/import/opml', chunks[i], {
          signal: abort.current.signal,
          timeoutMs: 30_000,
        });
        totals = {
          created: totals.created + res.created,
          deferred: totals.deferred + res.deferred,
          skipped: totals.skipped + res.invalid.length,
        };
        setStage({ kind: 'sending', plan, chunks, next: i + 1, totals, failed: false });
      }
      for (const queryKey of [FOLDERS_KEY, SUBSCRIPTIONS_KEY, COUNTS_KEY]) {
        void client.invalidateQueries({ queryKey });
      }
      setStage({ kind: 'progress', plan, totals });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      error(failureText(err));
      setStage((s) => (s.kind === 'sending' ? { ...s, totals, failed: true } : s));
    } finally {
      busy.current = false;
    }
  }

  if (stage.kind === 'choose') {
    return (
      <div>
        <BannerSlot banner={banner} />
        <h2
          ref={heading}
          tabIndex={-1}
          className="text-lg font-semibold text-fg focus:outline-none"
        >
          Choose your file
        </h2>
        <p className="mt-2 text-base text-fg-muted">{COPY.instructions}</p>
        <label
          className={`mt-6 flex min-h-12 w-full cursor-pointer items-center justify-center rounded-md bg-accent px-4 text-base font-medium text-accent-fg focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 ${
            reading ? 'opacity-60' : ''
          }`}
        >
          {reading ? 'Reading file...' : banner ? 'Choose another file' : 'Choose OPML file'}
          <input
            type="file"
            accept=".opml,.xml,text/xml,application/xml,text/x-opml"
            className="sr-only"
            disabled={reading}
            onChange={(e) => void onFile(e)}
          />
        </label>
      </div>
    );
  }

  if (stage.kind === 'preview') {
    const { plan } = stage;
    const n = plan.toImport.length;
    return (
      <div>
        <BannerSlot banner={banner} />
        <h2
          ref={heading}
          tabIndex={-1}
          className="text-lg font-semibold text-fg focus:outline-none"
        >
          Found {plural(plan.total, 'feed')} in {plural(plan.folderCount, 'folder')}
        </h2>
        <ul className="mt-3 space-y-1 text-base text-fg">
          <li>{plan.alreadySubscribed.toLocaleString('en-US')} already subscribed</li>
          <li>{plan.invalid.toLocaleString('en-US')} invalid</li>
          {plan.multiFolder > 0 && (
            <li>
              {plural(plan.multiFolder, 'feed')} in more than one folder. Each goes in the first
              folder it appears in.
            </li>
          )}
        </ul>
        {n === 0 && <p className="mt-3 text-base text-fg-muted">{COPY.nothingNew}</p>}
        <button
          type="button"
          onClick={() => {
            setBanner(null);
            setStage({ kind: 'choose' });
          }}
          className={`${SECONDARY} mt-6`}
        >
          Choose another file
        </button>
        <BottomBar>
          <div className="flex w-full flex-col py-2">
            <PrimaryButton
              type="button"
              blocked={!online || n === 0}
              aria-describedby={online ? undefined : 'import-offline'}
              onClick={() =>
                void send(plan, chunkEntries(plan.toImport), 0, {
                  created: 0,
                  deferred: 0,
                  skipped: plan.invalid,
                })
              }
            >
              {`Import ${plural(n, 'feed')}`}
            </PrimaryButton>
            {!online && (
              <p
                id="import-offline"
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

  if (stage.kind === 'sending') {
    const sent = stage.chunks
      .slice(0, stage.next)
      .reduce((n, c) => n + c.feeds.length + c.folders.reduce((m, f) => m + f.feeds.length, 0), 0);
    const total = stage.plan.toImport.length;
    return (
      <div>
        <BannerSlot banner={banner} />
        <h2
          ref={heading}
          tabIndex={-1}
          className="text-lg font-semibold text-fg focus:outline-none"
        >
          {stage.failed ? 'Import paused' : 'Importing your feeds'}
        </h2>
        <p role="status" className="mt-2 text-base text-fg">
          Sent {sent.toLocaleString('en-US')} of {total.toLocaleString('en-US')} feeds
        </p>
        <Bar value={sent} max={total} label="Import progress" />
        {stage.failed && (
          <div className="mt-6 flex flex-col gap-3">
            <PrimaryButton
              type="button"
              blocked={!online}
              onClick={() => void send(stage.plan, stage.chunks, stage.next, stage.totals)}
            >
              Try again
            </PrimaryButton>
            <Link to="/manage" className={SECONDARY}>
              Leave
            </Link>
          </div>
        )}
      </div>
    );
  }

  return <Progress plan={stage.plan} totals={stage.totals} heading={heading} />;
}

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max === 0 ? 100 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      className="mt-3 h-2 w-full overflow-hidden rounded-full bg-sunken"
    >
      <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** FR-OP-3: "Fetched X of N feeds", polled every 5 s until none of the new feeds is pending. */
function Progress({
  plan,
  totals,
  heading,
}: {
  plan: Plan;
  totals: Totals;
  heading: React.RefObject<HTMLHeadingElement | null>;
}) {
  const client = useQueryClient();
  const [stop, setStop] = useState(false);
  const subs = useSubscriptions(true, stop ? false : POLL_MS);

  // Feeds deferred to tomorrow stay pending, so they are not part of "N".
  const target = Math.max(0, totals.created - totals.deferred);
  const mine = useMemo(
    () => (subs.data ?? []).filter((s) => !plan.baseline.has(s.id)),
    [subs.data, plan.baseline],
  );
  const fetched = Math.min(target, mine.filter((s) => s.health.state !== 'pending').length);
  const failed = mine.filter((s) => ['failing', 'dead', 'gone'].includes(s.health.state)).length;
  const anyArticles = mine.some((s) => s.health.lastSuccessAt !== null);
  const done = fetched >= target;

  useEffect(() => {
    if (done && !stop) {
      setStop(true);
      void client.invalidateQueries({ queryKey: COUNTS_KEY });
    }
  }, [done, stop, client]);

  return (
    <div>
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold text-fg focus:outline-none">
        {done ? 'Import complete' : 'Fetching your feeds'}
      </h2>
      <p role="status" className="mt-2 text-base text-fg">
        Fetched {fetched.toLocaleString('en-US')} of {target.toLocaleString('en-US')} feeds
      </p>
      <Bar value={fetched} max={target} label="Fetch progress" />
      <ul className="mt-4 space-y-1 text-base text-fg">
        <li>{plural(totals.created, 'feed')} added</li>
        {plan.alreadySubscribed > 0 && (
          <li>{plan.alreadySubscribed.toLocaleString('en-US')} were already subscribed</li>
        )}
        {totals.skipped > 0 && <li>{plural(totals.skipped, 'feed')} could not be imported</li>}
        {totals.deferred > 0 && (
          <li>
            {plural(totals.deferred, 'feed')} will start fetching tomorrow, to stay within the daily
            limit.
          </li>
        )}
        {failed > 0 && done && (
          <li>
            {plural(failed, 'feed')} couldn&apos;t be fetched.{' '}
            <Link
              to="/manage"
              className="inline-block -my-3 py-3 text-accent underline underline-offset-2"
            >
              See which
            </Link>
          </li>
        )}
      </ul>
      <div className="mt-6 flex flex-col gap-3">
        {anyArticles ? (
          <Link to="/all" className={LINK_BUTTON}>
            Start reading
          </Link>
        ) : (
          <p className="text-sm text-fg-muted">
            You can leave this page. Fetching carries on in the background.
          </p>
        )}
        {anyArticles && !done && (
          <p className="text-sm text-fg-muted">The rest keep fetching in the background.</p>
        )}
      </div>
    </div>
  );
}
