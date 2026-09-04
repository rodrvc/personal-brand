import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api to the local editor-server (design.md D1: chrome
// and API stay separate processes; this is what lets `fetch("/api/...")`
// work identically in dev and in a future built bundle served by the same
// origin as the API).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4310",
        changeOrigin: true,
      },
    },
  },
});
