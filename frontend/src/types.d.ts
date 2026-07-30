/// <reference types="vite/client" />

declare module '*?worker' {
  const workerFactory: new () => Worker;
  export default workerFactory;
}

// Vite resolves these to a URL string at build time. Without the declarations
// `svelte-check` reports them as missing modules, and 17 lines of that noise is
// enough to stop anyone reading its output — which is the whole point of having
// it, since it is the only thing that catches a reference to an identifier that
// no longer exists. `vite build` never has.
declare module '*?url' {
  const url: string;
  export default url;
}

declare module '*.woff2?url' {
  const url: string;
  export default url;
}

declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module '*.css';
