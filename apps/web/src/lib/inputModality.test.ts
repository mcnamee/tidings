import { afterEach, describe, expect, it } from 'vitest';
import { installInputModality } from './inputModality';

let uninstall: (() => void) | null = null;
afterEach(() => uninstall?.());

const key = (k: string, init: KeyboardEventInit = {}) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));

describe('input modality (TID-069)', () => {
  it('is keyboard after a navigation key and cleared by a pointer or touch', () => {
    uninstall = installInputModality();
    expect(document.documentElement.dataset.input).toBeUndefined();
    key('Tab');
    expect(document.documentElement.dataset.input).toBe('keyboard');
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.documentElement.dataset.input).toBeUndefined();
    key('ArrowDown');
    expect(document.documentElement.dataset.input).toBe('keyboard');
    document.dispatchEvent(new Event('touchstart', { bubbles: true }));
    expect(document.documentElement.dataset.input).toBeUndefined();
  });

  it('ignores typing and shortcuts, and stops when uninstalled', () => {
    uninstall = installInputModality();
    key('a');
    key('c', { metaKey: true });
    key('Tab', { ctrlKey: true });
    expect(document.documentElement.dataset.input).toBeUndefined();
    uninstall();
    uninstall = null;
    key('Tab');
    expect(document.documentElement.dataset.input).toBeUndefined();
  });
});
