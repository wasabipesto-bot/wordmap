import { defineConfig } from "vite";

// Relative base so the built site works from any path (e.g. a GitHub Pages project page).
export default defineConfig({
  base: "./",
  build: { chunkSizeWarningLimit: 1500 },
});
