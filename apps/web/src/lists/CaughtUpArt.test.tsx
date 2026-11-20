import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CAUGHT_UP_ART, CaughtUpArt, caughtUpSrc } from './CaughtUpArt';

// TID-073: the spot illustrations for the caught-up and empty states.
const PUBLIC = resolve(__dirname, '../../public');

describe('CaughtUpArt', () => {
  it('has a dozen pictures, each with a small light and dark PNG', () => {
    expect(CAUGHT_UP_ART.length).toBeGreaterThanOrEqual(12);
    for (const name of CAUGHT_UP_ART) {
      for (const theme of ['light', 'dark'] as const) {
        const file = resolve(PUBLIC, caughtUpSrc(name, theme).slice(1));
        expect(existsSync(file), file).toBe(true);
        expect(statSync(file).size, file).toBeLessThan(48 * 1024);
      }
    }
  });

  it('renders one decorative lazy picture per theme and keeps it while mounted', () => {
    const { rerender } = render(<CaughtUpArt />);
    const art = screen.getByTestId('caught-up-art');
    const name = art.getAttribute('data-art')!;
    expect(CAUGHT_UP_ART).toContain(name);
    const imgs = art.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    imgs.forEach((i) => {
      expect(i).toHaveAttribute('alt', '');
      expect(i).toHaveAttribute('loading', 'lazy');
    });
    // The theme is chosen by CSS classes only (CSP forbids inline styles).
    expect(imgs[0]).toHaveClass('dark:hidden');
    expect(imgs[1]).toHaveClass('hidden', 'dark:block');
    expect(art.querySelector('[style]')).toBeNull();
    rerender(<CaughtUpArt />);
    expect(screen.getByTestId('caught-up-art').getAttribute('data-art')).toBe(name);
  });

  it('does not show the same picture twice in a row', () => {
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      const { unmount } = render(<CaughtUpArt />);
      seen.push(screen.getByTestId('caught-up-art').getAttribute('data-art')!);
      unmount();
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });
});
