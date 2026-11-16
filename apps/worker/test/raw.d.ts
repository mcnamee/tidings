// Vite raw imports, used to load fixture files into workerd tests.
declare module '*?raw' {
  const content: string;
  export default content;
}
