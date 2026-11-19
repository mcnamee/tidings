# Tidings brand: mark, wordmark, icons, install

Story: TID-057 (owner request 2026-11-18), with TID-023 AC4 and AC6. Preview: `docs/ux/brand-preview.png`.

## 1. The mark

**Owner's design (2026-11-18).** The mark reproduces the owner's own "T" design (a slanted crossbar in two offset arms with a notch where they meet, a forward-leaning stem with a 45° chamfer at its foot, and generously rounded outer corners). It replaces the first draft, which the owner preferred less.

- Drawn as one polygon on the 56-unit viewBox `4 4 56 56` (centre 32, 32), filled and stroked in `currentColor` with `stroke-width` 7 and `stroke-linejoin: round`: the round stroke gives every outer corner the same radius (3.5 units) while inner corners stay crisp.
- The points live in `apps/web/public/logo.svg`; `apps/web/src/shell/Logo.tsx` must use the same points (`icons.test.ts` checks).
- The favicon and the PNG icons are generated from `logo.svg` (`scripts/render-icons.mjs`), so changing the points there and re-running the script updates everything.

## 2. Wordmark lockup

The mark plus the word "Tidings" in the UI sans (system stack, no web font), semibold, `tracking-tight`. The mark is `text-accent`, the word is `text-fg`; gap is 8 px.

| Size | Mark | Word | Where |
|---|---|---|---|
| md | 28 px (`size-7`) | `text-lg` (18) | Drawer header, desktop sidebar header |
| lg | 36 px (`size-9`) | `text-2xl` (24) | Sign-in, setup and recovery screens (above the card) |

The word is real text (the mark is `aria-hidden`), so screen readers hear "Tidings". The mobile app header keeps the screen title only: the title is the thing the thumb and eye need there, and the brand already sits one tap away in the drawer.

Contrast: accent on surface is 6.9:1 in light and 7.8:1 in dark (graphic needs 3:1); word text uses `text-fg`.

## 3. Colour in use

| Use | Light | Dark |
|---|---|---|
| Mark in app | `--c-accent` #2750c4 | `--c-accent` #8eaeff |
| Favicon background / mark | #2750c4 / #ffffff | #8eaeff / #0d1630 (`--c-accent` / `--c-accent-fg`) |
| App icons (PNG) background / mark | #2750c4 / #ffffff | same (a home screen icon cannot adapt) |

The icon background is the light `--c-accent`: it holds white at 6.9:1, stays recognisable on both light and dark wallpapers, and is the one brand colour the app already has.

## 4. Files and what uses them

| File | Size | Use |
|---|---|---|
| `favicon.svg` | vector | Browser tab. Rounded square, flips to the dark pair via `prefers-color-scheme` inside the SVG. |
| `icons/icon-192.png`, `icons/icon-512.png` | 192, 512 | Manifest, purpose `any`. Rounded square (22% radius), mark box 74% of the canvas. |
| `icons/icon-maskable-512.png` | 512 | Manifest, purpose `maskable`. Full bleed, mark box 64% of the canvas (inside the 80% safe zone). |
| `apple-touch-icon.png` | 180 | iOS Add to Home Screen. Full bleed (iOS rounds it), mark box 70%. |

Regenerate the PNGs and the preview: `CHROME_PATH=/usr/bin/google-chrome node scripts/render-icons.mjs --preview`. Change the colours or scale in that script only.

## 5. Installable, full-screen app

- `manifest.webmanifest`: `display: standalone`, `id`, `start_url` and `scope` all `/`; `theme_color` and `background_color` `#ffffff` (the light surface, TID-023 AC4; a dark-mode Android launch splash may flash light, accepted).
- `<meta name="theme-color">` is set by `theme-init.js` to the resolved theme's surface (#ffffff or #1b1c20) and follows theme changes.
- `viewport-fit=cover` is on. Safe-area insets are respected by the header (top, sides), bottom bar (bottom, sides), drawer (top, left; its footer takes the bottom), main content, offline banner, toasts (bottom, sides) and auth screens.
- **Status bar style: `default`, not `black-translucent`.** `black-translucent` draws the page under the status bar and always uses white status text. The header is a light surface in light theme, so white clock and battery on white would be unreadable. `default` keeps the status bar a solid bar with dark text above the page. Cost: the page does not run under the status bar in standalone on iPhone. Revisit only if the header is made dark in both themes.
- No service worker in this task, so offline launch is TID-023 AC1-3.

## 6. Needs a real iPhone

Add to Home Screen shows the 180 px icon and the name "Tidings"; launches without Safari chrome; stays signed in (AC6); status bar text is legible in light and dark system themes with `default`; nothing sits under the notch or home indicator in portrait and landscape; the toast and bottom bar clear the home indicator.

## 7. iPhone launch images (TID-065)

iOS shows a native launch image the instant the installed app opens, but only if `index.html` has an `apple-touch-startup-image` link whose `media` matches the device's exact width, height, pixel ratio, orientation and colour scheme. Ten portrait iPhone sizes (SE 2/3 to 16/17 Pro Max) are covered, each in light and dark, in `apps/web/public/splash/<w>x<h>-<light|dark>.png` (about 0.5 MB in all).

- Each image is the in-page `#splash` drawn at device pixels: `--c-surface` background, 72 px accent mark, 16 px gap, 24 px semibold `Tidings` in `--c-text`, centred in the standalone page box (below the status bar, above the home-indicator inset).
- In the installed app the splash mark does not fade in (`display-mode: standalone` rule in `index.css`), so the page splash looks identical to the image.
- Wordmark font: the images use Inter (the closest to San Francisco available to the generator); iOS draws the live splash in San Francisco, so letter shapes differ very slightly.
- Not covered: landscape, iPad, and the in-app theme override (the image follows the system theme).

Regenerate after changing the logo, tokens or splash layout:

1. Edit `scripts/splash-config.mjs` (theme colours, device list with status-bar and home-indicator insets).
2. `CHROME_PATH=/usr/bin/google-chrome node scripts/render-splash.mjs` rewrites the PNGs.
3. `node scripts/render-splash.mjs --links` prints the `<link>` tags; paste them into `apps/web/index.html` if the device list changed.
4. `npm test -w @tidings/web` checks every link points at a file of the stated pixel size and that the colours equal the CSS tokens.

Needs a real iPhone: the launch image appears at once (delete and re-add the app to the Home Screen after an update; iOS caches launch images), the hand-off to the page splash shows no jump in the mark or word, and the vertical position matches (the status-bar insets in the config are best-known values).
