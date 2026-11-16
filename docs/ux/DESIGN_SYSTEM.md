# Tidings design system

Status: designed for TID-006. Owner: UX. Consumers: software engineer (tokens, shell), tester (contrast and tap-target checks).

Principles in one line: calm, content first, thumb friendly, dark mode as its own theme, nothing that needs hover, nothing that needs a third-party request.

Contents

1. Constraints that shape the system
2. Colour tokens (light and dark) and the `index.css` drop-in
3. Contrast ratios (computed)
4. Typography and article reading
5. Spacing, layout constants, tap targets
6. Radii and elevation
7. Motion and `prefers-reduced-motion`
8. Icons
9. Theme behaviour and `theme-init.js`
10. Focus, forced colours and other accessibility rules
11. What the engineer must not do

---

## 1. Constraints that shape the system

| Constraint | Source | Consequence |
|---|---|---|
| `style-src 'self'`, no `'unsafe-inline'` | Spec 10.4 | No `<style>` blocks and no `style="..."` in `index.html` or in server markup. All styling is in the built CSS file. React's `style` prop is allowed because React sets properties through the CSSOM (`el.style.x = ...`), which CSP does not block, but prefer classes. `theme-init.js` must not call `setAttribute('style', ...)`. |
| `font-src 'self'`, no third-party fonts | Spec 10.4, NFR-13 | System font stacks only. No web fonts in MVP (also saves bytes against the 170 KB JS and 30 KB CSS budgets, NFR-3). |
| `img-src 'self' https: data:` | Spec 10.4 | Feed images load directly. Icons are inline SVG components, not images. |
| `script-src 'self'` | Spec 10.4 | `/theme-init.js` is an external, blocking file. No inline scripts. |
| Dark variant keyed on `data-theme` | TID-001 `index.css` | Tokens are CSS variables switched by `[data-theme='dark']`. Keep the existing `@custom-variant dark` line. |
| Initial CSS <= 30 KB gzipped | NFR-3 | Reset the default Tailwind colour palette (below) so unused colours never ship, and keep the token set small. |

---

## 2. Colour tokens

### 2.1 Model

Surfaces form a short ladder. In light mode the page is a warm off-white and cards are white. In dark mode the page is a dark grey (not black) and each step up the ladder is slightly lighter, so depth comes from lightness, not shadows.

| Token | Role |
|---|---|
| `bg` | Page background behind lists and article text |
| `surface` | Header, drawer, sidebar, list rows, cards |
| `raised` | Things floating above a surface: menus, dialogs, bottom sheets |
| `sunken` | Inputs, skeleton blocks, code blocks |
| `border` | Decorative dividers (not relied on to identify a control) |
| `border-strong` | Borders of controls and inputs (3:1 or better) |
| `text`, `text-muted` | Primary and secondary text |
| `accent`, `accent-fg` | Links, unread counts, primary button (`accent` as background, `accent-fg` as label) |
| `accent-subtle`, `on-accent-subtle` | Current navigation item, selected states |
| `danger*`, `warning*`, `success` | Errors and destructive actions; failing feeds and offline; positive confirmation |
| `focus` | Focus ring |
| `toast-*` | Toast surface, text and action |

The dark theme is not an inversion. Notable differences: text is `#dddcd7`, not white (13.4:1 on the page, avoiding glare); accent and status colours are lighter tints with dark label colours on solid buttons; toasts use a lifted grey instead of an inverted light card; shadows are weaker and replaced by a 1px `border`.

### 2.2 The CSS (drop-in)

These two blocks are the single source of truth. `docs/ux/check-contrast.mjs` reads them, so keep the `--c-name: #rrggbb;` format.

```css
:root,
[data-theme='light'] {
  color-scheme: light;
  --c-bg: #f6f5f1;
  --c-surface: #ffffff;
  --c-raised: #ffffff;
  --c-sunken: #ecebe5;
  --c-border: #dad7cf;
  --c-border-strong: #858077;
  --c-text: #1d1c1a;
  --c-text-muted: #5b574f;
  --c-accent: #2750c4;
  --c-accent-fg: #ffffff;
  --c-accent-subtle: #e4eafa;
  --c-on-accent-subtle: #1b3a99;
  --c-danger: #b42318;
  --c-danger-fg: #ffffff;
  --c-danger-subtle: #fce9e7;
  --c-on-danger-subtle: #8e1a11;
  --c-warning: #8a5100;
  --c-warning-subtle: #fbefd5;
  --c-on-warning-subtle: #6b3e00;
  --c-success: #1b6b3a;
  --c-focus: #1a47c0;
  --c-toast-bg: #25241f;
  --c-toast-fg: #f4f3ef;
  --c-toast-action: #a9c2ff;
  --c-scrim: rgb(20 19 17 / 0.45);
  --sh-2: 0 8px 24px rgb(29 28 26 / 0.14), 0 2px 6px rgb(29 28 26 / 0.08);
  --sh-3: 0 16px 40px rgb(29 28 26 / 0.2), 0 4px 10px rgb(29 28 26 / 0.1);
  --img-filter: none;
}
[data-theme='dark'] {
  color-scheme: dark;
  --c-bg: #131417;
  --c-surface: #1b1c20;
  --c-raised: #25262b;
  --c-sunken: #0f1012;
  --c-border: #2e3036;
  --c-border-strong: #7c7f88;
  --c-text: #dddcd7;
  --c-text-muted: #a3a29c;
  --c-accent: #8eaeff;
  --c-accent-fg: #0d1630;
  --c-accent-subtle: #1f2a4a;
  --c-on-accent-subtle: #c3d3ff;
  --c-danger: #f2766b;
  --c-danger-fg: #2a0805;
  --c-danger-subtle: #3a1a18;
  --c-on-danger-subtle: #ffb4ac;
  --c-warning: #e8b04a;
  --c-warning-subtle: #33270f;
  --c-on-warning-subtle: #f5ce80;
  --c-success: #6fcb92;
  --c-focus: #9db8ff;
  --c-toast-bg: #2e3036;
  --c-toast-fg: #e8e7e3;
  --c-toast-action: #9db8ff;
  --c-scrim: rgb(0 0 0 / 0.6);
  --sh-2: 0 8px 24px rgb(0 0 0 / 0.5);
  --sh-3: 0 16px 40px rgb(0 0 0 / 0.6);
  --img-filter: brightness(0.9);
}
```

Notes for the engineer:

- `color-scheme` makes native scrollbars, form controls and the pre-CSS canvas match the theme.
- The scrim is a plain overlay. It is not a text pair, so it has no ratio.
- `--img-filter` dims feed images in dark mode so they don't glare (section 4.5).

### 2.3 Tailwind 4 mapping

Replace the contents of `apps/web/src/index.css` with the following (keeping the `@custom-variant` line as it is). `@theme inline` makes each utility point at the CSS variable, so one class (`bg-surface`) works in both themes with no `dark:` prefix. `dark:` stays available for the rare case that needs it.

```css
@import 'tailwindcss';

@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));

/* Colours: reset Tailwind's palette so only tokens can be used. */
@theme inline {
  --color-*: initial;
  --color-canvas: var(--c-bg);
  --color-surface: var(--c-surface);
  --color-raised: var(--c-raised);
  --color-sunken: var(--c-sunken);
  --color-line: var(--c-border);
  --color-line-strong: var(--c-border-strong);
  --color-fg: var(--c-text);
  --color-fg-muted: var(--c-text-muted);
  --color-accent: var(--c-accent);
  --color-accent-fg: var(--c-accent-fg);
  --color-accent-subtle: var(--c-accent-subtle);
  --color-accent-subtle-fg: var(--c-on-accent-subtle);
  --color-danger: var(--c-danger);
  --color-danger-fg: var(--c-danger-fg);
  --color-danger-subtle: var(--c-danger-subtle);
  --color-danger-subtle-fg: var(--c-on-danger-subtle);
  --color-warning: var(--c-warning);
  --color-warning-subtle: var(--c-warning-subtle);
  --color-warning-subtle-fg: var(--c-on-warning-subtle);
  --color-success: var(--c-success);
  --color-focus: var(--c-focus);
  --color-toast: var(--c-toast-bg);
  --color-toast-fg: var(--c-toast-fg);
  --color-toast-action: var(--c-toast-action);
  --color-scrim: var(--c-scrim);
  --shadow-raised: var(--sh-2);
  --shadow-overlay: var(--sh-3);
}

/* Everything else. */
@theme {
  --font-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
    'Noto Sans', sans-serif;
  --font-serif: ui-serif, 'Iowan Old Style', 'Charter', 'Noto Serif', Georgia, serif;
  --font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;

  --radius-sm: 0.375rem;
  --radius-md: 0.625rem;
  --radius-lg: 1rem;

  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-exit: cubic-bezier(0.4, 0, 1, 1);
  --animate-skeleton: skeleton 1.4s ease-in-out infinite;
  @keyframes skeleton {
    50% {
      opacity: 0.5;
    }
  }
}
```

Token to class cheat sheet:

| Use | Classes |
|---|---|
| Page, header, row, floating | `bg-canvas`, `bg-surface`, `bg-raised`, `bg-sunken` |
| Divider, control border | `border-line`, `border-line-strong` |
| Text | `text-fg`, `text-fg-muted` |
| Link, count | `text-accent` |
| Primary button | `bg-accent text-accent-fg` |
| Current nav item | `bg-accent-subtle text-accent-subtle-fg` |
| Destructive button | `bg-danger text-danger-fg` |
| Error / offline banners | `bg-danger-subtle text-danger-subtle-fg`, `bg-warning-subtle text-warning-subtle-fg` |
| Toast | `bg-toast text-toast-fg`, action `text-toast-action` |
| Backdrop | `bg-scrim` |

Because the Tailwind palette is reset, `bg-white`, `text-gray-500` and the like produce nothing. That is intended: it keeps every colour inside the audited set.

---

## 3. Contrast ratios

Computed with `docs/ux/check-contrast.mjs` (WCAG 2.x relative luminance formula, sRGB, no rounding up). Run `node docs/ux/check-contrast.mjs` from the repo root: it exits 1 if any pair fails. `--write` refreshes the table below after a token change. Targets: 4.5:1 for text, 3:1 for UI components, graphics and focus indicators.

Disabled controls are exempt under WCAG, so a disabled style may use `text-fg-muted` at reduced opacity, but "dimmed" navigation rows (zero unread) are active links and use plain `text-fg-muted`, which passes.

<!-- contrast:begin -->
| Foreground on background | Used for | Needs | Light | Dark |
|---|---|---|---|---|
| `text` on `bg` | Body text on the page | 4.5:1 | 15.61 | 13.41 |
| `text` on `surface` | Body text on cards, header, drawer | 4.5:1 | 17.03 | 12.40 |
| `text` on `raised` | Text in menus and dialogs | 4.5:1 | 17.03 | 11.00 |
| `text` on `sunken` | Text in inputs | 4.5:1 | 14.26 | 13.86 |
| `text-muted` on `bg` | Secondary text, titles of read articles | 4.5:1 | 6.59 | 7.20 |
| `text-muted` on `surface` | Timestamps, dimmed zero-unread rows | 4.5:1 | 7.19 | 6.65 |
| `text-muted` on `raised` | Secondary text in menus and dialogs | 4.5:1 | 7.19 | 5.90 |
| `text-muted` on `sunken` | Placeholder and hint text in inputs | 4.5:1 | 6.02 | 7.44 |
| `accent` on `bg` | Links and text buttons on the page | 4.5:1 | 6.35 | 8.46 |
| `accent` on `surface` | Links, unread counts, text buttons on surfaces | 4.5:1 | 6.93 | 7.82 |
| `accent` on `raised` | Links in menus and dialogs | 4.5:1 | 6.93 | 6.94 |
| `accent-fg` on `accent` | Label on a solid primary button | 4.5:1 | 6.93 | 8.21 |
| `on-accent-subtle` on `accent-subtle` | Current nav item label and count | 4.5:1 | 8.26 | 9.46 |
| `danger` on `bg` | Error text on the page | 4.5:1 | 6.03 | 6.65 |
| `danger` on `surface` | Error text on surfaces | 4.5:1 | 6.57 | 6.14 |
| `danger-fg` on `danger` | Label on a solid destructive button | 4.5:1 | 6.57 | 6.68 |
| `on-danger-subtle` on `danger-subtle` | Error banner text | 4.5:1 | 7.78 | 9.23 |
| `warning` on `bg` | Warning text on the page | 4.5:1 | 5.91 | 9.42 |
| `warning` on `surface` | Failing-feed text on surfaces | 4.5:1 | 6.45 | 8.71 |
| `on-warning-subtle` on `warning-subtle` | Offline and warning banner text | 4.5:1 | 7.95 | 9.75 |
| `success` on `surface` | Success text on surfaces | 4.5:1 | 6.54 | 8.62 |
| `toast-fg` on `toast-bg` | Toast message | 4.5:1 | 14.00 | 10.66 |
| `toast-action` on `toast-bg` | Toast action ("Undo") | 4.5:1 | 8.77 | 6.74 |
| `border-strong` on `bg` | Control and input borders on the page | 3:1 | 3.60 | 4.60 |
| `border-strong` on `surface` | Control and input borders on surfaces | 3:1 | 3.92 | 4.25 |
| `border-strong` on `raised` | Control borders in menus and dialogs | 3:1 | 3.92 | 3.77 |
| `border-strong` on `sunken` | Control borders on sunken fields | 3:1 | 3.29 | 4.76 |
| `accent` on `accent-subtle` | Current-item indicator bar and icon | 3:1 | 5.76 | 6.48 |
| `accent` on `surface` | Unread dot, switch "on" track, progress | 3:1 | 6.93 | 7.82 |
| `focus` on `bg` | Focus ring on the page | 3:1 | 7.11 | 9.41 |
| `focus` on `surface` | Focus ring on surfaces | 3:1 | 7.76 | 8.70 |
| `focus` on `raised` | Focus ring in menus and dialogs | 3:1 | 7.76 | 7.72 |
| `focus` on `sunken` | Focus ring on sunken fields | 3:1 | 6.50 | 9.73 |
| `focus` on `accent-subtle` | Focus ring on the current nav item | 3:1 | 6.45 | 7.21 |
| `danger` on `surface` | Error and destructive icons | 3:1 | 6.57 | 6.14 |
| `warning` on `surface` | Failing-feed warning icon | 3:1 | 6.45 | 8.71 |
| `text-muted` on `surface` | Inactive icons | 3:1 | 7.19 | 6.65 |
<!-- contrast:end -->

Rules that follow from the table:

- Use `text-fg-muted` for secondary text, never a lighter grey. There is no third text level on purpose.
- Never use `accent` for text on `accent-subtle`. Use `accent-subtle-fg`.
- Status is never colour alone: warnings have an icon and words, unread has weight and a dot, current nav item has an indicator bar and `aria-current`.

---

## 4. Typography

### 4.1 Families

System stacks only (CSP, privacy, bundle). UI is sans. Article body is serif (`font-serif`): it reads well in long form and every platform has a decent serif (iOS and macOS Charter or Iowan, Android Noto Serif, Windows Georgia). Titles and all UI stay sans. This is a one-line change (`.article-prose { font-family }`) if the owner dislikes it.

### 4.2 Respecting the user's size

- `html` keeps the browser default (`font-size: 100%`). All sizes are `rem`, so the OS and browser font-size settings and text zoom just work.
- Never use `px` for text, and never set `maximum-scale` or `user-scalable=no`.
- The in-app setting (FR-ST-2, S / M / L) scales article text only, on top of the browser setting.
- Interactive minimum sizes are in `rem` too (`size-11` = 2.75rem = 44px at the default), so they grow with text zoom.
- At 200% text zoom at 375 px there must be no horizontal scroll (NFR-9). Headers and rows wrap or truncate; they never have fixed pixel heights.

### 4.3 UI scale

Uses Tailwind's default scale, which already matches. Roles:

| Role | Class | Size / line height | Weight |
|---|---|---|---|
| Counts, captions | `text-xs` | 12 / 16 | 500 |
| Meta (feed name, time), summary, banners, helper text | `text-sm` | 14 / 20 | 400 |
| Body UI, nav rows, buttons, inputs, toasts | `text-base` | 16 / 24 | 400, 500 for buttons and nav |
| Header title (page `h1`) | `text-lg` | 18 / 28 | 600 |
| Section headings in screens | `text-xl` | 20 / 28 | 600 |
| Article title, mobile | `text-[1.75rem] leading-tight` | 28 / 1.2 | 700 |
| Article title, from 768 px | `md:text-4xl` | 36 / 40 | 700 |

Form inputs are at least 16px, which stops iOS Safari zooming the page on focus.

List row typography (for the article-list screen spec): unread title `text-base font-semibold text-fg`; read title `text-base font-normal text-fg-muted`; both pass AA. Titles clamp to 3 lines, summary to 2.

### 4.4 Article reading typography

Apply to the single component that renders sanitised HTML (`ArticleContent`, spec 10.5). DOMPurify strips `class` and `style`, so all styling is by descendant selectors on a wrapper class. Put this in `index.css`:

```css
:root { --article-size: 1.125rem; }               /* M, the default */
[data-text-size='s'] { --article-size: 1rem; }
[data-text-size='l'] { --article-size: 1.25rem; }

@layer components {
  .article-prose {
    font-family: var(--font-serif);
    font-size: var(--article-size);
    line-height: 1.65;
    max-inline-size: 65ch;            /* ch follows the font size, so the measure holds at S, M, L */
    margin-inline: auto;
    color: var(--c-text);
    overflow-wrap: anywhere;          /* long URLs never push the page sideways */
    hyphens: auto;
    text-wrap: pretty;
  }
  .article-prose > * + * { margin-block-start: 1em; }
  .article-prose h1, .article-prose h2, .article-prose h3,
  .article-prose h4, .article-prose h5, .article-prose h6 {
    font-family: var(--font-sans);
    line-height: 1.25;
    font-weight: 700;
    margin-block-start: 1.75em;
    text-wrap: balance;
  }
  .article-prose h1, .article-prose h2 { font-size: 1.375em; }
  .article-prose h3 { font-size: 1.2em; }
  .article-prose h4, .article-prose h5, .article-prose h6 { font-size: 1em; }
  .article-prose a {
    color: var(--c-accent);
    text-decoration: underline;
    text-underline-offset: 0.2em;
    text-decoration-thickness: 0.08em;
  }
  .article-prose ul, .article-prose ol { padding-inline-start: 1.5em; }
  .article-prose ul { list-style: disc; }
  .article-prose ol { list-style: decimal; }
  .article-prose li + li { margin-block-start: 0.4em; }
  .article-prose blockquote {
    border-inline-start: 3px solid var(--c-border-strong);
    padding-inline-start: 1em;
    color: var(--c-text-muted);
  }
  .article-prose hr { border: 0; border-block-start: 1px solid var(--c-border); margin-block: 2em; }
  .article-prose code, .article-prose kbd, .article-prose pre {
    font-family: var(--font-mono);
    font-size: 0.875em;
    background: var(--c-sunken);
    border-radius: var(--radius-sm);
  }
  .article-prose code, .article-prose kbd { padding: 0.15em 0.35em; }
  .article-prose pre { padding: 0.9em 1em; overflow-x: auto; line-height: 1.5; }
  .article-prose pre code { padding: 0; background: none; }
  .article-prose table {
    display: block;                   /* scroll inside the table, not the page */
    overflow-x: auto;
    border-collapse: collapse;
    font-size: 0.9em;
  }
  .article-prose th, .article-prose td { border: 1px solid var(--c-border-strong); padding: 0.4em 0.6em; }
  .article-prose figure { margin: 0; }
  .article-prose figcaption { font-family: var(--font-sans); font-size: 0.8125em; color: var(--c-text-muted); margin-block-start: 0.5em; }
  .article-prose img, .article-prose video, .article-prose picture {
    display: block;
    max-inline-size: 100%;
    block-size: auto;                 /* images never overflow or distort */
    border-radius: var(--radius-md);
    filter: var(--img-filter);
  }
  .article-prose audio { inline-size: 100%; }
  .article-prose details { border: 1px solid var(--c-border); border-radius: var(--radius-md); padding: 0.5em 0.9em; }
  .article-prose summary { cursor: pointer; font-family: var(--font-sans); min-block-size: 2.75rem; display: flex; align-items: center; }
}
```

Rules behind the numbers:

- Size: S 16, M 18 (default), L 20 px at the default browser size. Line height 1.65. Measure 65 characters, which at 375 px lands near 40 characters per line: acceptable on a phone, and the 16px gutter stays.
- Paragraph spacing is 1em, headings have more space above than below so they attach to what follows.
- Links are underlined as well as coloured (not colour alone).
- Images, video and picture are capped to the column and keep their ratio. Images with no `width`/`height` attributes will shift layout as they load: reserve nothing, but keep `loading="lazy"` (set by the sanitiser hook), and accept this for MVP.
- Tables and `pre` scroll inside themselves.
- Embedded content (iframes) is removed by the sanitiser and replaced by a link, so nothing can glare or overflow.

### 4.5 Dark-mode content rules

- Article text is `#dddcd7` on `#131417`: soft, not pure white on pure black.
- Feed images are dimmed with `filter: brightness(0.9)` in dark mode (the `--img-filter` token). Transparent PNGs with dark ink on a transparent background can vanish on a dark page; rare, accepted in MVP. If it becomes a problem, add a light plate behind images that have transparency (later story).
- `<video>` and `<audio>` use native controls with `color-scheme: dark` inherited, so they match.
- Never put pure `#000` or `#fff` behind long text. The surface ladder starts at `#0f1012`.

---

## 5. Spacing, layout constants, tap targets

Base unit 4px (Tailwind default `--spacing`). Use only these steps for layout: 1 (4), 2 (8), 3 (12), 4 (16), 6 (24), 8 (32), 12 (48).

| Constant | Value | Notes |
|---|---|---|
| Page gutter | `max(1rem, env(safe-area-inset-left))` / right | 16px, grows in landscape with a notch |
| Header height | min 3.5rem (56px) plus `safe-area-inset-top` | `min-h`, never fixed, so it grows with text zoom |
| Bottom bar height | min 3.5rem (56px) plus `safe-area-inset-bottom` | Only rendered when a screen supplies actions |
| Drawer width | `min(86vw, 20rem)` | 320px max; leaves a visible strip of page to tap |
| Sidebar width (>= 1024) | 18rem (288px) | |
| Content column | `max-w-2xl` (42rem, 672px), centred | List and article column on tablet and desktop |
| Row padding | `py-3 px-4` | Article list rows |
| Gap between related controls | 8px | Gap between unrelated groups 16px or more |
| Breakpoints | `md` 768, `lg` 1024 | `lg` is where the sidebar replaces the drawer; nothing else changes at `lg` |

Tap targets:

- Every interactive element has a hit area of at least 44 x 44 px (`min-h-11 min-w-11`). A 24px icon sits inside a 44px button; the padding is part of the button, not a margin.
- Adjacent targets touch or have at least 8px between them. Text links inside article body are exempt (inline), but "Open original" and all chrome are not.
- Primary actions live in the lower half of the screen where the screen allows it (bottom bar, drawer footer).
- Respect safe-area insets (`viewport-fit=cover` in the viewport meta; see app-shell spec).

---

## 6. Radii and elevation

| Token | Value | Use |
|---|---|---|
| `rounded-sm` | 6px | Badges, code, small chips |
| `rounded-md` | 10px | Buttons, inputs, list cards, images, toasts |
| `rounded-lg` | 16px | Bottom sheets and dialogs (top corners on mobile) |
| `rounded-full` | 9999px | Unread dot, pills, avatar-like icon buttons |

Drawer and sidebar edges are square (flush with the screen edge).

Elevation has four levels:

| Level | Light | Dark | Use |
|---|---|---|---|
| 0 | `bg-canvas`, no border | same | Page |
| 1 | `bg-surface`, 1px `border-line` | same, one step lighter | Header, rows, cards, sidebar (separation by border, not shadow) |
| 2 | `bg-raised shadow-raised` | `bg-raised`, 1px `border-line`, weak shadow | Drawer, toasts, menus |
| 3 | `bg-raised shadow-overlay` | same, plus `border-line` | Dialogs, bottom sheets |

In dark mode always add `border border-line` to levels 2 and 3, because shadows barely show on dark grey. Scrim: `bg-scrim`.

---

## 7. Motion

Motion explains where something came from; it is never decoration. Nothing animates on scroll, on load or on theme change.

| Token | Value | Use |
|---|---|---|
| Fast | 120 ms | Press feedback, switch thumb, chevron rotate |
| Base | 200 ms | Drawer slide, backdrop fade, toast in and out, folder expand |
| Easing in | `ease-standard` `cubic-bezier(.2,0,0,1)` | Things appearing |
| Easing out | `ease-exit` `cubic-bezier(.4,0,1,1)` | Things leaving (use 150 ms) |

Specific behaviours:

- Drawer: `translateX(-100%)` to `0`, 200 ms, with the scrim fading 0 to 1. Close is the reverse in 150 ms.
- Toast: slides up 12px and fades in over 200 ms; fades out over 150 ms.
- Skeletons: opacity pulse (`animate-skeleton`), not a travelling shimmer. They are `bg-sunken`.
- Optimistic mark-as-read: the unread dot and title weight change immediately (under 100 ms, NFR-5); no animation is needed or allowed to delay it.
- Colour never transitions when the theme changes (no `transition-colors` on `body`, surfaces or text), so a theme switch is instant and `theme-init` cannot cause a visible fade on load.
- Press state: `active:` darkens the row with `color-mix(in oklab, currentColor 10%, transparent)` overlay. Hover styles are wrapped in `@media (hover: hover)` and are never the only cue.

### 7.1 `prefers-reduced-motion`

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .skeleton { animation: none; opacity: 0.75; }
}
```

- With reduced motion the drawer and toasts appear and disappear instantly (state still changes; only the movement is removed).
- Code must never wait for `transitionend` or `animationend` to unmount a drawer or toast. Use state plus a timer no longer than the duration, so reduced-motion users (and tests) are not stuck.
- Pull-to-refresh uses the same rule: the indicator appears without bounce.

---

## 8. Icons

**Choice: `lucide-react`** (already named in spec 4.5, and I confirm it).

Why:

- **Bundle.** It is ESM with one module per icon, so importing `{ Menu, X }` ships only those icons. Each icon is a few hundred bytes gzipped (my estimate; the engineer should measure). The set below is about 25 icons; budget **10 KB gzipped for all icons** inside the 170 KB initial JS cap. If the measured cost exceeds that, replace the import with local SVG components of the same names rather than dropping icons.
- **CSP.** Icons render as inline `<svg>` elements built by React with presentation attributes (`stroke`, `fill`, `viewBox`), not `style` attributes. There is no icon font (it would need `font-src` and bytes), no external sprite file and no network request. Nothing in the policy needs to change.
- **Consistency.** One 24px grid, 2px rounded stroke, a large catalogue, ISC licence. Stroke icons suit the calm, text-first look.
- **Dark mode.** Icons use `currentColor`, so they follow the text token they sit in, and the contrast pairs for `text-fg-muted`, `accent`, `danger` and `warning` on `surface` already cover them (UI rows in section 3).

Rules:

- Default size 20px inside lists and rows, 24px in the header and bottom bar (`size-5`, `size-6`). Stroke width 1.75 on 20px, 2 on 24px (`strokeWidth` prop).
- Always import by name. Never `import * as` or the dynamic icon component (defeats tree shaking).
- An icon next to a visible label is `aria-hidden="true"`. An icon-only button gets an `aria-label` and the icon is `aria-hidden`. A standalone meaningful icon (the warning marker) gets `role="img"` and an `aria-label`.
- Do not use an icon as the only signal of state. Pair it with text or an accessible name.

Icon inventory for TID-006 and the stories that follow:

| Purpose | lucide name |
|---|---|
| Open navigation | `Menu` |
| Close (drawer, toast, dialogs) | `X` |
| Back | `ArrowLeft` |
| Expand / collapse folder | `ChevronRight` (rotates 90 degrees when open) |
| All articles | `Inbox` |
| Folder | `Folder`, `FolderOpen` |
| Feed | `Rss` |
| Failing feed marker | `TriangleAlert` |
| Add feed | `Plus` |
| Manage | `ListChecks` |
| Settings | `Settings` |
| Mark all as read | `CheckCheck` |
| Refresh | `RefreshCw` |
| Offline | `WifiOff` |
| Open original | `ExternalLink` |
| Undo | `Undo2` |
| Previous / next article | `ChevronLeft`, `ChevronRight` |
| Theme choices (settings) | `Sun`, `Moon`, `Monitor` |
| Info, error banner | `Info`, `CircleAlert` |
| All caught up | `CircleCheck` |
| Mark read / unread | `Circle` (unread) and `CircleCheck` (read) |
| Overflow menu | `Ellipsis` |

---

## 9. Theme behaviour

### 9.1 Contract

| Item | Value |
|---|---|
| Choices | `system` (default), `light`, `dark` |
| Storage key | `localStorage['tidings.theme']`: `'light'` or `'dark'`. For `system` the key is **absent** (removed). Any other value is treated as `system`. |
| Attribute | `<html data-theme="light|dark">` always holds the **resolved** theme. `<html data-theme-pref="system|light|dark">` holds the choice (for the settings control and for tests). |
| When | Set by `/theme-init.js` before first paint. |
| Live system changes | While the choice is `system`, an OS change flips `data-theme` immediately, with no reload (AC3). While the choice is `light` or `dark`, OS changes are ignored. |
| Cross-tab | A `storage` event on the key re-applies the theme in other tabs. |
| Server mirror | Spec FR-ST-1: the server value wins after sign-in. When `['me']` loads, the app writes the server value to `localStorage` (remove for `system`) and dispatches `window.dispatchEvent(new Event('tidings:theme'))`. When the user changes the theme in Settings, the app does the same, then saves to the server. Sign-out keeps the stored value (it is a device preference). |
| `meta theme-color` | One `<meta name="theme-color">` whose `content` the script sets to the header surface: `#ffffff` (light) or `#1b1c20` (dark), so the phone status bar matches the header. Keep these two values equal to `--c-surface`. |
| Text size | `<html data-text-size="s|m|l">`, set by the same script from `localStorage['tidings.textSize']` (`m` is the default and the key is absent for it). Same mirror rule as theme. This avoids an article re-flowing when settings load. |

### 9.2 `public/theme-init.js`

Plain ES5-safe JavaScript, no dependencies, under 1 KB. Loaded as a blocking script (no `defer`, no `async`, not `type=module`).

```js
(function () {
  var KEY = 'tidings.theme';
  var SIZE_KEY = 'tidings.textSize';
  var BAR = { light: '#ffffff', dark: '#1b1c20' }; // keep equal to --c-surface in both themes
  var root = document.documentElement;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function apply() {
    var stored = read(KEY);
    var pref = stored === 'light' || stored === 'dark' ? stored : 'system';
    var theme = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-theme-pref', pref);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BAR[theme]);
    var size = read(SIZE_KEY);
    root.setAttribute('data-text-size', size === 's' || size === 'l' ? size : 'm');
  }

  apply();
  if (mq.addEventListener) mq.addEventListener('change', apply);
  else mq.addListener(apply); // old Safari
  window.addEventListener('storage', function (e) {
    if (e.key === KEY || e.key === SIZE_KEY || e.key === null) apply();
  });
  window.addEventListener('tidings:theme', apply);
})();
```

### 9.3 `index.html` order (matters)

```html
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="light dark" />
<meta name="theme-color" content="#ffffff" />
<script src="/theme-init.js"></script>   <!-- blocking, before any stylesheet -->
<!-- Vite injects the stylesheet link and module script after this -->
```

Why this order: the script must run before the stylesheet is applied, so tokens resolve under the right `data-theme` on first paint. `color-scheme` makes the canvas dark before CSS when the OS is dark, which prevents a white flash on slow loads. The stylesheet is render-blocking, so nothing paints until it arrives. No inline `<style>` is needed.

### 9.4 Checks (maps to TID-006 acceptance criteria)

1. OS dark, no key: `data-theme="dark"` and `data-theme-pref="system"` on `DOMContentLoaded`, and no light frame in a screenshot.
2. Key `light`, OS dark: `data-theme="light"`.
3. Pref `system`, OS flips: `data-theme` follows with no navigation. Pref `dark`, OS flips to light: stays dark.
4. `localStorage` throws (private mode, blocked): falls back to `system`; the app still renders.
5. `meta[name=theme-color]` content equals the surface colour of the resolved theme.

The manifest can carry only one `theme_color` and `background_color`; use the light values (`#ffffff` and `#f6f5f1`). The live meta tag handles the in-app status bar. Dark-mode launch splash on Android may therefore show light for a moment. This is the accepted single-`theme_color` limitation: TID-023 AC4 and FR-PW-1 (accepted by the PM, 2026-11-16). Do not try to work around it (no second manifest, no `media` variants); the icon set and wordmark are designed under TID-023.

---

## 10. Focus, forced colours and other accessibility rules

```css
:focus-visible {
  outline: 2px solid var(--c-focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
:focus:not(:focus-visible) { outline: none; }
@media (forced-colors: active) {
  :focus-visible { outline-color: Highlight; }
}
```

- Focus ring is `outline`, not `box-shadow`, so it survives Windows high-contrast mode. Ratios are in section 3 for every surface it appears on.
- A ring on an element at the edge of its scroll container must not be clipped: use `outline-offset: -2px` for full-width rows and inside clipped containers.
- Skip link is the first focusable element and becomes visible on focus.
- Every screen has exactly one `h1` (the header title), landmarks `header`, `nav`, `main`, and the toast region.
- Hit areas: section 5. Motion: section 7. Text zoom: section 4.2.
- Respect `forced-colors`: borders on buttons and inputs use `border-line-strong` (a real border, not just a background difference).

---

## 11. What the engineer must not do

- No hex values in components. Only token classes. Add a token here first.
- No `dark:` variants for colours that a token already switches.
- No `style="..."` attributes in static HTML and no `<style>` blocks; no inline event handlers.
- No web fonts, no icon fonts, no CDN assets.
- No `transition-colors` on global surfaces.
- No `px` font sizes.
- No `user-scalable=no` or `maximum-scale`.
- Do not use `hover:` as the only way to reveal or trigger anything.
