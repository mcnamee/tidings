import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  Folder as FolderIcon,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import {
  FOLDER_NAME_MAX,
  SUBSCRIPTION_TITLE_MAX,
  type Folder,
  type Subscription,
} from '@tidings/shared';
import { PrimaryButton, TextField } from '../auth/ui';
import { HeaderActions } from '../shell/slots';
import { useManageActions } from './actions';
import { groupByFolder, sortedFolders, useFolders, useSubscriptions } from './data';
import { SHEET_BUTTON, SHEET_DANGER, Sheet } from './Sheet';

/**
 * Manage (docs/ux/FLOWS.md 2.4): folders and feeds with health, and the actions on them. Every
 * action is a labelled button or a sheet; nothing here is colour-only or hover-only.
 */

type Modal =
  | { kind: 'newFolder' }
  | { kind: 'renameFolder'; folder: Folder }
  | { kind: 'deleteFolder'; folder: Folder }
  | { kind: 'feed'; sub: Subscription }
  | { kind: 'renameFeed'; sub: Subscription }
  | { kind: 'move'; sub: Subscription }
  | { kind: 'unsubscribe'; sub: Subscription };

const ICON_BUTTON =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-md text-fg active:bg-sunken';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function healthNote(s: Subscription): string | null {
  const { state, errorMessage, warning } = s.health;
  if (state === 'dead') return errorMessage ?? 'This feed has stopped updating.';
  if (state === 'gone') return errorMessage ?? 'This feed no longer exists.';
  if (state === 'failing') return errorMessage ?? "Couldn't fetch this feed.";
  return warning;
}

export function Manage() {
  const folders = useFolders();
  const subs = useSubscriptions();
  const actions = useManageActions();
  const [modal, setModal] = useState<Modal | null>(null);
  const close = () => setModal(null);

  const folderList = sortedFolders(folders.data);
  const groups = groupByFolder(subs.data);
  const folderName = new Map(folderList.map((f) => [f.id, f.name]));
  const feeds = [...groups.values()]
    .flat()
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

  if (folders.isPending || subs.isPending) {
    return (
      <p role="status" className="text-base text-fg-muted">
        Loading
      </p>
    );
  }
  if (folders.isError || subs.isError) {
    return (
      <div role="alert" className="rounded-md bg-danger-subtle p-3 text-danger-subtle-fg">
        <p className="text-base">Couldn&apos;t load your feeds. Check your connection.</p>
        <button
          type="button"
          onClick={() => {
            void folders.refetch();
            void subs.refetch();
          }}
          className="mt-2 inline-flex min-h-11 items-center font-medium underline"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div>
      <HeaderActions>
        <button
          type="button"
          onClick={() => setModal({ kind: 'newFolder' })}
          className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-base font-medium text-fg active:bg-sunken"
        >
          <FolderPlus aria-hidden="true" className="size-5" strokeWidth={1.75} />
          New folder
        </button>
      </HeaderActions>

      <Link
        to="/manage/add"
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-base font-medium text-accent-fg"
      >
        <Plus aria-hidden="true" className="size-5" strokeWidth={1.75} />
        Add feed
      </Link>
      <Link
        to="/manage/import"
        className="mt-2 flex min-h-12 w-full items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg"
      >
        Import from OPML
      </Link>

      <section aria-labelledby="folders-h" className="mt-6">
        <h2 id="folders-h" className="text-lg font-semibold text-fg">
          Folders
        </h2>
        {folderList.length === 0 ? (
          <p className="mt-1 text-base text-fg-muted">
            No folders yet. Use New folder to group your feeds.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-md border border-line bg-surface">
            {folderList.map((f) => (
              <li key={f.id} className="flex items-center gap-1 pl-3">
                <FolderIcon
                  aria-hidden="true"
                  className="size-5 shrink-0 text-fg-muted"
                  strokeWidth={1.75}
                />
                <div className="min-w-0 flex-1 py-2 pl-2">
                  <p className="truncate text-base font-medium text-fg">{f.name}</p>
                  <p className="text-sm text-fg-muted">
                    {plural((groups.get(f.id) ?? []).length, 'feed', 'feeds')}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`Rename ${f.name}`}
                  onClick={() => setModal({ kind: 'renameFolder', folder: f })}
                  className={ICON_BUTTON}
                >
                  <Pencil aria-hidden="true" className="size-5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${f.name}`}
                  onClick={() => setModal({ kind: 'deleteFolder', folder: f })}
                  className={ICON_BUTTON}
                >
                  <Trash2 aria-hidden="true" className="size-5" strokeWidth={1.75} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="feeds-h" className="mt-6">
        <h2 id="feeds-h" className="text-lg font-semibold text-fg">
          Feeds
        </h2>
        {feeds.length === 0 ? (
          <p className="mt-1 text-base text-fg-muted">You aren&apos;t following any feeds yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-md border border-line bg-surface">
            {feeds.map((s) => {
              const note = healthNote(s);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-label={`${s.title}, options`}
                    onClick={() => setModal({ kind: 'feed', sub: s })}
                    className="flex min-h-14 w-full flex-col items-start justify-center px-3 py-2 text-left active:bg-sunken"
                  >
                    <span className="w-full truncate text-base font-medium text-fg">{s.title}</span>
                    <span className="w-full truncate text-sm text-fg-muted">
                      {s.folderId ? (folderName.get(s.folderId) ?? 'No folder') : 'No folder'}
                    </span>
                    {note && (
                      <span className="mt-0.5 flex w-full items-start gap-1.5 text-sm text-warning-subtle-fg">
                        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                        <span>{note}</span>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {(modal?.kind === 'newFolder' || modal?.kind === 'renameFolder') && (
        <NameSheet
          title={modal.kind === 'newFolder' ? 'New folder' : 'Rename folder'}
          label="Folder name"
          helper={`1 to ${FOLDER_NAME_MAX} characters.`}
          initial={modal.kind === 'renameFolder' ? modal.folder.name : ''}
          max={FOLDER_NAME_MAX}
          required
          submitLabel={modal.kind === 'newFolder' ? 'Create folder' : 'Save'}
          onClose={close}
          onSubmit={(name) =>
            modal.kind === 'newFolder'
              ? actions.createFolder(name)
              : actions.renameFolder(modal.folder, name)
          }
        />
      )}

      {modal?.kind === 'renameFeed' && (
        <NameSheet
          title="Rename feed"
          label="Feed name"
          helper="Leave empty to use the feed's own title."
          initial={modal.sub.customTitle ?? ''}
          max={SUBSCRIPTION_TITLE_MAX}
          submitLabel="Save"
          onClose={close}
          onSubmit={(name) => actions.renameSubscription(modal.sub, name === '' ? null : name)}
        />
      )}

      {modal?.kind === 'feed' && (
        <Sheet title={modal.sub.title} onClose={close}>
          <div className="mt-4 flex flex-col gap-3">
            <button
              type="button"
              className={SHEET_BUTTON}
              onClick={() => setModal({ kind: 'renameFeed', sub: modal.sub })}
            >
              Rename
            </button>
            <button
              type="button"
              className={SHEET_BUTTON}
              onClick={() => setModal({ kind: 'move', sub: modal.sub })}
            >
              Move to folder
            </button>
            <button
              type="button"
              className={SHEET_BUTTON}
              onClick={() => setModal({ kind: 'unsubscribe', sub: modal.sub })}
            >
              Unsubscribe
            </button>
            <button type="button" className={SHEET_BUTTON} onClick={close}>
              Cancel
            </button>
          </div>
        </Sheet>
      )}

      {modal?.kind === 'move' && (
        <Sheet title="Move to folder" onClose={close}>
          <ul className="mt-4 flex flex-col gap-2">
            {[{ id: null, name: 'No folder' }, ...folderList].map((f) => {
              const current = (modal.sub.folderId ?? null) === f.id;
              return (
                <li key={f.id ?? 'none'}>
                  <button
                    type="button"
                    aria-pressed={current}
                    onClick={() => {
                      close();
                      if (!current) void actions.moveSubscription(modal.sub, f.id);
                    }}
                    className={`${SHEET_BUTTON} justify-between ${current ? 'border-2 border-accent' : ''}`}
                  >
                    <span className="truncate">{f.name}</span>
                    {current && <span className="text-sm text-fg-muted">Current</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" className={`${SHEET_BUTTON} mt-3`} onClick={close}>
            Cancel
          </button>
        </Sheet>
      )}

      {modal?.kind === 'deleteFolder' && (
        <Sheet title={`Delete ${modal.folder.name}?`} onClose={close}>
          <p className="mt-2 text-base text-fg">
            {(groups.get(modal.folder.id) ?? []).length === 0
              ? 'It has no feeds.'
              : `Its ${plural((groups.get(modal.folder.id) ?? []).length, 'feed', 'feeds')} move${
                  (groups.get(modal.folder.id) ?? []).length === 1 ? 's' : ''
                } out of the folder. Nothing is unsubscribed.`}
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <button
              type="button"
              className={SHEET_DANGER}
              onClick={() => {
                close();
                void actions.deleteFolder(modal.folder);
              }}
            >
              Delete folder
            </button>
            <button type="button" className={SHEET_BUTTON} onClick={close}>
              Cancel
            </button>
          </div>
        </Sheet>
      )}

      {modal?.kind === 'unsubscribe' && (
        <Sheet title={`Unsubscribe from ${modal.sub.title}?`} onClose={close}>
          <p className="mt-2 text-base text-fg">Your read history for this feed will be removed.</p>
          <div className="mt-4 flex flex-col gap-3">
            <button
              type="button"
              className={SHEET_DANGER}
              onClick={() => {
                close();
                void actions.unsubscribe(modal.sub);
              }}
            >
              Unsubscribe
            </button>
            <button type="button" className={SHEET_BUTTON} onClick={close}>
              Cancel
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** A one-field sheet. The server's answer can be an inline error, so it waits for it. */
function NameSheet({
  title,
  label,
  helper,
  initial,
  max,
  required = false,
  submitLabel,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  helper: string;
  initial: string;
  max: number;
  required?: boolean;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const name = value.trim();
    if (required && name === '') {
      setError('Enter a name to continue.');
      return;
    }
    if (name.length > max) {
      setError(`Use ${max} characters or fewer.`);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await onSubmit(name);
    if (result.ok) {
      onClose();
      return;
    }
    setBusy(false);
    setError(result.message);
  }

  return (
    <Sheet title={title} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate className="mt-4">
        <TextField
          label={label}
          helper={helper}
          error={error}
          inputProps={{
            type: 'text',
            value,
            readOnly: busy,
            autoComplete: 'off',
            onChange: (e) => setValue(e.target.value),
          }}
        />
        <p role="alert" className="sr-only">
          {error}
        </p>
        <div className="flex flex-col gap-3">
          <PrimaryButton busy={busy}>{busy ? 'Saving...' : submitLabel}</PrimaryButton>
          <button type="button" className={SHEET_BUTTON} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}
