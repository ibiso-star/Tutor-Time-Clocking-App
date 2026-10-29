import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/v1": "http://localhost:3000", "/healthz": "http://localhost:3000" },
  },
});
