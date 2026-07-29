/**
 * Liveness and readiness are different questions with different consequences
 * for answering "no" (spec 025 §3.3).
 *
 * /health used to do both: it ran SELECT 1 against CoreLedger. Pointed at a
 * Kubernetes livenessProbe, a transient Turso or Postgres blip restarted the
 * pod, and under the die-together entrypoint that restart also ended rauthy,
 * so a dependency wobble became an identity outage. Liveness must therefore
 * touch no dependency at all.
 */
import { api } from "encore.dev/api";

import { ledger } from "../core/ledger";
import { health as hiqHealth } from "../kernel/hiq";

interface LivenessResponse {
  status: "ok";
  app: string;
}

interface ReadinessResponse {
  status: "ok";
  app: string;
  ledger: "ok";
  hiqlite: "ok";
}

/**
 * GET /healthz : is this process alive and serving? No dependency is
 * touched. The livenessProbe and the image HEALTHCHECK target. It fails only
 * when the process cannot answer, and a restart is the correct response.
 */
export const healthz = api(
  { expose: true, method: "GET", path: "/healthz" },
  async (): Promise<LivenessResponse> => {
    return { status: "ok", app: "enrahitu" };
  },
);

/**
 * GET /readyz : should this instance receive traffic? Fails when a
 * dependency is unavailable, and the correct response is to stop routing,
 * not to restart.
 */
export const readyz = api(
  { expose: true, method: "GET", path: "/readyz" },
  async (): Promise<ReadinessResponse> => {
    await ledger().query("SELECT 1");
    await hiqHealth();
    return { status: "ok", app: "enrahitu", ledger: "ok", hiqlite: "ok" };
  },
);

/**
 * GET /health : retained permanently as an alias of /readyz, preserving the
 * exact semantics everything that scrapes it today already depends on (the
 * image smoke, the e2e globalSetup, the compose healthcheck).
 */
export const health = api(
  { expose: true, method: "GET", path: "/health" },
  async (): Promise<ReadinessResponse> => {
    return readyz();
  },
);
