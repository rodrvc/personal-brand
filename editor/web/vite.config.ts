import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api to the local editor-server (design.md D1: chrome
// and API stay separate processes; this is what lets `fetch("/api/...")`
// work identically in dev and in a future built bundle served by the same
// origin as the API).
export default defineConfig({
  plugins: [react()],
  server: {
    // EDITOR_WEB_PORT lets a second instance (e.g. bucket mode, issue #115)
    // run beside the default one without a port clash.
    port: Number(process.env.EDITOR_WEB_PORT) || 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.EDITOR_PORT ?? 4310}`,
        changeOrigin: true,
      },
    },
  },
});
