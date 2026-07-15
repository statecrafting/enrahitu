// Playwright config for the spec 017 browser-real login e2e.
//
// This suite is deliberately OUT of the default verify verb (vitest); it runs
// on its own via `npm run test:e2e` and the e2e.yml workflow (dispatch +
// nightly). It boots the app on :4000 (webServer below) and the dev rauthy
// (globalSetup: docker compose + client-secret sync, spec 005), then drives a
// real password login through a real browser engine.
//
// Prerequisites (documented at length in login.rauthy.spec.ts):
//   npm run build:runtime && npm run build:addon && npm run build:app
//   npx playwright install chromium
//   docker available (globalSetup runs `npm run dev:idp`)
//
// retries: 0 on purpose (spec 017 section 3): a flake must fail loudly, never
// be masked by a silent retry.
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The app origin the browser is confined to. rauthy is reached only through
// the same-origin /auth/* proxy (spec 005), so the browser never leaves this.
const APP_ORIGIN = "http://localhost:4000";

// rauthy configuration for the app under test. Passed to the spawned
// `npm run dev` so the rauthy driver is enabled (the SPA's "Sign in with
// rauthy" link is rendered only when GET /api/v1/auth/status reports it). The
// client secret is NOT here: it lands in keys/rauthy-client-secret via
// globalSetup and is read lazily at callback time (backend/lib/secrets.ts).
const rauthyEnv: Record<string, string> = {
  AUTH_DRIVER: "rauthy",
  // Trailing slash is REQUIRED: rauthy 0.36.0 advertises its issuer as
  // http://localhost:4000/auth/v1/ and openid-client v6 validates the
  // discovery document's issuer field exactly. Without it, getConfig() throws
  // and rauthyLogin returns 500.
  RAUTHY_ISSUER: `${APP_ORIGIN}/auth/v1/`,
  RAUTHY_CLIENT_ID: "enrahitu",
  RAUTHY_REDIRECT_URI: `${APP_ORIGIN}/api/v1/auth/rauthy/callback`,
  RAUTHY_SCOPES: "openid profile email groups",
  RAUTHY_DEFAULT_ROLE: "user",
  FRONTEND_URL: APP_ORIGIN,
};

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: "./artifacts/test-results",
  // One test, one worker: the round-trip mutates a shared session; parallelism
  // buys nothing and only risks cross-talk.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"], ["html", { outputFolder: "./artifacts/report", open: "never" }]],
  // Bring up dev rauthy (compose + secret sync) before any test; tear it down
  // after (in CI only, so local reruns reuse the warm container).
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: {
    baseURL: APP_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Boot the app itself. globalSetup handles rauthy; the lazy secret read means
  // app-boot order relative to the secret write does not matter.
  webServer: {
    command: "npm run dev",
    cwd: repoRoot,
    url: `${APP_ORIGIN}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    // Spread process.env explicitly: the app child only enables the rauthy
    // driver when these reach it (backend/lib/env.ts reads process.env), and a
    // bare env object would drop the inherited PATH/HOME the dev runner needs.
    env: { ...process.env, ...rauthyEnv },
  },
});
