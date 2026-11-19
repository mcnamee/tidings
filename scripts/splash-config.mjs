// Shared by scripts/render-splash.mjs and apps/web/src/splash-images.test.ts (TID-065).

/** Surface, text and accent tokens. Must equal --c-surface, --c-text and --c-accent in src/index.css (a test checks). */
export const THEMES = {
  light: { surface: '#ffffff', text: '#1d1c1a', accent: '#2750c4' },
  dark: { surface: '#1b1c20', text: '#dddcd7', accent: '#8eaeff' },
};

/**
 * Portrait iPhone screens: CSS size in points, pixel ratio, and the standalone layout insets.
 * In the installed app (status bar style `default`) the page starts below the status bar (`top`)
 * and keeps the home-indicator inset (`bottom`) as safe-area padding, so the in-page splash is
 * centred in that smaller box. The launch image is full screen, so it applies the same offsets.
 * The insets are the best-known values per device class and need confirming on a real iPhone.
 */
export const DEVICES = [
  { name: '16/17 Pro Max', w: 440, h: 956, ratio: 3, top: 62, bottom: 34 },
  { name: '15/16 Plus, 15 Pro Max, 16 Pro Max', w: 430, h: 932, ratio: 3, top: 59, bottom: 34 },
  { name: '16/17 Pro', w: 402, h: 874, ratio: 3, top: 62, bottom: 34 },
  { name: '14 Pro to 16', w: 393, h: 852, ratio: 3, top: 59, bottom: 34 },
  { name: '12 to 14', w: 390, h: 844, ratio: 3, top: 47, bottom: 34 },
  { name: '12/13 Pro Max, 14 Plus', w: 428, h: 926, ratio: 3, top: 47, bottom: 34 },
  { name: 'X, XS, 11 Pro, 12/13 mini', w: 375, h: 812, ratio: 3, top: 44, bottom: 34 },
  { name: 'XS Max, 11 Pro Max', w: 414, h: 896, ratio: 3, top: 44, bottom: 34 },
  { name: 'XR, 11', w: 414, h: 896, ratio: 2, top: 48, bottom: 34 },
  { name: 'SE 2/3', w: 375, h: 667, ratio: 2, top: 20, bottom: 0 },
];

export const fileFor = (d, scheme) => `splash/${d.w * d.ratio}x${d.h * d.ratio}-${scheme}.png`;

export const mediaFor = (d, scheme) =>
  `(device-width: ${d.w}px) and (device-height: ${d.h}px) and (-webkit-device-pixel-ratio: ${d.ratio}) and (orientation: portrait) and (prefers-color-scheme: ${scheme})`;
