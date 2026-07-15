import { api } from "encore.dev/api";

/**
 * Serves the built SPA (frontend/ builds into ./dist). The /!path catch-all is
 * the lowest priority route in Encore's router, so it yields to /api/*,
 * /auth/* (the rauthy proxy), /health, and /hiq/*. notFound enables SPA
 * history-mode fallback.
 */
export const spa = api.static({
  expose: true,
  path: "/!path",
  dir: "./dist",
  notFound: "./dist/index.html",
});
