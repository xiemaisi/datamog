import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the SPA from the repo subpath, so a production build in
  // CI needs that base for its asset URLs. The dev server always serves from the
  // root: the e2e suite drives it by absolute path (`/embed-demo.html`), which a
  // based dev server answers with a 404.
  base: command === "build" && process.env.GITHUB_ACTIONS ? "/datamog/" : "/",
  plugins: [preact()],
  server: {
    // Bind to all interfaces so the dev server is reachable from the host
    // when running inside a container. On a regular host, localhost still
    // works as before.
    host: true,
  },
  worker: {
    format: "es",
  },
  build: {
    rollupOptions: {
      // Multi-page: the SPA plus the generated embed tutorial (built by
      // `tutorial:html` into the package root before the Vite build). The
      // tutorial page bundles `src/embed/index.ts`, so the embed ships as a
      // hashed asset and the page is deployable to GitHub Pages.
      input: {
        main: resolve(here, "index.html"),
        tutorial: resolve(here, "tutorial.html"),
      },
    },
  },
}));
