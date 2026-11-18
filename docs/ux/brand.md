# Tidings brand: mark, wordmark, icons, install

Story: TID-057 (owner request 2026-11-18), with TID-023 AC4 and AC6. Preview: `docs/ux/brand-preview.png`.

## 1. The mark

A bold, lowercase-feeling "T" built from two thick pill strokes that lean in opposite directions, so the crossbar rises to the right like a flag on a pole while the stem leans forward like a person walking into the news. Original construction, on a 64-unit grid (the file's `viewBox` is cropped to `4 4 56 56` so the mark fills it).

| Part | Construction |
|---|---|
| Unit | `r = 8` grid units. Stroke width `2r = 16`. Every end is a full semicircle of radius `r` (rx = r on a 2r-thick bar), so there are no sharp corners at any size. |
| Crossbar | Rounded rectangle 48 x 16 (6r x 2r), centred on (32, 20), rotated **-12 degrees** (rises to the right). |
| Stem | Rounded rectangle 16 x 43 (2r x about 5.4r), top-centre on (32, 20), rotated **+14 degrees** about the crossbar centre (leans right at the top). |
| Joint | The two shapes overlap into one solid fill. The notch where the stem meets the bar is left to the overlap, not drawn. |
| Fill | One shape, `currentColor`. No outline, no gradient, no second colour. |

Why two angles: -12 and +14 are close enough to read as one gesture, and far enough apart that the glyph is unmistakably a T and not a rotated one. Optical balance, not arithmetic, set the 2-degree difference.

Clear space: at least `r` (one eighth of the mark's width) on every side. Smallest size: 16 px (favicon). Below 16 px use the favicon, never the bare mark.

Files:

- `apps/web/public/logo.svg`: mark only, `fill="currentColor"`, so it takes the surrounding text colour.
- `apps/web/src/shell/Logo.tsx`: `LogoMark` (inline SVG, decorative) and `Lockup`. A unit test keeps the shapes equal to `logo.svg`.

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
