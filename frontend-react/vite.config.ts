import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev: the SPA runs on :5173 and proxies API + IdP traffic to the app on
    // :4000 (npm run dev). Cookies are host-scoped, not port-scoped, so the
    // auth cookies minted on :4000 during the OIDC callback are visible here.
    proxy: {
      "/api": "http://localhost:4000",
      "/auth": "http://localhost:4000",
      "/health": "http://localhost:4000",
      "/hiq": "http://localhost:4000",
    },
  },
  build: {
    // Prod: the bundle lands inside the backend's web service; the single-image
    // build (spec 007) carries backend/web/dist into the container. Identical
    // output target to the Vue flavor, so the artifact is indistinguishable to
    // the server (spec 015 §3).
    outDir: fileURLToPath(new URL("../backend/web/dist", import.meta.url)),
    emptyOutDir: true,
  },
});
