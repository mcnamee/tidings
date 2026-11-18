import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMatchMedia, type FakeMedia } from '../test-utils';
import { isStandalone, useSwipe, type SwipeOptions } from './useSwipe';

// TID-055: the gesture hook, driven with synthetic touch pointer events.

let media: FakeMedia;
beforeEach(() => {
  vi.useFakeTimers();
  media = installMatchMedia();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('swipe-nav');
});

const fire = (
  type: string,
  x: number,
  y = 300,
  over: PointerEventInit & { target?: EventTarget } = {},
) => {
  const { target = document, ...init } = over;
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        bubbles: true,
        ...init,
      }),
    );
  });
};
/** A finger that goes down at x0 and moves to each x in turn, `gap` ms apart, without lifting. */
function drag(x0: number, xs: number[], y = 300, gap = 100) {
  fire('pointerdown', x0, y);
  for (const x of xs) {
    vi.advanceTimersByTime(gap);
    fire('pointermove', x, y);
  }
}

function setup(over: Partial<SwipeOptions> = {}) {
  const spies = {
    onStart: vi.fn(),
    onDrag: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
  };
  function Probe() {
    useSwipe({
      enabled: true,
      direction: 'right',
      edgePx: 24,
      extent: () => 400,
      commitAt: 0.4,
      ...spies,
      ...over,
    });
    return null;
  }
  const view = render(<Probe />);
  return { ...spies, view };
}

describe('useSwipe', () => {
  it('only starts within the edge zone, and ignores mouse and pen', () => {
    const s = setup();
    drag(60, [120, 200, 300]);
    fire('pointerup', 300);
    expect(s.onStart).not.toHaveBeenCalled();

    fire('pointerdown', 10, 300, { pointerType: 'mouse' });
    fire('pointermove', 100, 300, { pointerType: 'mouse' });
    expect(s.onStart).not.toHaveBeenCalled();
  });

  it('follows the finger with progress 0..1 from the point the direction locked', () => {
    const s = setup();
    drag(10, [30, 130, 230]); // locks at x=30; 400 px is 100%
    expect(s.onStart).toHaveBeenCalledTimes(1);
    expect(s.onDrag.mock.calls.map((c) => c[0])).toEqual([0, 0.25, 0.5]);
    fire('pointermove', 5000);
    expect(s.onDrag).toHaveBeenLastCalledWith(1);
  });

  it('commits at the threshold and cancels short of it', () => {
    const s = setup();
    drag(10, [30, 100, 150, 190]); // 160 px = 40%, slow
    vi.advanceTimersByTime(500);
    fire('pointerup', 190);
    expect(s.onCommit).toHaveBeenCalledTimes(1);

    drag(10, [30, 80, 120]); // 90 px = 22%
    vi.advanceTimersByTime(500);
    fire('pointerup', 120);
    expect(s.onCommit).toHaveBeenCalledTimes(1);
    expect(s.onCancel).toHaveBeenCalledTimes(1);
  });

  it('a quick flick commits even when short of the threshold', () => {
    const s = setup();
    drag(10, [30, 60, 90], 300, 20); // 3 px/ms, 60 px = 15%
    fire('pointerup', 90);
    expect(s.onCommit).toHaveBeenCalledTimes(1);
  });

  it('a tiny quick twitch is not a flick', () => {
    const s = setup();
    drag(10, [30, 38], 300, 5);
    fire('pointerup', 38);
    expect(s.onCommit).not.toHaveBeenCalled();
  });

  it('mostly vertical movement is never hijacked', () => {
    const s = setup();
    fire('pointerdown', 10, 300);
    fire('pointermove', 18, 330); // 31 px of movement, mostly down
    fire('pointermove', 200, 340);
    fire('pointerup', 300, 340);
    expect(s.onStart).not.toHaveBeenCalled();
    expect(s.onDrag).not.toHaveBeenCalled();
    expect(s.onCommit).not.toHaveBeenCalled();
    expect(s.onCancel).not.toHaveBeenCalled();
  });

  it('small movement under 10 px waits, and the wrong direction drops the gesture', () => {
    const s = setup();
    fire('pointerdown', 10, 300);
    fire('pointermove', 15, 302);
    expect(s.onStart).not.toHaveBeenCalled();
    fire('pointerup', 15);

    const left = setup({ direction: 'left', edgePx: undefined });
    fire('pointerdown', 200, 300);
    fire('pointermove', 260, 300); // to the right, but this one wants left
    fire('pointermove', 100, 300);
    expect(left.onStart).not.toHaveBeenCalled();
  });

  it('a direction left works and the browser taking the touch (pointercancel) cancels', () => {
    const s = setup({ direction: 'left', edgePx: undefined });
    drag(300, [280, 200, 100]);
    expect(s.onDrag).toHaveBeenLastCalledWith(0.45);
    fire('pointercancel', 100);
    expect(s.onCancel).toHaveBeenCalledTimes(1);
    expect(s.onCommit).not.toHaveBeenCalled();
  });

  it('a second finger ends the gesture', () => {
    const s = setup();
    drag(10, [30, 100]);
    fire('pointerdown', 200, 300, { pointerId: 2, isPrimary: false });
    fire('pointermove', 300);
    fire('pointerup', 300);
    expect(s.onCommit).not.toHaveBeenCalled();
  });

  it('with prefers-reduced-motion nothing follows the finger, but the action still happens', () => {
    media.set('prefers-reduced-motion', true);
    const s = setup();
    drag(10, [30, 100, 150, 190]);
    vi.advanceTimersByTime(500);
    fire('pointerup', 190);
    expect(s.onStart).not.toHaveBeenCalled();
    expect(s.onDrag).not.toHaveBeenCalled();
    expect(s.onCommit).toHaveBeenCalledTimes(1);

    drag(10, [30, 60]);
    vi.advanceTimersByTime(500);
    fire('pointerup', 60);
    expect(s.onCommit).toHaveBeenCalledTimes(1);
    expect(s.onCancel).not.toHaveBeenCalled();
  });

  it('does nothing when disabled, and listens on a given element instead of the document', () => {
    const off = setup({ enabled: false });
    drag(10, [30, 300]);
    fire('pointerup', 300);
    expect(off.onCommit).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveClass('swipe-nav');
    off.view.unmount();

    const el = document.createElement('div');
    document.body.append(el);
    const s = setup({ target: { current: el }, edgePx: undefined });
    drag(10, [30, 300]); // on the document: not heard
    fire('pointerup', 300);
    expect(s.onCommit).not.toHaveBeenCalled();
    fire('pointerdown', 10, 300, { target: el });
    vi.advanceTimersByTime(100);
    fire('pointermove', 30);
    vi.advanceTimersByTime(100);
    fire('pointermove', 300);
    fire('pointerup', 300);
    expect(s.onCommit).toHaveBeenCalledTimes(1);
    el.remove();
  });

  it('marks <html> for touch-action while it listens on the document, and cleans up', () => {
    const s = setup();
    expect(document.documentElement).toHaveClass('swipe-nav');
    s.view.unmount();
    expect(document.documentElement).not.toHaveClass('swipe-nav');
  });
});

describe('isStandalone', () => {
  it('is false in a browser tab, true for display-mode standalone or navigator.standalone', () => {
    expect(isStandalone()).toBe(false);
    media.set('display-mode: standalone', true);
    expect(isStandalone()).toBe(true);
    media.set('display-mode: standalone', false);
    vi.stubGlobal('navigator', { ...navigator, standalone: true });
    expect(isStandalone()).toBe(true);
  });
});
