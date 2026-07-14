import { api } from "encore.dev/api";

import { ledger } from "../core/ledger";

interface HealthResponse {
  status: "ok";
  app: string;
  ledger: "ok";
}

// GET /health : app liveness + CoreLedger readiness (fails loud if the
// database file/replica is unreachable).
export const health = api(
  { expose: true, method: "GET", path: "/health" },
  async (): Promise<HealthResponse> => {
    await ledger().query("SELECT 1");
    return { status: "ok", app: "enrahitu", ledger: "ok" };
  },
);
