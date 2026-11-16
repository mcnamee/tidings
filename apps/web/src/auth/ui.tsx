import { forwardRef, useId, type ComponentPropsWithoutRef, type ReactNode, type Ref } from 'react';
import { CircleAlert, Info, Loader, TriangleAlert, WifiOff } from 'lucide-react';

/** Shared auth controls (docs/ux/screens/auth-common.md section 2). Colours are tokens only. */

export type BannerTone = 'error' | 'warning' | 'info';

export interface BannerContent {
  tone: BannerTone;
  /** `alert` for errors and the rate limit, `status` for info and offline (auth-common 2.4). */
  live: 'alert' | 'status';
  icon?: 'alert' | 'warning' | 'offline' | 'info';
  title?: string;
  text: string;
}

const TONE: Record<BannerTone, string> = {
  error: 'bg-danger-subtle text-danger-subtle-fg',
  warning: 'bg-warning-subtle text-warning-subtle-fg',
  info: 'bg-sunken text-fg border border-line',
};

function BannerIcon({ icon }: { icon: NonNullable<BannerContent['icon']> }) {
  const cls = 'mt-0.5 size-5 shrink-0';
  if (icon === 'warning') return <TriangleAlert className={cls} aria-hidden="true" />;
  if (icon === 'offline') return <WifiOff className={cls} aria-hidden="true" />;
  if (icon === 'info') return <Info className={cls} aria-hidden="true" />;
  return <CircleAlert className={cls} aria-hidden="true" />;
}

/**
 * One banner at a time. Both live regions are in the DOM from first render (empty) so screen
 * readers announce the first message; only the one matching the banner has content.
 */
export function BannerSlot({ banner }: { banner: BannerContent | null }) {
  const render = (live: 'alert' | 'status') => {
    const b = banner && banner.live === live ? banner : null;
    return (
      <div role={live}>
        {b && (
          <div className={`mb-4 flex gap-3 rounded-md p-3 text-sm ${TONE[b.tone]}`}>
            <BannerIcon icon={b.icon ?? (b.tone === 'info' ? 'info' : 'alert')} />
            <p>
              {b.title && <strong className="font-semibold">{b.title} </strong>}
              {b.text}
            </p>
          </div>
        )}
      </div>
    );
  };
  return (
    <>
      {render('alert')}
      {render('status')}
    </>
  );
}

export function Spinner() {
  // Static under prefers-reduced-motion (auth-common 2.3).
  return <Loader className="size-5 motion-safe:animate-spin" aria-hidden="true" />;
}

interface PrimaryButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, 'disabled'> {
  /** Rendered as aria-disabled, never `disabled`, so the button stays focusable (auth-common 2.1). */
  blocked?: boolean;
  busy?: boolean;
  /** Called when the button is pressed while `blocked`, so the press is not silent. */
  onBlockedPress?: () => void;
  children: ReactNode;
}

export const PrimaryButton = forwardRef(function PrimaryButton(
  { blocked, busy, onBlockedPress, children, onClick, className = '', ...rest }: PrimaryButtonProps,
  ref: Ref<HTMLButtonElement>,
) {
  return (
    <button
      ref={ref}
      type="submit"
      aria-disabled={blocked || busy ? true : undefined}
      aria-busy={busy ? true : undefined}
      onClick={(e) => {
        if (blocked || busy) {
          e.preventDefault();
          if (blocked) onBlockedPress?.();
          return;
        }
        onClick?.(e);
      }}
      className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-base font-medium text-accent-fg ${
        blocked || busy ? 'cursor-not-allowed opacity-60' : ''
      } ${className}`}
      {...rest}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
});

interface TextFieldProps {
  label: string;
  helper: string;
  error?: string | null;
  inputProps: ComponentPropsWithoutRef<'input'>;
  inputRef?: Ref<HTMLInputElement>;
  /** Content inside the right edge of the field (Show/Hide). */
  trailing?: ReactNode;
}

/** auth-common 2.2: real label, helper replaced by an error with icon and words (never colour only). */
export function TextField({
  label,
  helper,
  error,
  inputProps,
  inputRef,
  trailing,
}: TextFieldProps) {
  const id = useId();
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block text-base font-medium text-fg">
        {label}
      </label>
      <div className="relative">
        <input
          {...inputProps}
          id={id}
          ref={inputRef}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${helperId} ${errorId}` : helperId}
          className={`block min-h-12 w-full rounded-md bg-sunken px-3 text-base text-fg read-only:opacity-80 ${
            error ? 'border-2 border-danger' : 'border border-line-strong'
          } ${trailing ? 'pr-14' : ''}`}
        />
        {trailing && <div className="absolute inset-y-0 right-0 flex items-center">{trailing}</div>}
      </div>
      <p id={helperId} className={`mt-1 text-sm text-fg-muted ${error ? 'sr-only' : ''}`}>
        {helper}
      </p>
      <p id={errorId} className="mt-1 flex gap-1.5 text-sm text-danger">
        {error && (
          <>
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </>
        )}
      </p>
    </div>
  );
}
