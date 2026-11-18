import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import source from '../public/theme-init.js?raw';
import { installMatchMedia, type FakeMedia } from './test-utils';

const DARK = 'prefers-color-scheme: dark';
const root = document.documentElement;

function run() {
  new Function(source)();
}

describe('theme-init.js', () => {
  let media: FakeMedia;
  let meta: HTMLMetaElement;

  beforeEach(() => {
    localStorage.clear();
    for (const a of ['data-theme', 'data-theme-pref', 'data-text-size']) root.removeAttribute(a);
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#ffffff';
    document.head.append(meta);
  });
  afterEach(() => {
    meta.remove();
    vi.restoreAllMocks();
  });

  it('follows a dark OS when nothing is stored (AC1)', () => {
    media = installMatchMedia({ [DARK]: true });
    run();
    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(root).toHaveAttribute('data-theme-pref', 'system');
    expect(meta.content).toBe('#1b1c20');
  });

  it('follows a light OS when nothing is stored', () => {
    media = installMatchMedia({ [DARK]: false });
    run();
    expect(root).toHaveAttribute('data-theme', 'light');
    expect(meta.content).toBe('#ffffff');
  });

  it('lets a stored override beat the OS (AC2)', () => {
    media = installMatchMedia({ [DARK]: true });
    localStorage.setItem('tidings.theme', 'light');
    run();
    expect(root).toHaveAttribute('data-theme', 'light');
    expect(root).toHaveAttribute('data-theme-pref', 'light');
    expect(meta.content).toBe('#ffffff');
  });

  it('treats any other stored value as system', () => {
    media = installMatchMedia({ [DARK]: true });
    localStorage.setItem('tidings.theme', 'purple');
    run();
    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(root).toHaveAttribute('data-theme-pref', 'system');
  });

  it('follows live OS changes while the choice is system (AC3)', () => {
    media = installMatchMedia({ [DARK]: false });
    run();
    expect(root).toHaveAttribute('data-theme', 'light');
    media.set(DARK, true);
    expect(root).toHaveAttribute('data-theme', 'dark');
    media.set(DARK, false);
    expect(root).toHaveAttribute('data-theme', 'light');
  });

  it('ignores OS changes while the choice is light or dark', () => {
    media = installMatchMedia({ [DARK]: false });
    localStorage.setItem('tidings.theme', 'dark');
    run();
    media.set(DARK, false);
    media.set(DARK, true);
    media.set(DARK, false);
    expect(root).toHaveAttribute('data-theme', 'dark');
  });

  it('re-applies on a storage event (other tab) and on tidings:theme', () => {
    media = installMatchMedia({ [DARK]: false });
    run();
    localStorage.setItem('tidings.theme', 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'tidings.theme' }));
    expect(root).toHaveAttribute('data-theme', 'dark');
    localStorage.removeItem('tidings.theme');
    window.dispatchEvent(new Event('tidings:theme'));
    expect(root).toHaveAttribute('data-theme', 'light');
  });

  it('falls back to system when localStorage throws', () => {
    media = installMatchMedia({ [DARK]: true });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(run).not.toThrow();
    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(root).toHaveAttribute('data-theme-pref', 'system');
    expect(root).toHaveAttribute('data-text-size', 'm');
  });

  it('applies data-text-size, defaulting to m', () => {
    media = installMatchMedia();
    run();
    expect(root).toHaveAttribute('data-text-size', 'm');
    localStorage.setItem('tidings.textSize', 'l');
    window.dispatchEvent(new Event('tidings:theme'));
    expect(root).toHaveAttribute('data-text-size', 'l');
    localStorage.setItem('tidings.textSize', 'xl');
    window.dispatchEvent(new Event('tidings:theme'));
    expect(root).toHaveAttribute('data-text-size', 'm');
  });

  it('is small and ES5-safe in shape', () => {
    // 2000 since TID-059 added the 10 s splash failsafe (still a tiny blocking script).
    expect(source.length).toBeLessThan(2000);
    expect(source).not.toMatch(/=>|\bconst\b|\blet\b|`/);
  });
});
