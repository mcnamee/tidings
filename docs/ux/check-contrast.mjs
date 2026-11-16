#!/usr/bin/env node
// Computes WCAG 2.x contrast ratios for the colour tokens in DESIGN_SYSTEM.md.
//
//   node docs/ux/check-contrast.mjs            print the table; exit 1 if any pair fails
//   node docs/ux/check-contrast.mjs --write    refresh the table inside DESIGN_SYSTEM.md
//   node docs/ux/check-contrast.mjs <file>     read tokens from another file
//
// Tokens are read from the `--c-*: #rrggbb;` lines in the light block (selector
// starts with `:root` or `[data-theme='light']`) and the dark block (selector
// starts with `[data-theme='dark']`). Change a token in the doc, re-run, done.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const write = args.includes('--write');
const file = args.find((a) => !a.startsWith('--')) ?? join(here, 'DESIGN_SYSTEM.md');
const src = readFileSync(file, 'utf8');

const themes = { light: {}, dark: {} };
let cur = null;
for (const line of src.split('\n')) {
  if (/^\s*(:root|\[data-theme=['"]?light)/.test(line)) cur = 'light';
  else if (/^\s*\[data-theme=['"]?dark/.test(line)) cur = 'dark';
  else if (/^\s*\}/.test(line)) cur = null;
  const m = cur && line.match(/^\s*--c-([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/);
  if (m) themes[cur][m[1]] = m[2];
}

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground, background, minimum ratio, usage]
const T = 4.5; // text
const U = 3; // UI component or graphic
const pairs = [
  ['text', 'bg', T, 'Body text on the page'],
  ['text', 'surface', T, 'Body text on cards, header, drawer'],
  ['text', 'raised', T, 'Text in menus and dialogs'],
  ['text', 'sunken', T, 'Text in inputs'],
  ['text-muted', 'bg', T, 'Secondary text, titles of read articles'],
  ['text-muted', 'surface', T, 'Timestamps, dimmed zero-unread rows'],
  ['text-muted', 'raised', T, 'Secondary text in menus and dialogs'],
  ['text-muted', 'sunken', T, 'Placeholder and hint text in inputs'],
  ['accent', 'bg', T, 'Links and text buttons on the page'],
  ['accent', 'surface', T, 'Links, unread counts, text buttons on surfaces'],
  ['accent', 'raised', T, 'Links in menus and dialogs'],
  ['accent-fg', 'accent', T, 'Label on a solid primary button'],
  ['on-accent-subtle', 'accent-subtle', T, 'Current nav item label and count'],
  ['danger', 'bg', T, 'Error text on the page'],
  ['danger', 'surface', T, 'Error text on surfaces'],
  ['danger-fg', 'danger', T, 'Label on a solid destructive button'],
  ['on-danger-subtle', 'danger-subtle', T, 'Error banner text'],
  ['warning', 'bg', T, 'Warning text on the page'],
  ['warning', 'surface', T, 'Failing-feed text on surfaces'],
  ['on-warning-subtle', 'warning-subtle', T, 'Offline and warning banner text'],
  ['success', 'surface', T, 'Success text on surfaces'],
  ['toast-fg', 'toast-bg', T, 'Toast message'],
  ['toast-action', 'toast-bg', T, 'Toast action ("Undo")'],
  ['border-strong', 'bg', U, 'Control and input borders on the page'],
  ['border-strong', 'surface', U, 'Control and input borders on surfaces'],
  ['border-strong', 'raised', U, 'Control borders in menus and dialogs'],
  ['border-strong', 'sunken', U, 'Control borders on sunken fields'],
  ['accent', 'accent-subtle', U, 'Current-item indicator bar and icon'],
  ['accent', 'surface', U, 'Unread dot, switch "on" track, progress'],
  ['focus', 'bg', U, 'Focus ring on the page'],
  ['focus', 'surface', U, 'Focus ring on surfaces'],
  ['focus', 'raised', U, 'Focus ring in menus and dialogs'],
  ['focus', 'sunken', U, 'Focus ring on sunken fields'],
  ['focus', 'accent-subtle', U, 'Focus ring on the current nav item'],
  ['danger', 'surface', U, 'Error and destructive icons'],
  ['warning', 'surface', U, 'Failing-feed warning icon'],
  ['text-muted', 'surface', U, 'Inactive icons'],
];

let fail = 0;
const rows = pairs.map(([fg, bg, min, use]) => {
  const cells = ['light', 'dark'].map((t) => {
    const f = themes[t][fg];
    const b = themes[t][bg];
    if (!f || !b) throw new Error(`Missing token ${fg} or ${bg} in ${t}`);
    const r = ratio(f, b);
    const ok = r >= min;
    if (!ok) fail++;
    return `${r.toFixed(2)}${ok ? '' : ' FAIL'}`;
  });
  return `| \`${fg}\` on \`${bg}\` | ${use} | ${min}:1 | ${cells[0]} | ${cells[1]} |`;
});
const table = [
  '| Foreground on background | Used for | Needs | Light | Dark |',
  '|---|---|---|---|---|',
  ...rows,
].join('\n');

if (write) {
  const re = /(<!-- contrast:begin -->)[\s\S]*?(<!-- contrast:end -->)/;
  if (!re.test(src)) throw new Error('contrast markers not found in ' + file);
  writeFileSync(file, src.replace(re, (_, a, b) => `${a}\n${table}\n${b}`));
} else {
  console.log(table);
}
console.error(fail ? `${fail} check(s) FAIL` : `All ${pairs.length * 2} checks pass`);
process.exit(fail ? 1 : 0);
