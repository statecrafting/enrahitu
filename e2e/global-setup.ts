// Playwright globalSetup (spec 017): bring up the dev rauthy and make the OIDC
// client secret available, then wait until rauthy answers, before any test runs.
//
// `npm run dev:idp` = `docker compose -f docker/compose.dev.yml up -d` +
// `node scripts/sync-dev-rauthy-secret.mjs` (writes keys/rauthy-client-secret,
// the dev fallback backend/lib/secrets.ts reads at callback time). Idempotent:
// a warm container and an existing secret file are both fine.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// rauthy's container port (docker/compose.dev.yml maps 127.0.0.1:8081 -> 8080).
// We poll it directly here; the browser only ever sees it through the app's
// same-origin /auth/* proxy on :4000.
const RAUTHY_HEALTH = "http://127.0.0.1:8081/auth/v1/health";

async function waitForRauthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RAUTHY_HEALTH, { signal: AbortSignal.timeout(2000) });
      // Any answer below 500 means the server is up and routing.
      if (res.status < 500) return;
      lastErr = new Error(`rauthy health returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`rauthy did not become ready within ${timeoutMs}ms: ${String(lastErr)}`);
}

export default async function globalSetup(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("[e2e] starting dev rauthy (docker compose) + syncing client secret");
  execSync("npm run dev:idp", { cwd: repoRoot, stdio: "inherit" });
  await waitForRauthy(60_000);
  // eslint-disable-next-line no-console
  console.log("[e2e] rauthy is ready");
}
