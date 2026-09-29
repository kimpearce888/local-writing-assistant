import { defineConfig } from "vite";
import { resolve } from "node:path";
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";

/**
 * Vite config for a Manifest V3 Chrome extension.
 *
 * We use multiple entry points (one per HTML page) and emit a flat JS
 * bundle per content/background script. The public/ folder is copied
 * verbatim (manifest.json, icons, _locales).
 *
 * IMPORTANT: Chrome MV3 content scripts run as classic scripts — they
 * CANNOT use ES module imports. We therefore build the content script
 * as an IIFE bundle (inline everything, no chunks/). The service worker
 * IS allowed to use ES modules (manifest declares it as type:"module"),
 * so it uses the default module output.
 *
 * To achieve both in one project, we use Vite's `build.lib` mode for
 * the content script via a second build pass. The main `vite build` run
 * produces the HTML pages + service worker; `vite build --mode content`
 * (see scripts/build-content.mjs) produces the IIFE content.js.
 */

function copyPublicDir() {
  return {
    name: "copy-public-dir",
    closeBundle() {
      const publicDir = resolve(import.meta.dirname, "public");
      const outDir = resolve(import.meta.dirname, "dist");
      if (!existsSync(publicDir)) return;
      copyRecursive(publicDir, outDir);
    },
  };
}

function copyRecursive(src: string, dest: string): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = resolve(src, entry);
    const destPath = resolve(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

export default defineConfig(({ mode }) => {
  // Two build modes:
  //   - default mode (production): builds the HTML pages + service worker.
  //     The service worker CAN be an ES module (manifest declares
  //     type:"module"), so it uses the default module output with chunks/.
  //   - "content" mode: builds the content script as an IIFE bundle.
  //     MV3 content scripts run as classic scripts, NOT modules — they
  //     cannot use ES module imports. We use Vite's library mode + IIFE
  //     format to produce a single self-contained content.js.
  if (mode === "content") {
    return {
      base: "./",
      mode: "production",
      build: {
        outDir: "dist",
        emptyOutDir: false, // don't wipe the SW + HTML outputs from the first pass
        target: "es2022",
        modulePreload: false,
        sourcemap: false,
        minify: "esbuild",
        lib: {
          entry: resolve(import.meta.dirname, "src/content/index.ts"),
          name: "LocalWritingAssistantContent",
          formats: ["iife"],
          fileName: () => "content.js",
        },
        rollupOptions: {
          output: {
            entryFileNames: "content.js",
            assetFileNames: "assets/[name][extname]",
          },
        },
      },
      plugins: [],
    };
  }

  return {
    base: "./",
    mode: "production",
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "es2022",
      modulePreload: false,
      sourcemap: false,
      minify: "esbuild",
      rollupOptions: {
        input: {
          // Service worker — emitted as ES module (manifest declares type:"module").
          background: resolve(import.meta.dirname, "src/background/service-worker.ts"),
          // HTML pages.
          popup: resolve(import.meta.dirname, "popup.html"),
          sidepanel: resolve(import.meta.dirname, "sidepanel.html"),
          options: resolve(import.meta.dirname, "options.html"),
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name][extname]",
        },
      },
    },
    plugins: [copyPublicDir()],
  };
});

