import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { port: 5180, proxy: { "/api": "http://localhost:3010" } },
});
