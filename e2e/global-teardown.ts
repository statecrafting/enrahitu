// Playwright globalTeardown (spec 017): stop the dev rauthy after the suite.
//
// Only in CI. Locally the container is left running so repeated `npm run
// test:e2e` reruns reuse the warm rauthy (and its already-provisioned users);
// tear it down by hand with `docker compose -f docker/compose.dev.yml down`.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default async function globalTeardown(): Promise<void> {
  if (!process.env.CI) return;
  // eslint-disable-next-line no-console
  console.log("[e2e] stopping dev rauthy (CI teardown)");
  execSync("docker compose -f docker/compose.dev.yml down", {
    cwd: repoRoot,
    stdio: "inherit",
  });
}
