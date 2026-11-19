import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DISPLAY_NAME_MAX, TEXT_SIZES, THEMES, type UserSettings } from '@tidings/shared';
import { fetchHealth } from '../api';
import { useSession } from '../lib/session';
import {
  hideReadFeeds,
  markReadOnOpen,
  listSortPref,
  markReadOnScroll,
  textSizePref,
  themePref,
  unreadOnlyDefault,
  type TextSize,
  type ThemePref,
} from '../lib/settings';
import { signOut } from '../lib/signOut';
import { SHEET_BUTTON, SHEET_DANGER, Sheet } from '../manage/Sheet';
import { PasskeysSection } from './PasskeysSection';
import { RecoveryCodesSection } from './RecoveryCodesSection';
import { useRenameAccount, useUpdateSettings } from './useUpdateSettings';

/**
 * Settings (TID-022, FR-ST-1 to FR-ST-4). Every control saves as soon as it changes: the setting
 * shows at once and `PATCH /api/me` stores it (see useUpdateSettings). Sections are plain
 * headings and labelled controls, so nothing here relies on colour or hover.
 */

const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg';

const THEME_LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const SIZE_LABEL: Record<TextSize, string> = { s: 'Small', m: 'Medium', l: 'Large' };

function Choice<T extends string>({
  legend,
  hint,
  name,
  value,
  options,
  labels,
  onChange,
}: {
  legend: string;
  hint: string;
  name: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="mt-4">
      <legend className="text-base font-medium text-fg">{legend}</legend>
      <p className="text-sm text-fg-muted">{hint}</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {options.map((o) => (
          <label key={o} className="relative block">
            <input
              type="radio"
              name={name}
              value={o}
              checked={value === o}
              onChange={() => onChange(o)}
              className="peer absolute inset-0 size-full cursor-pointer opacity-0"
            />
            <span className="flex min-h-11 items-center justify-center rounded-md border border-line-strong bg-surface px-2 text-base text-fg peer-checked:border-2 peer-checked:border-accent peer-checked:bg-accent-subtle peer-checked:font-semibold peer-checked:text-accent-subtle-fg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus">
              {labels[o]}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <li>
      <label className="flex min-h-14 cursor-pointer items-start gap-3 py-2">
        <span className="min-w-0 flex-1">
          <span id={`${id}-l`} className="block text-base text-fg">
            {label}
          </span>
          <span id={`${id}-h`} className="block text-sm text-fg-muted">
            {hint}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-labelledby={`${id}-l`}
          aria-describedby={`${id}-h`}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 size-6 shrink-0 accent-accent"
        />
      </label>
    </li>
  );
}

function AccountName({ current }: { current: string }) {
  const rename = useRenameAccount();
  const [name, setName] = useState(current);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => setName(current), [current]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (busy || trimmed === current) return;
    if (trimmed === '') {
      setMessage({ text: 'Enter a name.', error: true });
      return;
    }
    setBusy(true);
    const problem = await rename(trimmed);
    setBusy(false);
    setMessage(problem ? { text: problem, error: true } : { text: 'Name saved.', error: false });
  }

  return (
    <form onSubmit={(e) => void save(e)} className="mt-3">
      <label htmlFor={id} className="mb-1 block text-base font-medium text-fg">
        Your name
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          value={name}
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            setMessage(null);
          }}
          className="block min-h-12 min-w-0 flex-1 rounded-md border border-line-strong bg-sunken px-3 text-base text-fg"
        />
        <button
          type="submit"
          aria-disabled={busy || name.trim() === current ? true : undefined}
          className={BUTTON}
        >
          Save
        </button>
      </div>
      <p
        role={message?.error ? 'alert' : 'status'}
        className={`mt-1 min-h-5 text-sm ${message?.error ? 'text-danger' : 'text-fg-muted'}`}
      >
        {message?.text}
      </p>
    </form>
  );
}

function SignOutSection() {
  const client = useQueryClient();
  const [busy, setBusy] = useState<'one' | 'all' | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  async function run(everywhere: boolean) {
    if (busy) return;
    setBusy(everywhere ? 'all' : 'one');
    setFailed(false);
    const ok = await signOut(client, everywhere);
    if (!ok) {
      setFailed(true);
      setBusy(null);
      setConfirmAll(false);
    }
  }

  return (
    <section aria-labelledby="signout-h2" className="mt-8">
      <h2 id="signout-h2" className="text-lg font-semibold text-fg">
        Sign out
      </h2>
      <div role="alert" className="mt-2">
        {failed && (
          <p className="rounded-md bg-danger-subtle p-3 text-sm text-danger-subtle-fg">
            Couldn&apos;t sign out. Check your connection and try again.
          </p>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => void run(false)}
          aria-disabled={busy ? true : undefined}
          className={BUTTON}
        >
          {busy === 'one' ? 'Signing out...' : 'Sign out'}
        </button>
        <button
          type="button"
          onClick={() => setConfirmAll(true)}
          aria-disabled={busy ? true : undefined}
          className={BUTTON}
        >
          Sign out everywhere
        </button>
      </div>
      <p className="mt-2 text-sm text-fg-muted">
        &ldquo;Everywhere&rdquo; signs out this device and every other one that&apos;s signed in.
      </p>
      {confirmAll && (
        <Sheet title="Sign out everywhere?" onClose={() => setConfirmAll(false)}>
          <p className="mt-2 text-base text-fg-muted">
            Every device, including this one, will need to sign in again.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void run(true)}
              aria-disabled={busy ? true : undefined}
              className={SHEET_DANGER}
            >
              {busy === 'all' ? 'Signing out...' : 'Sign out everywhere'}
            </button>
            <button
              type="button"
              data-autofocus
              onClick={() => setConfirmAll(false)}
              className={SHEET_BUTTON}
            >
              Cancel
            </button>
          </div>
        </Sheet>
      )}
    </section>
  );
}

function Version() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => fetchHealth(),
    staleTime: Infinity,
    retry: false,
  });
  if (!health.data) return null;
  return (
    <p className="mt-8 text-center text-xs text-fg-muted" data-testid="app-version">
      Tidings {health.data.version}
    </p>
  );
}

/** TID-017 builds GET /api/export/opml; until then the Export link is hidden. */
const EXPORT_OPML_AVAILABLE = false;

export function Settings() {
  const session = useSession();
  const save = useUpdateSettings();
  // A controlled input snaps back to its old value if the state behind it doesn't change in the
  // same tick, and the query cache notifies a tick later. So a change is held here until the
  // save settles; the cache has the answer by then (the new value, or the rolled-back old one).
  const [pending, setPending] = useState<UserSettings>({});
  const user = session.data?.user;
  if (!user) return null;
  const s: UserSettings = { ...user.settings, ...pending };
  const update = (patch: UserSettings) => {
    setPending((p) => ({ ...p, ...patch }));
    return save(patch).finally(() =>
      setPending((p) => {
        const rest: Record<string, unknown> = { ...p };
        for (const key of Object.keys(patch)) delete rest[key];
        return rest as UserSettings;
      }),
    );
  };

  return (
    <div>
      <section aria-labelledby="appearance-h2">
        <h2 id="appearance-h2" className="text-lg font-semibold text-fg">
          Appearance
        </h2>
        <Choice
          legend="Theme"
          hint="System follows your device."
          name="theme"
          value={themePref(s)}
          options={THEMES}
          labels={THEME_LABEL}
          onChange={(theme) => void update({ theme })}
        />
        <Choice
          legend="Text size"
          hint="For article text."
          name="textSize"
          value={textSizePref(s)}
          options={TEXT_SIZES}
          labels={SIZE_LABEL}
          onChange={(textSize) => void update({ textSize })}
        />
      </section>

      <section aria-labelledby="reading-h2" className="mt-8">
        <h2 id="reading-h2" className="text-lg font-semibold text-fg">
          Reading
        </h2>
        <ul className="mt-1 divide-y divide-line">
          <Toggle
            label="Show unread only by default"
            hint="Lists open with read articles hidden."
            checked={unreadOnlyDefault(s)}
            onChange={(unreadOnly) => void update({ unreadOnly })}
          />
          <Toggle
            label="Sort unread lists by recommended"
            hint="Puts what you are most likely to want first, learned from the articles you open. Newest first until you have read enough."
            checked={listSortPref(s) === 'recommended'}
            onChange={(on) => void update({ listSort: on ? 'recommended' : 'newest' })}
          />
          <Toggle
            label="Mark as read when opened"
            hint="An article counts as read as soon as you open it."
            checked={markReadOnOpen(s)}
            onChange={(markReadOnOpen) => void update({ markReadOnOpen })}
          />
          <Toggle
            label="Mark as read when scrolled past"
            hint="Articles you scroll past in a list count as read."
            checked={markReadOnScroll(s)}
            onChange={(markReadOnScroll) => void update({ markReadOnScroll })}
          />
          <Toggle
            label="Hide feeds with no unread"
            hint="Applies in the feed list while it shows unread only."
            checked={hideReadFeeds(s)}
            onChange={(hideReadFeeds) => void update({ hideReadFeeds })}
          />
        </ul>
      </section>

      <section aria-labelledby="account-h2" className="mt-8">
        <h2 id="account-h2" className="text-lg font-semibold text-fg">
          Account
        </h2>
        <AccountName current={user.displayName} />
      </section>

      <PasskeysSection />
      <RecoveryCodesSection />
      <SignOutSection />

      <section aria-labelledby="data-h2" className="mt-8">
        <h2 id="data-h2" className="text-lg font-semibold text-fg">
          Data
        </h2>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Link to="/manage/import" className={BUTTON}>
            Import OPML
          </Link>
          {EXPORT_OPML_AVAILABLE && (
            <a href="/api/export/opml" download className={BUTTON}>
              Export OPML
            </a>
          )}
        </div>
        <p className="mt-2 text-sm text-fg-muted">
          Articles are kept for 30 days after you read them.
        </p>
      </section>

      <Version />
    </div>
  );
}
