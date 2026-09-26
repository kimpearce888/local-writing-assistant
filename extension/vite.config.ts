import { defineConfig } from "vite";
import { resolve } from "node:path";
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";

/**
 * Vite config for a Manifest V3 Chrome extension.
 *
 * We use multiple entry points (one per HTML page) and emit a flat JS
 * bundle per content/background script. The public/ folder is copied
 * verbatim (manifest.json, icons, _locales).
 */

function copyPublicDir() {
  return {
    name: "copy-public-dir",
    closeBundle() {
      const publicDir = resolve(__dirname, "public");
      const outDir = resolve(__dirname, "dist");
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

export default defineConfig({
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
        background: resolve(__dirname, "src/background/service-worker.ts"),
        content: resolve(__dirname, "src/content/index.ts"),
        popup: resolve(__dirname, "popup.html"),
        sidepanel: resolve(__dirname, "sidepanel.html"),
        options: resolve(__dirname, "options.html"),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Service worker must be a classic script (MV3), not a module.
          if (chunkInfo.name === "background") return "[name].js";
          return "[name].js";
        },
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  plugins: [copyPublicDir()],
});
