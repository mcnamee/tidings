// Vite raw imports, used to load fixture files into workerd tests.
declare module '*?raw' {
  const content: string;
  export default content;
}

// Vite's eager glob import, used by webauthn-import.test.ts to scan the Worker source.
interface ImportMeta {
  glob(
    pattern: string,
    options: { query?: string; import?: string; eager: true },
  ): Record<string, unknown>;
}
