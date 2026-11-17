import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout: scrolling is a no-op there.
window.scrollTo = () => undefined;

afterEach(() => cleanup());
