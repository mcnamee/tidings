/**
 * The Tidings mark and lockup (docs/ux/brand.md). The paths are the same as public/logo.svg; keep them equal
 * (icons.test.ts checks). The mark follows the colour it is given (currentColor).
 */
export function LogoMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg
      viewBox="4 4 56 56"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <rect x="8" y="12" width="48" height="16" rx="8" transform="rotate(-12 32 20)" />
      <rect x="24" y="12" width="16" height="43" rx="8" transform="rotate(14 32 20)" />
    </svg>
  );
}

/** Mark in the accent colour plus the word "Tidings" in the text colour. Decorative mark, real text. */
export function Lockup({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span className="inline-flex items-center gap-2 text-fg">
      <LogoMark className={`${size === 'lg' ? 'size-9' : 'size-7'} shrink-0 text-accent`} />
      <span className={`${size === 'lg' ? 'text-2xl' : 'text-lg'} font-semibold tracking-tight`}>
        Tidings
      </span>
    </span>
  );
}
