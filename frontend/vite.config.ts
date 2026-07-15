import { fileURLToPath } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  // A project GitHub Pages site serves at /<repo>/, so the SPA must be built
  // with that subpath as its base or every hashed asset 404s (spec 013). The
  // pages.yml workflow sets PAGES_BASE; the container and dev builds leave it
  // unset, so base stays "/". No effect outside a Pages build.
  base: process.env.PAGES_BASE ?? "/",
  plugins: [vue()],
  server: {
    port: 5173,
    // Dev: the SPA runs on :5173 and proxies API + IdP traffic to encore run.
    // (Cookies are host-scoped, not port-scoped, so the auth cookies minted
    // on :4000 during the OIDC callback are visible here too.)
    proxy: {
      "/api": "http://localhost:4000",
      "/auth": "http://localhost:4000",
      "/health": "http://localhost:4000",
      "/hiq": "http://localhost:4000",
    },
  },
  build: {
    // Prod: the bundle lands inside the backend's web service; encore build
    // docker carries it into the single image.
    outDir: fileURLToPath(new URL("../backend/web/dist", import.meta.url)),
    emptyOutDir: true,
  },
});
