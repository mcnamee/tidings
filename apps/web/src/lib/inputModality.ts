/**
 * Focus rings only for keyboard use (TID-069). iOS and Android show a ring on whatever a tap or a
 * script focused (the screen title, the Menu button). Instead <html data-input="keyboard"> is set
 * by a navigation key and cleared by any pointer or touch, and index.css scopes the ring to it.
 */
const KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  ' ',
  'Escape',
]);

const POINTER_EVENTS = ['pointerdown', 'mousedown', 'touchstart'];

export function installInputModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  const keyboard = (e: Event) => {
    const { key, ctrlKey, metaKey, altKey } = e as KeyboardEvent;
    if (KEYS.has(key) && !ctrlKey && !metaKey && !altKey) root.dataset.input = 'keyboard';
  };
  const pointer = () => {
    delete root.dataset.input;
  };
  doc.addEventListener('keydown', keyboard, true);
  for (const type of POINTER_EVENTS) {
    doc.addEventListener(type, pointer, { capture: true, passive: true });
  }
  return () => {
    doc.removeEventListener('keydown', keyboard, true);
    for (const type of POINTER_EVENTS) doc.removeEventListener(type, pointer, true);
    delete root.dataset.input;
  };
}
