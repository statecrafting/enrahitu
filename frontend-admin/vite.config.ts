import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard serves under /admin (spec 023): base and router basename
// agree. Dev mode proxies the app so the same-origin posture holds at 5174.
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      "/api": "http://localhost:4000",
      "/auth": "http://localhost:4000",
      "/metrics": "http://localhost:4000",
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../backend/web/dist-admin", import.meta.url)),
    emptyOutDir: true,
  },
});
