import { afterEach, describe, expect, it } from 'vitest';
import { installNoPinchZoom } from './noPinchZoom';

let uninstall: (() => void) | undefined;
afterEach(() => uninstall?.());

function touchmove(fingers: number): Event {
  const e = new Event('touchmove', { cancelable: true });
  Object.defineProperty(e, 'touches', { value: { length: fingers } });
  return e;
}

describe('installNoPinchZoom', () => {
  it('cancels WebKit pinch gestures', () => {
    uninstall = installNoPinchZoom();
    for (const type of ['gesturestart', 'gesturechange']) {
      const e = new Event(type, { cancelable: true });
      document.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
    }
  });

  it('cancels a two-finger move but leaves a one-finger scroll alone', () => {
    uninstall = installNoPinchZoom();
    const two = touchmove(2);
    document.dispatchEvent(two);
    expect(two.defaultPrevented).toBe(true);
    const one = touchmove(1);
    document.dispatchEvent(one);
    expect(one.defaultPrevented).toBe(false);
  });

  it('stops cancelling once uninstalled', () => {
    installNoPinchZoom()();
    const e = new Event('gesturestart', { cancelable: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
