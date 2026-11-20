import { useState } from 'react';

/**
 * Spot illustrations for the "All caught up" and "no articles" states (TID-073, brand.md section 8).
 * Each has a light and a dark PNG in `public/caught-up/`; the file stem is the name here.
 */
export const CAUGHT_UP_ART = [
  'clap',
  'cat',
  'trophy',
  'ok',
  'coffee',
  'plane',
  'sun',
  'popper',
  'thumbs',
  'dog',
  'medal',
  'plant',
] as const;

export const caughtUpSrc = (name: string, theme: 'light' | 'dark') =>
  `/caught-up/${name}-${theme}.png`;

let last = -1;

/** One at random, never the same twice in a row. */
function pick(): string {
  let i = Math.floor(Math.random() * CAUGHT_UP_ART.length);
  if (i === last) i = (i + 1) % CAUGHT_UP_ART.length;
  last = i;
  return CAUGHT_UP_ART[i]!;
}

/**
 * Decorative (alt=""), lazy, about 176px. The picture is chosen once when the state appears and
 * stays while it is mounted. The theme is the `dark:` variant (the `data-theme` attribute on
 * `<html>`), so the system, light and dark settings all work; the hidden image is never fetched
 * (lazy images that are `display: none` do not load).
 */
export function CaughtUpArt() {
  const [name] = useState(pick);
  return (
    <div data-testid="caught-up-art" data-art={name} className="mx-auto mb-2 size-44">
      <img
        src={caughtUpSrc(name, 'light')}
        alt=""
        width={176}
        height={176}
        loading="lazy"
        decoding="async"
        className="size-44 object-contain dark:hidden"
      />
      <img
        src={caughtUpSrc(name, 'dark')}
        alt=""
        width={176}
        height={176}
        loading="lazy"
        decoding="async"
        className="hidden size-44 object-contain dark:block"
      />
    </div>
  );
}
