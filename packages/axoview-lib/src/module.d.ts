declare module '*.svg' {
  const content: React.FunctionComponent<React.SVGAttributes<SVGElement>>;
  export default content;
}

// Side-effect CSS imports (bundled by rslib). TypeScript 6 checks side-effect
// imports by default (noUncheckedSideEffectImports), so they need a declaration.
declare module '*.css';
