/**
 * The Tidings mark and lockup (docs/ux/brand.md). The paths are the same as public/logo.svg; keep them equal
 * (icons.test.ts checks). The mark follows the colour it is given (currentColor).
 */
export function LogoMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg
      viewBox="4 4 56 56"
      fill="currentColor"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <polygon
        points="10.37,16.18 27.31,11.84 30.53,18.14 55.31,11.14 54.89,18.7 34.45,25.14 26.19,52.3 24.65,52.86 17.79,46.98 24.51,23.6 8.69,23.04"
        strokeWidth="7.0"
        strokeLinejoin="round"
      />
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
