import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader } from 'lucide-react';
import type { Passkey, PasskeysResponse } from '@tidings/shared';
import { PASSKEY_NAME_MAX } from '@tidings/shared';
import { ApiRequestError, NetworkError, apiDelete, apiGet, apiPatch } from '../api';
import { detectPasskeySupport } from '../auth/helpers';
import { addPasskey } from '../auth/passkeyFlows';
import { useOnline } from '../lib/hooks';
import { toast } from '../lib/toast';
import { SHEET_BUTTON, SHEET_DANGER, Sheet } from '../manage/Sheet';
import { useReauth } from './useReauth';

/** FR-AU-6, TID-022 AC3: list, rename, remove and add passkeys. */

export const PASSKEYS_KEY = ['passkeys'] as const;

const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg';

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

const LAST_PASSKEY =
  "You can't remove your only passkey. Add another one first, so you can still sign in.";

function failure(err: unknown): string {
  if (err instanceof ApiRequestError && err.code === 'last_passkey') return LAST_PASSKEY;
  if (err instanceof ApiRequestError && err.status === 404) return 'That passkey is already gone.';
  if (err instanceof NetworkError) {
    return "Couldn't reach Tidings. Check your connection and try again.";
  }
  return 'Something went wrong on our side. Try again.';
}

type Modal = { kind: 'rename'; passkey: Passkey } | { kind: 'remove'; passkey: Passkey };

export function PasskeysSection() {
  const client = useQueryClient();
  const online = useOnline();
  const reauth = useReauth();
  const list = useQuery({
    queryKey: PASSKEYS_KEY,
    queryFn: ({ signal }) => apiGet<PasskeysResponse>('/api/auth/passkeys', { signal }),
    staleTime: 0,
  });
  const [modal, setModal] = useState<Modal | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const support = detectPasskeySupport();
  const items = list.data?.items ?? [];
  const refresh = () => client.invalidateQueries({ queryKey: PASSKEYS_KEY });

  async function onAdd() {
    if (adding || !online) return;
    setAdding(true);
    setAddError(null);
    let result = await addPasskey();
    if (!result.ok && result.reauth) {
      const problem = await reauth();
      if (problem) {
        setAddError(problem);
        setAdding(false);
        return;
      }
      result = await addPasskey();
    }
    setAdding(false);
    if (!result.ok) {
      setAddError(result.message);
      return;
    }
    await refresh();
    toast.success('Passkey added.');
  }

  return (
    <section aria-labelledby="passkeys-h2" id="passkeys" className="mt-8">
      <h2 id="passkeys-h2" className="text-lg font-semibold text-fg">
        Passkeys
      </h2>
      <p className="mt-1 text-sm text-fg-muted">
        Passkeys are how you sign in. Keep one on each device you use.
      </p>

      {list.isPending && <p className="mt-3 text-base text-fg-muted">Loading passkeys...</p>}
      {list.isError && (
        <div
          role="alert"
          className="mt-3 rounded-md bg-danger-subtle p-3 text-sm text-danger-subtle-fg"
        >
          <p>Couldn&apos;t load your passkeys.</p>
          <button type="button" onClick={() => void list.refetch()} className={`${BUTTON} mt-2`}>
            Try again
          </button>
        </div>
      )}

      {items.length > 0 && (
        <ul className="mt-3 divide-y divide-line rounded-md border border-line bg-surface">
          {items.map((p) => (
            <li key={p.id} data-testid="passkey-row" className="p-3">
              <div className="flex items-start gap-3">
                <KeyRound aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-base font-medium text-fg">{p.name}</p>
                  <p className="text-sm text-fg-muted">
                    Added {date(p.createdAt)}
                    {' · '}
                    {p.lastUsedAt === null ? 'Never used' : `Last used ${date(p.lastUsedAt)}`}
                  </p>
                </div>
              </div>
              <div className="mt-2 flex gap-2 pl-8">
                <button
                  type="button"
                  aria-label={`Rename ${p.name}`}
                  onClick={() => setModal({ kind: 'rename', passkey: p })}
                  className={BUTTON}
                >
                  Rename
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${p.name}`}
                  onClick={() => setModal({ kind: 'remove', passkey: p })}
                  className={BUTTON}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {items.length === 1 && (
        <p className="mt-2 text-sm text-fg-muted">
          This is your only passkey, so it can&apos;t be removed. Add another to change that.
        </p>
      )}

      {support === 'ok' ? (
        <button
          type="button"
          onClick={() => void onAdd()}
          aria-disabled={adding || !online ? true : undefined}
          aria-busy={adding ? true : undefined}
          className={`${BUTTON} mt-3 w-full md:w-auto`}
        >
          {adding && <Loader aria-hidden="true" className="size-5 motion-safe:animate-spin" />}
          {adding ? 'Adding passkey...' : 'Add a passkey'}
        </button>
      ) : (
        <p className="mt-3 text-sm text-fg-muted">
          This browser can&apos;t add passkeys. Open Tidings on a device that supports them.
        </p>
      )}
      <p role="alert" className="mt-2 text-sm font-medium text-danger">
        {addError}
      </p>

      {modal?.kind === 'rename' && (
        <RenameSheet
          passkey={modal.passkey}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            void refresh();
          }}
        />
      )}
      {modal?.kind === 'remove' && (
        <RemoveSheet
          passkey={modal.passkey}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            void refresh();
            toast.success('Passkey removed.');
          }}
        />
      )}
    </section>
  );
}

function RenameSheet({
  passkey,
  onClose,
  onDone,
}: {
  passkey: Passkey;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(passkey.name);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (n: string) =>
      apiPatch<Passkey>(`/api/auth/passkeys/${encodeURIComponent(passkey.id)}`, { name: n }),
    onSuccess: onDone,
    onError: (err) => setError(failure(err)),
  });
  const trimmed = name.trim();
  return (
    <Sheet title="Rename passkey" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed === '') {
            setError('Give it a name.');
            return;
          }
          if (!save.isPending) save.mutate(trimmed);
        }}
        className="mt-3"
      >
        <label htmlFor="passkey-name" className="mb-1 block text-base font-medium text-fg">
          Name
        </label>
        <input
          id="passkey-name"
          value={name}
          maxLength={PASSKEY_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          className="block min-h-12 w-full rounded-md border border-line-strong bg-sunken px-3 text-base text-fg"
        />
        <p role="alert" className="mt-2 min-h-5 text-sm text-danger">
          {error}
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <button
            type="submit"
            aria-disabled={save.isPending ? true : undefined}
            className="flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-4 text-base font-medium text-accent-fg"
          >
            {save.isPending ? 'Saving...' : 'Save'}
          </button>
          <button type="button" onClick={onClose} className={SHEET_BUTTON}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function RemoveSheet({
  passkey,
  onClose,
  onDone,
}: {
  passkey: Passkey;
  onClose: () => void;
  onDone: () => void;
}) {
  const reauth = useReauth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const path = `/api/auth/passkeys/${encodeURIComponent(passkey.id)}`;
    try {
      try {
        await apiDelete(path);
      } catch (err) {
        if (!(err instanceof ApiRequestError && err.code === 'reauth_required')) throw err;
        const problem = await reauth();
        if (problem) {
          setError(problem);
          return;
        }
        await apiDelete(path);
      }
      onDone();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Remove this passkey?" onClose={onClose}>
      <p className="mt-2 text-base text-fg-muted">
        &ldquo;{passkey.name}&rdquo; will no longer sign you in. Devices that use it will need
        another passkey or a recovery code.
      </p>
      <p role="alert" className="mt-2 min-h-5 text-sm font-medium text-danger">
        {error}
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void remove()}
          aria-disabled={busy ? true : undefined}
          className={SHEET_DANGER}
        >
          {busy ? 'Removing...' : 'Remove passkey'}
        </button>
        <button type="button" data-autofocus onClick={onClose} className={SHEET_BUTTON}>
          {error ? 'Close' : 'Cancel'}
        </button>
      </div>
    </Sheet>
  );
}
