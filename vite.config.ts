import { defineConfig } from "vite";
import { resolve } from "node:path";

const root = __dirname;

export default defineConfig({
  root,
  base: "/",
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(root, "index.html"),
        "pdf-extractor": resolve(root, "pdf-extractor/index.html"),
        "key-converter": resolve(root, "key-converter/index.html"),
      },
    },
  },
});
