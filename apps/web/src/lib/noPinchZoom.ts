/**
 * No pinch or double-tap zoom, like a native app (owner request 2026-11-23). iOS Safari ignores
 * `user-scalable=no` and `maximum-scale`, and axe flags them, so the viewport tag stays as it is.
 * Instead: `touch-action: pan-x pan-y` on <html> (index.css) stops pinch and double-tap zoom where
 * it is honoured, and here WebKit's `gesture*` events and any multi-finger `touchmove` are
 * cancelled. Text size stays adjustable through the OS setting and the in-app S / M / L setting.
 */
export function installNoPinchZoom(target: Document = document): () => void {
  const stop = (e: Event): void => {
    e.preventDefault();
  };
  const multiTouch = (e: TouchEvent): void => {
    if (e.touches.length > 1) e.preventDefault();
  };
  const opts = { passive: false } as const;
  target.addEventListener('gesturestart', stop, opts);
  target.addEventListener('gesturechange', stop, opts);
  target.addEventListener('touchmove', multiTouch, opts);
  return () => {
    target.removeEventListener('gesturestart', stop);
    target.removeEventListener('gesturechange', stop);
    target.removeEventListener('touchmove', multiTouch);
  };
}
