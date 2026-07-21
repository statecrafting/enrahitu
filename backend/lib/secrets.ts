/**
 * Secret declarations. Values are provided by Encore's secret store in
 * deployed environments (or bound via env in the self-host container). In
 * local development secret() returns an empty string when unset, so the JWT
 * keys fall back to the PEM files written by `npm run generate-keys`
 * (keys/ is gitignored and absent from deployments).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { secret } from "encore.dev/config";

import { demand } from "../kernel/adjudicate";

const jwtPrivateKey = secret("JWT_PRIVATE_KEY");
const jwtPublicKey = secret("JWT_PUBLIC_KEY");
const jwtRefreshPrivateKey = secret("JWT_REFRESH_PRIVATE_KEY");
const jwtRefreshPublicKey = secret("JWT_REFRESH_PUBLIC_KEY");

// Driver secrets (read directly where needed).
const rauthyClientSecret = secret("RAUTHY_CLIENT_SECRET");

/**
 * The rauthy OIDC client secret: the Encore secret in deployed environments,
 * falling back in dev to keys/rauthy-client-secret (written by
 * `npm run dev:idp-secret` from the committed dev bootstrap client).
 */
export function rauthyClientSecretValue(): string {
  demand("secret.read", "rauthy_client_secret");
  return withDevFileFallback(rauthyClientSecret(), "rauthy-client-secret");
}

// NOT import.meta.url-relative: encore run executes the bundled app from
// .encore/build/combined/, so module-relative paths escape the repo. The dev
// keys live at <repo>/keys and encore run keeps cwd at the app root.
const keysDir = process.env.ENRAHITU_KEYS_DIR ?? join(process.cwd(), "keys");

function withDevFileFallback(value: string, pemFile: string): string {
  if (value && value.trim().length > 0) return value;
  try {
    return readFileSync(join(keysDir, pemFile), "utf8");
  } catch {
    return "";
  }
}

// Every accessor adjudicates secret.read of its specific secret before
// releasing material (spec 021 §3.5); model resource names are the
// lowercase form of the encore binding.
export function accessPrivateKey(): string {
  demand("secret.read", "jwt_private_key");
  return withDevFileFallback(jwtPrivateKey(), "access-private.pem");
}
export function accessPublicKey(): string {
  demand("secret.read", "jwt_public_key");
  return withDevFileFallback(jwtPublicKey(), "access-public.pem");
}
export function refreshPrivateKey(): string {
  demand("secret.read", "jwt_refresh_private_key");
  return withDevFileFallback(jwtRefreshPrivateKey(), "refresh-private.pem");
}
export function refreshPublicKey(): string {
  demand("secret.read", "jwt_refresh_public_key");
  return withDevFileFallback(jwtRefreshPublicKey(), "refresh-public.pem");
}
