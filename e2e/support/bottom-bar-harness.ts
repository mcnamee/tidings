// Loaded by the toast spec through the Vite dev server (`/@fs/...`). Test-only: mounts the shell's real
// <BottomBar> into the real #bottom-bar element, because no screen supplies a bar yet.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BottomBar, ShellSlotsContext } from '../../apps/web/src/shell/slots.tsx';

let root: Root | null = null;

export function mountBar(heightPx: number): void {
  const bottomBar = document.getElementById('bottom-bar');
  if (!bottomBar) throw new Error('#bottom-bar not found');
  root ??= createRoot(document.createElement('div'));
  root.render(
    createElement(
      ShellSlotsContext.Provider,
      { value: { headerActions: null, bottomBar } },
      createElement(
        BottomBar,
        null,
        createElement('div', { id: 'tall-bar', style: { height: heightPx } }),
      ),
    ),
  );
}

export function unmountBar(): void {
  root?.unmount();
  root = null;
}
