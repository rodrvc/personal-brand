import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Scratch config for QA of the integration branch: same app, side ports.
export default defineConfig({
  plugins: [react()],
  server: { port: 5199, strictPort: true, proxy: { "/api": { target: "http://127.0.0.1:4311", changeOrigin: true } } },
});
